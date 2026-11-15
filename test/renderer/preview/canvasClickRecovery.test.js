// Goal: a click on the canvas never ends in an error for a cause the canvas can
// recover from (docs/canvas-click.md). Every reason the preview-token gate can
// refuse a click for has a step on the recovery ladder, the ladder is bounded
// in attempts, time and reloads, a newer click replaces an older one still
// being retried, and a notice is raised only when nothing else applies — once,
// not on every click, and taken down as soon as a click selects again.
// Methodology: the planner and the notice gate are pure and are checked over
// every reason and every frame render problem. The controller runs with a fake
// clock and a fake frame. A seeded randomized run then drives it through clicks
// that land while the canvas re-renders, frames that answer late or never, and
// renders that arrive in any order, and holds the invariant after each run:
// every click ends exactly once, a click whose canvas catches up within the
// window always selects, and no notice is raised for those.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/canvas-click-recovery');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export * from './src/features/preview/canvasClickRecovery.ts';",
      "export * from './src/features/preview/canvasClickRetry.ts';",
      "export * from './src/features/preview/canvasClickLog.ts';",
      "export { PREVIEW_STALE_REASONS, FRAME_RENDER_PROBLEMS } from './shared/page/previewToken.ts';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: path.join(directory, 'recovery.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const recovery = require(path.join(directory, 'recovery.js'));
const {
  CANVAS_CLICK_LIMITS,
  CANVAS_CLICK_LOG_ENTRIES_MAX,
  CanvasClickRetry,
  CanvasNoticeGate,
  FRAME_RENDER_PROBLEMS,
  PREVIEW_STALE_REASONS,
  canvasClickEntries,
  canvasClickLogText,
  canvasClickProblemCode,
  clearCanvasClickLog,
  planCanvasClickRecovery,
  planCanvasEventRefusal,
  recordCanvasClick,
} = recovery;

const FRESH = { attempt: 0, elapsedMs: 0, reloads: 0 };
const SPENT = { attempt: CANVAS_CLICK_LIMITS.attemptsMax, elapsedMs: 0, reloads: 0 };
const SPENT_AND_RELOADED = { attempt: CANVAS_CLICK_LIMITS.attemptsMax, elapsedMs: 0, reloads: CANVAS_CLICK_LIMITS.reloadsPerDocumentMax };
// The open page, unless a file (or undefined) is named: a default parameter would also replace an explicit undefined.
const stale = (reason, ...file) => ({ kind: 'stale', reason, file: file.length === 0 ? 'src/pages/index.astro' : file[0] });

test('every stale reason has a step, and only the open file being elsewhere selects the page', () => {
  for (const reason of PREVIEW_STALE_REASONS) {
    const first = planCanvasClickRecovery(stale(reason), FRESH, undefined);
    if (reason === 'unstamped-file') {
      assert.deepEqual(first, { kind: 'select-page', notice: { kind: 'other-page', file: 'src/pages/index.astro' } });
      continue;
    }
    assert.equal(first.kind, 'retry', `${reason} is retried first`);
    assert.equal(first.delayMs, CANVAS_CLICK_LIMITS.retryDelaysMs[0]);
    const exhausted = planCanvasClickRecovery(stale(reason), SPENT, undefined);
    const last = planCanvasClickRecovery(stale(reason), SPENT_AND_RELOADED, undefined);
    if (reason === 'shown-page-differs') {
      assert.deepEqual(exhausted, { kind: 'give-up', notice: { kind: 'out-of-step' } }, 'a reload cannot render unsaved edits');
    } else {
      assert.deepEqual(exhausted, { kind: 'reload-canvas' }, `${reason} reloads once retries run out`);
    }
    assert.deepEqual(last, { kind: 'give-up', notice: { kind: 'out-of-step' } }, `${reason} says so only after its reload`);
  }
  assert.deepEqual(planCanvasClickRecovery(stale('unstamped-file', undefined), FRESH, undefined), {
    kind: 'select-page',
    notice: { kind: 'out-of-step' },
  });
});

