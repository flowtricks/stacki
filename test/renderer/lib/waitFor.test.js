// Goal: the shared bounded wait (test/helpers/waitFor.js) that renderer and Electron
// tests use in place of fixed sleeps returns as soon as the awaited state holds, never
// polls past its bound, reports the last observed state when it gives up, and refuses
// options that would make it unbounded or its failure message useless.
// Method: synchronous and asynchronous reads over a counter, with small bounds and a
// 1 ms interval so the file runs in milliseconds; failure messages are pinned.

const test = require('node:test');
const assert = require('node:assert/strict');
const { MOTION_SETTLED_EXPRESSION, WAIT_LIMITS, pollUntil, waitFor } = require('../../helpers/waitFor.js');

const counter = () => {
  let count = 0;
  return () => {
    count += 1;
    return count;
  };
};

test('pollUntil returns at the first poll that holds, with the polls it took', async () => {
  const read = counter();
  const outcome = await pollUntil({ what: 'three', read, until: (value) => value === 3, pollIntervalMs: 1 });
  assert.deepEqual(outcome, { kind: 'reached', value: 3, pollCount: 3 });
});

test('pollUntil awaits an asynchronous read, as an executeJavaScript round trip is', async () => {
  const read = counter();
  const outcome = await pollUntil({ what: 'two', read: async () => read(), until: (value) => value === 2, pollIntervalMs: 1 });
  assert.equal(outcome.kind, 'reached');
  assert.equal(outcome.value, 2);
});

test('pollUntil stops at its bound and keeps the last value it saw', async () => {
  const read = counter();
  const outcome = await pollUntil({ what: 'never', read, until: () => false, pollCountMax: 4, pollIntervalMs: 1 });
  assert.deepEqual(outcome, { kind: 'timedOut', value: 4, pollCount: 4 });
});

test('a state that holds on the last allowed poll is reached, not timed out', async () => {
  const read = counter();
  const outcome = await pollUntil({ what: 'the last', read, until: (value) => value === 4, pollCountMax: 4, pollIntervalMs: 1 });
  assert.equal(outcome.kind, 'reached');
});

test('waitFor returns the value, or throws naming what it waited for and what it saw', async () => {
  assert.equal(await waitFor({ what: 'one', read: () => 1, until: (value) => value === 1 }), 1);
  await assert.rejects(waitFor({ what: 'the menu open', read: () => ({ rows: 0 }), until: () => false, pollCountMax: 2, pollIntervalMs: 1 }), {
    message: 'waitFor: the menu open did not hold after 2 polls (~2 ms); last observed: {"rows":0}',
  });
});

test('options that would leave a wait unbounded or unexplained are refused', async () => {
  await assert.rejects(waitFor({ read: () => 1, until: () => true }), {
    message: 'Assertion failed: waitFor needs `what`, the state it waits for, for its failure message',
  });
  await assert.rejects(pollUntil({ what: 'x', until: () => true }), { message: 'Assertion failed: waitFor(x) needs a `read` function' });
  await assert.rejects(pollUntil({ what: 'x', read: () => 1 }), { message: 'Assertion failed: waitFor(x) needs an `until` predicate' });
  await assert.rejects(pollUntil({ what: 'x', read: () => 1, until: () => true, pollCountMax: Infinity }), {
    message: 'Assertion failed: waitFor(x) pollCountMax must be a positive integer',
  });
  await assert.rejects(pollUntil({ what: 'x', read: () => 1, until: () => true, pollIntervalMs: 0 }), {
    message: 'Assertion failed: waitFor(x) pollIntervalMs must be a positive integer',
  });
});

test('the default bound is stated and finite', () => {
  assert.ok(Number.isSafeInteger(WAIT_LIMITS.pollCountMax));
  assert.ok(WAIT_LIMITS.pollCountMax * WAIT_LIMITS.pollIntervalMs <= 10_000, 'a default wait ends within ten seconds');
  assert.ok(MOTION_SETTLED_EXPRESSION.includes('data-popup-phase'), 'the motion check covers a popup opening');
});
