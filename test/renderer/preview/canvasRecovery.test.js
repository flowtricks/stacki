// Goal: the canvas comes back from an error page without the person pressing Reload canvas
// (src/features/preview/canvasRecovery.ts, docs/canvas-recovery.md), and does so with bounded work:
// one check in flight, a stated polling schedule, a window after which it stops, no timer left behind.
//
// Method: the real controller under a fake clock and a fake dev server whose answers the test scripts.
// Time moves only when the test advances it, so the schedule is asserted exactly (400, 800, 1600, 3000,
// then every 5 s, for 120 s) instead of "eventually". Every wait is on the clock, never a real sleep. The
// same controller runs against a real Astro dev server in test/integration/canvasRecovery.js.
// The dev server's error overlay over a page that loaded (`overlayShown`, a frame error) is checked separately:
// a check of the page cannot see it, so only a change looks again, and one good look reloads the canvas once.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadRenderer = require('../../helpers/rendererModule.js');

const { CANVAS_POLL_DELAYS_MS, CANVAS_RECOVERY_LIMITS, canvasErrorOf, createCanvasRecovery, isCurrentPageFailure, overlayErrorOf, pollDelayMs } =
  loadRenderer('src/features/preview/canvasRecovery.ts');

const PAGE_URL = 'http://127.0.0.1:4321/about';
const ok = () => ({ kind: 'ok', status: 200, thrown: undefined, logTail: '' });
const bad = (thrown = 'TypeError: getCollection is not a function\n  at index.astro:3') => ({ kind: 'error-overlay', status: 500, thrown, logTail: '' });

// A clock and a scripted dev server. `answers` is what each inspect returns, in order; the last repeats.
function world({ visible = true } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  const state = { visible, inspects: [], inFlight: 0, maxInFlight: 0, reloads: 0, events: [], answers: [ok()], pending: undefined };
  const environment = {
    pageUrl: () => PAGE_URL,
    inspect: async (url) => {
      state.inspects.push({ url, at: now });
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.pending !== undefined) {
          return await state.pending.promise;
        }
        if (state.reject) {
          throw new Error('ipc closed');
        }
        return state.answers.length > 1 ? state.answers.shift() : state.answers[0];
      } finally {
        state.inFlight -= 1;
      }
    },
    reload: () => {
      state.reloads += 1;
    },
    visible: () => state.visible,
    onEvent: (event) => state.events.push(event),
    timers: {
      setTimeout: (callback, delayMs) => {
        const id = nextId++;
        timers.set(id, { at: now + delayMs, callback });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      now: () => now,
    },
  };
  const settle = async () => {
    for (let index = 0; index < 20; index++) {
      await Promise.resolve();
    }
  };
  // Runs every timer due within `ms`, in time order, letting promises settle between them.
  const advance = async (ms) => {
    const end = now + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      await settle();
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) {
        break;
      }
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].callback();
    }
    now = end;
    await settle();
  };
  const recovery = createCanvasRecovery(environment);
  return { recovery, state, advance, pendingTimers: () => timers.size, at: () => now, settle };
}

const kinds = (events) => events.map((event) => event.kind);