test('the window bounds retries in time as well as in attempts', () => {
  const late = { attempt: 1, elapsedMs: CANVAS_CLICK_LIMITS.retryWindowMs, reloads: 0 };
  assert.deepEqual(planCanvasClickRecovery(stale('superseded'), late, undefined), { kind: 'reload-canvas' });
  for (let attempt = 0; attempt < CANVAS_CLICK_LIMITS.attemptsMax; attempt++) {
    const step = planCanvasClickRecovery(stale('file-changed'), { attempt, elapsedMs: 0, reloads: 0 }, undefined);
    assert.equal(step.kind, 'retry');
    assert.ok(step.delayMs > 0, 'every look waits a moment');
  }
  const last = planCanvasClickRecovery(stale('file-changed'), { attempt: CANVAS_CLICK_LIMITS.attemptsMax - 1, elapsedMs: 0, reloads: 0 }, undefined);
  assert.equal(last.delayMs, CANVAS_CLICK_LIMITS.retryDelaysMs.at(-1), 'the longest wait repeats');
});

test('a frame that cannot vouch says why, and each reason picks its own step', () => {
  for (const problem of FRAME_RENDER_PROBLEMS) {
    const step = planCanvasClickRecovery(stale('no-render', undefined), FRESH, problem);
    switch (problem) {
      case 'conflicting-stamps':
        assert.equal(step.kind, 'retry', 'a mixed rendering is healed by the reload the frame report starts');
        break;
      case 'too-many-stamps':
      case 'page-too-large':
        assert.deepEqual(step, { kind: 'give-up', notice: { kind: 'too-large' } }, 'past the manifest bound on every rendering');
        break;
      case 'no-digest':
        assert.deepEqual(step, { kind: 'reload-canvas' });
        assert.deepEqual(planCanvasClickRecovery(stale('no-render', undefined), SPENT_AND_RELOADED, problem), {
          kind: 'give-up',
          notice: { kind: 'unreachable' },
        });
        break;
      default:
        assert.fail(`unhandled render problem ${problem}`);
    }
  }
});

test('main or the frame going quiet is retried, then said plainly', () => {
  assert.equal(planCanvasClickRecovery({ kind: 'check-failed' }, FRESH, undefined).kind, 'retry');
  assert.deepEqual(planCanvasClickRecovery({ kind: 'check-failed' }, SPENT, undefined), { kind: 'give-up', notice: { kind: 'unreachable' } });
  assert.deepEqual(planCanvasClickRecovery({ kind: 'frame-silent' }, SPENT, undefined), { kind: 'reload-canvas' });
  assert.deepEqual(planCanvasClickRecovery({ kind: 'frame-silent' }, SPENT_AND_RELOADED, undefined), { kind: 'give-up', notice: { kind: 'unreachable' } });
  assert.deepEqual(planCanvasClickRecovery({ kind: 'no-point' }, FRESH, undefined), { kind: 'drop' });
});

test('a refused right-click or double-click is told only when it will not pass', () => {
  assert.deepEqual(planCanvasEventRefusal(stale('superseded'), undefined), { kind: 'drop' });
  assert.deepEqual(planCanvasEventRefusal(stale('shown-page-differs'), undefined), { kind: 'drop' });
  assert.equal(planCanvasEventRefusal(stale('unstamped-file'), undefined).kind, 'select-page');
  assert.deepEqual(planCanvasEventRefusal(stale('no-render', undefined), 'page-too-large'), { kind: 'give-up', notice: { kind: 'too-large' } });
});

test('the planner refuses impossible progress', () => {
  assert.throws(() => planCanvasClickRecovery(stale('superseded'), { attempt: -1, elapsedMs: 0, reloads: 0 }, undefined), /no negative attempts/);
  assert.throws(() => planCanvasClickRecovery(stale('superseded'), { attempt: 0.5, elapsedMs: 0, reloads: 0 }, undefined), /whole numbers/);
  assert.throws(() => planCanvasClickRecovery(stale('superseded'), { attempt: 0, elapsedMs: 0, reloads: -1 }, undefined), /negative reloads/);
});

test('problem codes are stable and distinct', () => {
  const codes = [...PREVIEW_STALE_REASONS.map((reason) => stale(reason)), { kind: 'check-failed' }, { kind: 'frame-silent' }, { kind: 'no-point' }].map(
    canvasClickProblemCode,
  );
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(canvasClickProblemCode(stale('superseded')), 'stale:superseded');
});

