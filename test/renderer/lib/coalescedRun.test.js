// Goal: src/lib/coalescedRun.ts keeps its one promise — a request is answered by a
// run that began no earlier than the request — with one run in flight and at
// most one waiting, so a burst of any size costs at most two runs. It replaced
// the rescan chain and the panels' drain loops (plan §11.9), which followed
// newer requests in a loop capped by rescanChainMax and saveDrainMax.
// Method: runs are deferred promises the test settles by hand, so every
// interleaving below is explicit; no timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { createCoalescedRun } = load('src/lib/coalescedRun.ts');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferredRuns() {
  const runs = [];
  const coalesced = createCoalescedRun(() => new Promise((resolve, reject) => runs.push({ resolve, reject })));
  return { runs, coalesced };
}

test('an idle request starts one run and gets its answer', async () => {
  const { runs, coalesced } = deferredRuns();
  const answer = coalesced.request();
  await tick();
  assert.equal(runs.length, 1);
  assert.equal(coalesced.superseded(), false, 'nothing waits behind a lone run');
  runs[0].resolve('first');
  assert.equal(await answer, 'first');
});

test('a burst during a run shares the one run after it', async () => {
  const { runs, coalesced } = deferredRuns();
  const first = coalesced.request();
  await tick();
  const second = coalesced.request();
  for (let index = 0; index < 100; index++) {
    assert.equal(coalesced.request(), second, 'every request meanwhile joins the waiting run');
  }
  assert.notEqual(second, first, 'a request never takes the answer of a run begun before it');
  assert.equal(runs.length, 1, 'the waiting run starts only after the running one ends');
  assert.equal(coalesced.superseded(), true, 'the running run knows a newer one waits');
  runs[0].resolve('before');
  assert.equal(await first, 'before');
  await tick();
  assert.equal(runs.length, 2);
  runs[1].resolve('after');
  assert.equal(await second, 'after');
  await tick();
  assert.equal(runs.length, 2, 'nothing waits, so nothing more runs');
  assert.equal(coalesced.superseded(), false);
});

test('a failed run rejects its own callers and leaves the next run usable', async () => {
  const { runs, coalesced } = deferredRuns();
  const failing = coalesced.request();
  await tick();
  const next = coalesced.request();
  runs[0].reject(new Error('disk unavailable'));
  await assert.rejects(failing, /disk unavailable/);
  await tick();
  runs[1].resolve('recovered');
  assert.equal(await next, 'recovered');
  const later = coalesced.request();
  await tick();
  runs[2].resolve('again');
  assert.equal(await later, 'again');
});

test('a run that throws synchronously is a rejected answer, not a crash', async () => {
  const coalesced = createCoalescedRun(() => {
    throw new Error('thrown before a promise');
  });
  await assert.rejects(coalesced.request(), /thrown before a promise/);
  await assert.rejects(coalesced.request(), /thrown before a promise/);
});