test('the poll schedule is 400, 800, 1600, 3000 ms and then steady', () => {
  assert.deepEqual([...CANVAS_POLL_DELAYS_MS], [400, 800, 1600, 3000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(pollDelayMs), [400, 800, 1600, 3000, 5000, 5000, 5000]);
  assert.throws(() => pollDelayMs(-1), /not negative/);
  assert.throws(() => pollDelayMs(1.5), /integer/);
  assert.throws(() => pollDelayMs(Number.NaN), /integer/);
});

test('a verdict is an error unless the page can be shown; the same error has the same fingerprint', () => {
  assert.equal(canvasErrorOf(ok(), PAGE_URL), undefined);
  const first = canvasErrorOf(bad('A\nb\nc\nd'), PAGE_URL);
  assert.equal(first.message, 'A · b · c');
  assert.equal(first.url, PAGE_URL);
  assert.equal(
    canvasErrorOf(bad('A\nother frame'), PAGE_URL).fingerprint,
    canvasErrorOf(bad('A\nb'), PAGE_URL).fingerprint,
    'only the first line identifies it',
  );
  assert.notEqual(canvasErrorOf(bad('B'), PAGE_URL).fingerprint, first.fingerprint);
  assert.notEqual(
    canvasErrorOf({ ...bad('A'), kind: 'server-error' }, PAGE_URL).fingerprint,
    canvasErrorOf(bad('A'), PAGE_URL).fingerprint,
    'the kind is part of it',
  );
  assert.equal(canvasErrorOf({ kind: 'unreachable', status: 0, thrown: undefined, logTail: '' }, PAGE_URL).message, undefined);
  const long = canvasErrorOf(bad('x'.repeat(5000)), PAGE_URL).message;
  assert.equal(long.length, CANVAS_RECOVERY_LIMITS.messageCharsMax);
  assert.equal(long.endsWith('…'), true);
});

test('a failed navigation is the page on show when only the query, the hash or a slash differ', () => {
  const page = 'http://127.0.0.1:4321/blog/post';
  assert.equal(isCurrentPageFailure('http://127.0.0.1:4321/blog/post', page), true);
  assert.equal(isCurrentPageFailure('http://127.0.0.1:4321/blog/post/', page), true);
  assert.equal(isCurrentPageFailure('http://127.0.0.1:4321/blog/post?loop=items:none', page), true);
  assert.equal(isCurrentPageFailure('http://127.0.0.1:4321/blog/post#avb-design', page), true);
  assert.equal(isCurrentPageFailure('http://127.0.0.1:4321/__avb/preview?defaults=6f9619ff-8b86-d011-b42d-00c04fc964ff', page), true);
  assert.equal(isCurrentPageFailure('http://127.0.0.1:4321/blog/other', page), false, 'another page is not interrupted');
  assert.equal(isCurrentPageFailure('http://127.0.0.1:9999/blog/post', page), false, 'another server is not either');
  assert.equal(isCurrentPageFailure('http://127.0.0.1:4321/blog/post', undefined), false);
  assert.equal(isCurrentPageFailure('nonsense', page), false);
});

test('a healthy canvas is checked once per burst of writes, not reloaded, and not told anything', async () => {
  const scene = world();
  for (let index = 0; index < 8; index++) {
    scene.recovery.trigger('write');
    await scene.advance(20);
  }
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 50);
  assert.equal(scene.state.inspects.length, 1, 'asking costs a page: one check, not one per write');
  assert.equal(scene.state.reloads, 0);
  assert.deepEqual(scene.state.events, []);
  assert.equal(scene.recovery.state().kind, 'healthy');
  scene.recovery.trigger('write');
  await scene.advance(CANVAS_RECOVERY_LIMITS.quietMs + CANVAS_RECOVERY_LIMITS.settleMs);
  assert.equal(scene.state.inspects.length, 2, 'and again once the quiet spell is over');
  scene.recovery.stop();
  assert.equal(scene.pendingTimers(), 0);
});

test('an error the canvas reports is polled on the schedule and the page comes back with one reload', async () => {
  const scene = world();
  scene.state.answers = [bad(), bad(), bad(), bad(), ok()];
  scene.recovery.failed(PAGE_URL);
  assert.equal(scene.recovery.state().kind, 'error');
  await scene.advance(1);
  assert.equal(scene.state.inspects.length, 1, 'the first look is immediate: it names the error');
  const first = scene.state.inspects[0].at;
  await scene.advance(10_000);
  const gaps = scene.state.inspects.slice(1).map((entry, index) => entry.at - scene.state.inspects[index].at);
  assert.deepEqual(gaps.slice(0, 4), [400, 800, 1600, 3000], 'the first four waits are the schedule');
  assert.equal(scene.state.inspects.length, 5);
  assert.equal(scene.state.reloads, 1, 'reloaded once, when a check first says the page can be shown');
  assert.equal(scene.recovery.state().kind, 'recovering');
  assert.deepEqual(kinds(scene.state.events), ['failed', 'recovered']);
  assert.equal(scene.state.events[0].error.message, 'TypeError: getCollection is not a function · at index.astro:3');
  assert.ok(first > 0);
  scene.recovery.loaded();
  assert.equal(scene.recovery.state().kind, 'healthy');
  await scene.advance(30_000);
  assert.equal(scene.state.inspects.length, 5, 'nothing is asked once the page is back');
  assert.equal(scene.pendingTimers(), 0);
});