test('a notice shows once per quiet period, and recovery clears it', () => {
  const gate = new CanvasNoticeGate();
  const notice = { kind: 'out-of-step' };
  assert.equal(gate.admit(notice, 0), true);
  assert.equal(gate.admit(notice, 1), false, 'the same notice is not repeated on the next click');
  assert.equal(gate.admit(notice, CANVAS_CLICK_LIMITS.noticeQuietMs - 1), false);
  assert.equal(gate.admit({ kind: 'unreachable' }, 2), true, 'a different cause is news');
  assert.equal(gate.clear(), true, 'a notice was up');
  assert.equal(gate.clear(), false, 'and is gone');
  assert.equal(gate.admit(notice, 3), true, 'after recovery a new failure is told again');
  assert.equal(gate.admit({ kind: 'other-page', file: 'a' }, 4), true);
  assert.equal(gate.admit({ kind: 'other-page', file: 'a' }, 5), false);
  assert.throws(() => gate.admit(notice, Number.NaN), /finite time/);
});

test('the click log is bounded and names no file', () => {
  clearCanvasClickLog();
  for (let index = 0; index < CANVAS_CLICK_LOG_ENTRIES_MAX * 2; index++) {
    recordCanvasClick({ atMs: index, outcome: 'selected', code: undefined, attempt: 0 });
  }
  assert.equal(canvasClickEntries().length, CANVAS_CLICK_LOG_ENTRIES_MAX);
  assert.equal(canvasClickEntries()[0].atMs, CANVAS_CLICK_LOG_ENTRIES_MAX, 'the oldest entries go first');
  recordCanvasClick({ atMs: 1000, outcome: 'gave-up', code: 'stale:file-changed', attempt: 6 });
  assert.match(canvasClickLogText(), /1000ms gave-up stale:file-changed attempt=6$/);
  assert.throws(() => recordCanvasClick({ atMs: Number.POSITIVE_INFINITY, outcome: 'selected', code: undefined, attempt: 0 }), /finite time/);
  assert.throws(() => recordCanvasClick({ atMs: 0, outcome: 'selected', code: undefined, attempt: 1.5 }), /whole numbers/);
  clearCanvasClickLog();
});