test('the same error says nothing again; a different one updates the notice once', async () => {
  const scene = world();
  scene.state.answers = [bad('Error A'), bad('Error A'), bad('Error A'), bad('Error B'), bad('Error B')];
  scene.recovery.failed(PAGE_URL);
  await scene.advance(20_000);
  const failed = scene.state.events.filter((event) => event.kind === 'failed');
  assert.deepEqual(
    failed.map((event) => event.error.message),
    ['Error A', 'Error B'],
    'one event per distinct error, however many polls saw it',
  );
  assert.equal(scene.state.reloads, 0);
  assert.equal(scene.recovery.state().kind, 'error');
  scene.recovery.stop();
});

test('a persistent error is polled for two minutes, then left until something changes', async () => {
  const scene = world();
  scene.state.answers = [bad()];
  scene.recovery.failed(PAGE_URL);
  await scene.advance(CANVAS_RECOVERY_LIMITS.pollWindowMs + 60_000);
  const count = scene.state.inspects.length;
  // 1 + 4 quick polls (5.8 s), then one every 5 s until 120 s.
  const expected = 1 + CANVAS_POLL_DELAYS_MS.length + Math.floor((CANVAS_RECOVERY_LIMITS.pollWindowMs - 5_800) / CANVAS_RECOVERY_LIMITS.pollSteadyMs);
  assert.ok(Math.abs(count - expected) <= 2, `polled ${count} times, expected about ${expected}`);
  assert.equal(scene.pendingTimers(), 0, 'no timer is left running: nothing leaks');
  assert.deepEqual(kinds(scene.state.events), ['failed', 'gave-up']);
  assert.equal(scene.recovery.state().polling.kind, 'exhausted');
  assert.equal(scene.state.reloads, 0, 'and the page was never reloaded: no flicker');
  await scene.advance(600_000);
  assert.equal(scene.state.inspects.length, count, 'ten more minutes ask nothing');
  // Anything that could have fixed it starts it again, with a fresh window.
  scene.state.answers = [ok()];
  scene.recovery.trigger('external');
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 10);
  assert.equal(scene.state.reloads, 1, 'an outside change after the polling stopped still brings the page back');
  scene.recovery.stop();
});

test('a change while the error shows restarts the quick polls', async () => {
  const scene = world();
  scene.state.answers = [bad()];
  scene.recovery.failed(PAGE_URL);
  await scene.advance(60_000);
  const before = scene.state.inspects.length;
  scene.recovery.trigger('write');
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 1);
  assert.equal(scene.state.inspects.length, before + 1, 'asked soon after the write');
  assert.equal(scene.recovery.state().polling.kind === 'waiting' && scene.recovery.state().polling.attempt, 1, 'and the schedule starts over');
  scene.recovery.stop();
});

test('only one check is in flight; a change during it is asked about right after', async () => {
  const scene = world();
  let release;
  scene.state.pending = { promise: new Promise((resolve) => (release = resolve)) };
  scene.recovery.failed(PAGE_URL);
  await scene.advance(1);
  assert.equal(scene.state.inspects.length, 1);
  scene.recovery.trigger('write');
  scene.recovery.trigger('external');
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 10);
  assert.equal(scene.state.inspects.length, 1, 'no second request while one is waiting');
  scene.state.pending = undefined;
  release(bad());
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 10);
  assert.ok(scene.state.inspects.length >= 2, 'the latest change is looked at afterwards');
  assert.equal(scene.state.maxInFlight, 1);
  scene.recovery.stop();
});

test('a hidden window polls on a slow tick and looks at once when it comes back', async () => {
  const scene = world({ visible: false });
  scene.state.answers = [bad()];
  scene.recovery.failed(PAGE_URL);
  await scene.advance(CANVAS_RECOVERY_LIMITS.hiddenTickMs - 1);
  assert.equal(scene.state.inspects.length, 0, 'nothing is asked while hidden, before the slow tick');
  await scene.advance(2);
  assert.equal(scene.state.inspects.length, 1);
  await scene.advance(CANVAS_RECOVERY_LIMITS.hiddenTickMs * 3);
  assert.ok(scene.state.inspects.length <= 5, `hidden polling stays slow (${scene.state.inspects.length})`);
  scene.state.answers = [ok()];
  scene.state.visible = true;
  scene.recovery.visibilityChanged();
  await scene.advance(5);
  assert.equal(scene.state.reloads, 1, 'coming back to the front checks immediately and recovers');
  scene.recovery.stop();
});

test('a healthy canvas in a hidden window asks nothing', async () => {
  const scene = world({ visible: false });
  scene.recovery.trigger('write');
  await scene.advance(10_000);
  assert.equal(scene.state.inspects.length, 0);
  scene.state.visible = true;
  scene.recovery.visibilityChanged();
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 10);
  assert.equal(scene.state.inspects.length, 1, 'one look when it returns');
  scene.recovery.stop();
});

test('a dev server still compiling after a write is working, not a new error', async () => {
  const scene = world();
  const gone = { kind: 'unreachable', status: 0, thrown: undefined, logTail: '' };
  scene.state.answers = [gone, { kind: 'server-error', status: 500, thrown: undefined, logTail: '' }, ok()];
  scene.recovery.trigger('write');
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 1);
  assert.equal(scene.recovery.state().kind, 'healthy', 'a refused connection right after a write is not an error');
  await scene.advance(CANVAS_RECOVERY_LIMITS.graceRecheckMs * 3);
  assert.equal(scene.recovery.state().kind, 'healthy');
  assert.deepEqual(scene.state.events, [], 'and nobody is told');
  assert.equal(scene.state.reloads, 0);
  scene.recovery.stop();
});

test('an error with words from the dev server is real at once, grace or not; a transient one that lasts becomes one', async () => {
  const real = world();
  real.state.answers = [bad()];
  real.recovery.trigger('write');
  await real.advance(CANVAS_RECOVERY_LIMITS.settleMs + 1);
  assert.equal(real.recovery.state().kind, 'error');
  assert.deepEqual(kinds(real.state.events), ['failed']);
  real.recovery.stop();

  const slow = world();
  slow.state.answers = [{ kind: 'unreachable', status: 0, thrown: undefined, logTail: '' }];
  slow.recovery.trigger('restart');
  await slow.advance(CANVAS_RECOVERY_LIMITS.graceMs + 2_000);
  assert.equal(slow.recovery.state().kind, 'error', 'a server that stays gone is an error once the grace is over');
  slow.recovery.stop();
});

test('a check that cannot be made reads as an unreachable server', async () => {
  const scene = world();
  scene.state.reject = true;
  scene.recovery.failed(PAGE_URL);
  await scene.advance(2_000);
  assert.equal(scene.recovery.state().kind, 'error');
  assert.ok(scene.state.inspects.length >= 2, 'it keeps trying');
  scene.state.reject = false;
  scene.state.answers = [ok()];
  await scene.advance(6_000);
  assert.equal(scene.state.reloads, 1);
  scene.recovery.stop();
});

test('a page the check likes and the canvas keeps failing stops reloading after a few turns', async () => {
  const scene = world();
  scene.state.answers = [ok()];
  for (let turn = 0; turn < CANVAS_RECOVERY_LIMITS.flapsMax + 2; turn++) {
    scene.recovery.failed(PAGE_URL);
    await scene.advance(3_000);
    if (scene.recovery.state().kind === 'recovering') {
      // The new document fails again, as a frame URL the check does not request would.
      continue;
    }
  }
  assert.ok(scene.state.reloads <= CANVAS_RECOVERY_LIMITS.flapsMax, `${scene.state.reloads} reloads: bounded, no flashing loop`);
  assert.equal(scene.recovery.state().polling.kind, 'exhausted');
  assert.ok(kinds(scene.state.events).includes('gave-up'));
  scene.recovery.stop();
});