// A fake clock and frame for the controller. `schedule` keeps timers in a list
// that `advance` fires in time order; nothing waits on the wall clock.
function harness(onQuery = () => {}) {
  let nowMs = 0;
  let timerSeq = 0;
  const timers = [];
  const events = { queries: [], pages: 0, reloads: 0, notices: [], renderRequests: 0 };
  const host = {
    nowMs: () => nowMs,
    schedule: (delayMs, run) => {
      const timer = { atMs: nowMs + delayMs, seq: timerSeq++, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    query: (id, x, y) => {
      events.queries.push({ id, x, y });
      onQuery(id);
    },
    selectPage: () => {
      events.pages += 1;
    },
    reloadCanvas: () => {
      events.reloads += 1;
    },
    notice: (event) => events.notices.push(event),
    requestRender: () => {
      events.renderRequests += 1;
    },
  };
  const advance = (ms) => {
    const until = nowMs + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      const due = timers.filter((timer) => timer.live && timer.atMs <= until).sort((left, right) => left.atMs - right.atMs || left.seq - right.seq)[0];
      if (due === undefined) {
        break;
      }
      due.live = false;
      nowMs = due.atMs;
      due.run();
    }
    nowMs = until;
  };
  return { ladder: new CanvasClickRetry(host), events, advance, live: () => timers.filter((timer) => timer.live).length };
}

test('a superseded click looks again and selects once the canvas catches up', () => {
  const { ladder, events, advance } = harness();
  const id = ladder.begin({ x: 10, y: 20 });
  assert.equal(ladder.current(id), true);
  ladder.failed(id, stale('superseded', undefined));
  assert.equal(events.queries.length, 0, 'it waits before it looks');
  ladder.rendered(); // The new rendering is announced: look now, not after the delay.
  assert.deepEqual(events.queries, [{ id, x: 10, y: 20 }], 'the same point, asked again');
  assert.equal(ladder.claimReplay(id), true, 'the answer is claimed');
  assert.equal(ladder.claimReplay(id), false, 'only once');
  ladder.succeeded(id);
  advance(10_000);
  assert.deepEqual(events.notices, [], 'nothing is said about a click that selected');
  assert.equal(events.reloads, 0);
});

test('a click refused for want of a rendering asks the frame to say it again', () => {
  const { ladder, events } = harness();
  const id = ladder.begin({ x: 3, y: 4 });
  ladder.failed(id, stale('no-render', undefined));
  assert.equal(events.renderRequests, 1, 'an announcement sent before the editor listened is asked for again');
  ladder.rendered(); // The frame's answer: look now.
  assert.deepEqual(events.queries, [{ id, x: 3, y: 4 }]);
  const other = ladder.begin({ x: 3, y: 4 });
  ladder.failed(other, stale('superseded', undefined));
  assert.equal(events.renderRequests, 1, 'a rendering that moved on was announced; nothing to ask');
});

test('a newer click replaces one still being retried', () => {
  const { ladder, events, advance } = harness();
  const first = ladder.begin({ x: 1, y: 1 });
  ladder.failed(first, stale('file-changed'));
  const second = ladder.begin({ x: 2, y: 2 });
  advance(CANVAS_CLICK_LIMITS.retryDelaysMs[0] + 1);
  assert.equal(events.queries.length, 0, 'the replaced click never looks again');
  assert.equal(ladder.current(first), false, 'its late verdict is ignored');
  assert.equal(ladder.claimReplay(first), false, 'and so is an answer for it');
  assert.equal(ladder.current(second), true);
  ladder.succeeded(second);
  assert.ok(
    canvasClickEntries().some((entry) => entry.outcome === 'replaced'),
    'the replacement is logged',
  );
});

test('a frame that never answers is reloaded once, then said plainly, once', () => {
  const { ladder, events, advance, live } = harness();
  for (let round = 0; round < 3; round++) {
    const id = ladder.begin({ x: 5, y: 5 });
    ladder.failed(id, stale('superseded', undefined));
    advance(CANVAS_CLICK_LIMITS.retryWindowMs + 3 * CANVAS_CLICK_LIMITS.answerTimeoutMs);
  }
  assert.equal(events.reloads, 1, 'one reload per document');
  assert.deepEqual(
    events.notices.filter((event) => event.kind === 'show'),
    [{ kind: 'show', notice: { kind: 'unreachable' } }],
    'told once, not on every click',
  );
  assert.equal(live(), 0, 'no timer outlives the ladder');
  const id = ladder.begin({ x: 5, y: 5 });
  ladder.succeeded(id);
  assert.deepEqual(events.notices.at(-1), { kind: 'recovered' }, 'a click that selects takes the notice down');
});

test('a canvas showing another page selects the page and says so once', () => {
  const { ladder, events } = harness();
  for (let round = 0; round < 5; round++) {
    const id = ladder.begin({ x: 5, y: 5 });
    ladder.failed(id, stale('unstamped-file'));
  }
  assert.equal(events.pages, 5, 'every click still selects something');
  assert.equal(events.notices.length, 1);
  assert.deepEqual(events.notices[0], { kind: 'show', notice: { kind: 'other-page', file: 'src/pages/index.astro' } });
});

test('a mixed rendering reloads the canvas once by itself', () => {
  const { ladder, events } = harness();
  ladder.renderFailed('conflicting-stamps');
  ladder.renderFailed('conflicting-stamps');
  assert.equal(events.reloads, 1);
  ladder.documentChanged();
  ladder.renderFailed('conflicting-stamps');
  assert.equal(events.reloads, 2, 'another document has its own reload');
});

test('a click with no point is dropped, never retried', () => {
  const { ladder, events, advance } = harness();
  const id = ladder.begin({ x: undefined, y: undefined });
  ladder.failed(id, stale('superseded', undefined));
  advance(60_000);
  assert.equal(events.queries.length, 0);
  assert.equal(events.notices.length, 0, 'the text session that sent it says why itself');
});

test('the ladder refuses to settle a click it is not deciding', () => {
  const { ladder } = harness();
  assert.throws(() => ladder.succeeded(1), /was pending/);
  const id = ladder.begin({ x: 1, y: 1 });
  assert.throws(() => ladder.failed(id + 1, stale('superseded')), /pending one/);
});

// Seeded so a failure names its run. Each run: a page that keeps re-rendering
// for `busyMs`, a frame that answers each look after `answerMs` (or never), and
// clicks at random moments. The fake judge is the gate's own rule: current only
// when the click's token is the frame's latest and the canvas is not mid-render.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized: every click ends once, and one the canvas catches up with selects', () => {
  const RUNS = 400;
  let caughtUp = 0;
  let retried = 0;
  for (let seed = 1; seed <= RUNS; seed++) {
    const random = mulberry32(seed);
    const answerMs = random() < 0.1 ? undefined : Math.floor(random() * 300);
    const pendingAnswers = [];
    let elapsedMs = 0;
    let token = 0;
    const { ladder, events, advance, live } = harness((id) => {
      if (answerMs !== undefined) {
        pendingAnswers.push({ atMs: elapsedMs + answerMs, id });
      }
    });
    const busyMs = Math.floor(random() * 3_000); // Re-rendering until then.
    const outcomes = new Map();
    const settle = (id, outcome) => {
      assert.equal(outcomes.has(id), false, `seed ${seed}: click ${id} settled twice`);
      outcomes.set(id, outcome);
    };
    const judge = (id, clickToken) => {
      if (!ladder.current(id)) {
        return;
      }
      if (elapsedMs < busyMs || clickToken !== token) {
        ladder.failed(id, stale(random() < 0.5 ? 'superseded' : 'file-changed', undefined));
      } else {
        ladder.succeeded(id);
        settle(id, 'selected');
      }
    };
    const clicks = [];
    const clickCount = 1 + Math.floor(random() * 4);
    for (let index = 0; index < clickCount; index++) {
      clicks.push(Math.floor(random() * 4_000));
    }
    clicks.sort((left, right) => left - right);
    const stepMs = 20;
    for (; elapsedMs < 30_000; elapsedMs += stepMs) {
      if (elapsedMs < busyMs && random() < 0.2) {
        token += 1;
        ladder.rendered();
      }
      while (clicks.length > 0 && clicks[0] <= elapsedMs) {
        clicks.shift();
        const id = ladder.begin({ x: random() * 800, y: random() * 600 });
        judge(id, token);
      }
      const due = pendingAnswers.filter((item) => item.atMs <= elapsedMs);
      const later = pendingAnswers.filter((item) => item.atMs > elapsedMs);
      pendingAnswers.length = 0;
      pendingAnswers.push(...later);
      for (const answer of due) {
        if (ladder.claimReplay(answer.id)) {
          judge(answer.id, token);
        }
      }
      advance(stepMs);
    }
    const lastSelected = [...outcomes.values()].filter((outcome) => outcome === 'selected').length;
    if (answerMs !== undefined && busyMs + 2 * CANVAS_CLICK_LIMITS.retryDelaysMs.at(-1) + answerMs < CANVAS_CLICK_LIMITS.retryWindowMs) {
      // The canvas settles well inside the window and the frame answers: the
      // latest click always selects, and nothing is said.
      caughtUp += 1;
      assert.ok(lastSelected >= 1, `seed ${seed}: the last click selects (busy ${busyMs}ms, answers in ${answerMs}ms)`);
      assert.deepEqual(
        events.notices.filter((event) => event.kind === 'show'),
        [],
        `seed ${seed}: no notice for a canvas that caught up`,
      );
    }
    assert.ok(events.reloads <= CANVAS_CLICK_LIMITS.reloadsPerDocumentMax + 1, `seed ${seed}: reloads stay bounded`);
    assert.ok(events.notices.filter((event) => event.kind === 'show').length <= 1, `seed ${seed}: a notice at most once`);
    retried += events.queries.length > 0 ? 1 : 0;
    ladder.dispose();
    assert.equal(live(), 0, `seed ${seed}: disposing cancels every timer`);
  }
  // The run is only evidence if it reached the interesting cases.
  assert.ok(caughtUp > RUNS / 4, `most runs settle inside the window (${caughtUp} of ${RUNS})`);
  assert.ok(retried > RUNS / 4, `most runs had clicks land mid-render and retried (${retried} of ${RUNS})`);
});