test('a reload that never reports loading is forgotten, and a change during it is looked at afterwards', async () => {
  const scene = world();
  scene.state.answers = [bad(), ok()];
  scene.recovery.failed(PAGE_URL);
  await scene.advance(2_000);
  assert.equal(scene.recovery.state().kind, 'recovering');
  scene.recovery.trigger('write');
  await scene.advance(CANVAS_RECOVERY_LIMITS.recoveringMsMax + 1);
  assert.equal(scene.recovery.state().kind, 'healthy');
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + CANVAS_RECOVERY_LIMITS.quietMs + 10);
  assert.ok(scene.state.inspects.length >= 3, 'the change made during the reload was checked');
  scene.recovery.stop();
});

test('another page, or stopping, forgets the error and cancels everything', async () => {
  const scene = world();
  scene.state.answers = [bad()];
  scene.recovery.failed(PAGE_URL);
  await scene.advance(1_000);
  scene.recovery.pageChanged();
  assert.equal(scene.recovery.state().kind, 'healthy');
  assert.equal(scene.pendingTimers(), 0);
  assert.deepEqual(kinds(scene.state.events), ['failed', 'left']);
  const asked = scene.state.inspects.length;
  await scene.advance(30_000);
  assert.equal(scene.state.inspects.length, asked, 'the old page is not polled');

  // A check in flight when the page changes does not decide anything for the new page.
  const late = world();
  let release;
  late.state.pending = { promise: new Promise((resolve) => (release = resolve)) };
  late.recovery.failed(PAGE_URL);
  await late.advance(1);
  late.recovery.pageChanged();
  release(ok());
  await late.advance(1_000);
  assert.equal(late.state.reloads, 0, 'a late answer about the old page reloads nothing');

  const stopped = world();
  stopped.recovery.failed(PAGE_URL);
  stopped.recovery.stop();
  stopped.recovery.trigger('write');
  stopped.recovery.failed(PAGE_URL);
  await stopped.advance(30_000);
  assert.equal(stopped.state.inspects.length, 0);
  assert.equal(stopped.pendingTimers(), 0);
});

const OVERLAY = 'No Astro CSS at index 0\nAn error occurred.';

test('an overlay is a frame error: bounded words, the first line names it', () => {
  const error = overlayErrorOf(PAGE_URL, OVERLAY);
  assert.equal(error.origin, 'frame');
  assert.equal(error.kind, 'error-overlay');
  assert.equal(error.message, 'No Astro CSS at index 0 · An error occurred.');
  assert.equal(error.url, PAGE_URL);
  assert.notEqual(overlayErrorOf(PAGE_URL, 'Other').fingerprint, error.fingerprint);
  assert.equal(overlayErrorOf(PAGE_URL, undefined).message, undefined);
  assert.equal(overlayErrorOf(PAGE_URL, 'x'.repeat(5000)).message.length, CANVAS_RECOVERY_LIMITS.messageCharsMax);
  assert.equal(canvasErrorOf(bad(), PAGE_URL).origin, 'response');
});

test('an overlay waits for a change, then one good look reloads the canvas once', async () => {
  const scene = world();
  scene.state.answers = [ok()];
  scene.recovery.overlayShown(PAGE_URL, OVERLAY);
  assert.equal(scene.recovery.state().kind, 'error');
  assert.deepEqual(kinds(scene.state.events), ['failed']);
  assert.equal(scene.state.events[0].error.message, 'No Astro CSS at index 0 · An error occurred.');
  // Nothing that could have fixed it: no check, which would see a 200 and "recover" into the same overlay.
  scene.recovery.trigger('focus');
  scene.recovery.trigger('load');
  scene.recovery.visibilityChanged();
  await scene.advance(130_000);
  assert.equal(scene.state.inspects.length, 0, 'no polling: a check cannot see an overlay');
  assert.equal(scene.state.reloads, 0);
  // The person's next edit, or the watcher's outside change: the dev server compiled the page; look once.
  scene.recovery.trigger('write');
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 10);
  assert.equal(scene.state.inspects.length, 1);
  assert.equal(scene.state.reloads, 1, 'exactly one reload');
  assert.deepEqual(kinds(scene.state.events), ['failed', 'recovered']);
  assert.equal(scene.recovery.state().kind, 'recovering');
  scene.recovery.loaded();
  assert.equal(scene.recovery.state().kind, 'healthy', 'the reloaded page has no overlay');
  await scene.advance(30_000);
  assert.equal(scene.state.reloads, 1);
  scene.recovery.stop();
  assert.equal(scene.pendingTimers(), 0);
});

test('an overlay the dev server closes itself needs no reload', async () => {
  const scene = world();
  scene.recovery.overlayShown(PAGE_URL, OVERLAY);
  scene.recovery.overlayShown(PAGE_URL, OVERLAY);
  assert.deepEqual(kinds(scene.state.events), ['failed'], 'the same overlay says nothing again');
  scene.recovery.overlayShown(PAGE_URL, 'Another error');
  assert.deepEqual(kinds(scene.state.events), ['failed', 'failed'], 'a different one replaces the notice');
  scene.recovery.overlayCleared();
  assert.equal(scene.recovery.state().kind, 'healthy');
  assert.deepEqual(kinds(scene.state.events), ['failed', 'failed', 'recovered']);
  scene.recovery.overlayCleared();
  assert.equal(kinds(scene.state.events).length, 3, 'a second clear is nothing');
  await scene.advance(10_000);
  assert.equal(scene.state.reloads, 0);
  scene.recovery.stop();
});

test('an overlay that keeps coming back after its reloads stops the reloading at the cap', async () => {
  const scene = world();
  scene.state.answers = [ok()];
  for (let turn = 0; turn < CANVAS_RECOVERY_LIMITS.flapsMax + 3; turn++) {
    scene.recovery.overlayShown(PAGE_URL, OVERLAY);
    scene.recovery.trigger('write');
    await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 10);
    if (scene.recovery.state().kind === 'recovering') {
      scene.recovery.loaded(); // The reloaded page loads, and its overlay comes back on the next turn.
    }
  }
  assert.equal(scene.state.reloads, CANVAS_RECOVERY_LIMITS.flapsMax, 'the cap holds');
  assert.equal(scene.recovery.state().kind, 'error');
  assert.equal(scene.recovery.state().polling.kind, 'exhausted');
  assert.ok(kinds(scene.state.events).includes('gave-up'));
  scene.recovery.stop();
});

test('a page that stops answering while an overlay shows becomes an error a check can poll', async () => {
  const scene = world();
  scene.state.answers = [bad(), bad(), ok()];
  scene.recovery.overlayShown(PAGE_URL, OVERLAY);
  scene.recovery.failed(PAGE_URL);
  assert.equal(scene.recovery.state().error.origin, 'response');
  await scene.advance(2_000);
  assert.equal(scene.state.inspects.length, 3, 'polled on the schedule, as any response error');
  assert.equal(scene.state.reloads, 1);
  scene.recovery.stop();
});

test('a write that finds the page failing turns the overlay into a polled response error', async () => {
  const scene = world();
  scene.state.answers = [bad(), ok()];
  scene.recovery.overlayShown(PAGE_URL, OVERLAY);
  scene.recovery.trigger('write');
  await scene.advance(CANVAS_RECOVERY_LIMITS.settleMs + 10);
  assert.equal(scene.recovery.state().kind, 'error');
  assert.equal(scene.recovery.state().error.origin, 'response');
  await scene.advance(CANVAS_POLL_DELAYS_MS[0] + 10);
  assert.equal(scene.state.reloads, 1, 'the next poll found it fixed');
  scene.recovery.stop();
});
