// Goal: a window that fails is brought back a bounded number of times and then handed to the recovery screen, and what
// went wrong is kept in a bounded log. Never an endless reload flicker, never a silent black window.
// Method: the pure decision (windowHealth.ts) is driven through event sequences at chosen times: one failure reloads,
// the allowance runs out on the next, old reloads age out of the window, a deliberate abort and a clean exit are not
// failures, an unresponsive window is restarted only after the long wait, the person's Reload restores the allowance.
// The crash log (crashLog.ts) is driven past its ring, with damaged files and entries, and through a real directory.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  CRASH_LOG_FILE,
  CRASH_LOG_LIMITS,
  appendCrash,
  describeCrashLog,
  parseCrashLog,
  readCrashLog,
  serializeCrashLog,
  writeCrashLog,
} from '#dist/electron/app/crashLog.js';
import type { CrashRecord } from '#dist/electron/app/crashLog.js';
import { HEALTHY, WINDOW_HEALTH_LIMITS, decideHealth, type HealthEvent, type HealthState } from '#dist/electron/app/windowHealth.js';

const GONE: HealthEvent = { kind: 'renderer-gone', reason: 'crashed', exitCode: 11 };
const LOAD_FAILED: HealthEvent = { kind: 'load-failed', code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:5173/' };

function run(events: ReadonlyArray<readonly [HealthEvent, number]>): ReturnType<typeof decideHealth>[] {
  let state: HealthState = HEALTHY;
  const steps: ReturnType<typeof decideHealth>[] = [];
  for (const [event, at] of events) {
    const step = decideHealth(state, event, at);
    steps.push(step);
    state = step.state;
  }
  return steps;
}

test('a first crash reloads the window and is recorded', () => {
  const [step] = run([[GONE, 1_000]]);
  assert.equal(step?.decision.action, 'reload');
  assert.equal(step?.record?.source, 'renderer-gone');
  assert.equal(step?.state.reloadsAtMs.length, 1);
});

test('the reload allowance runs out and the next failure shows the recovery screen, naming the cause', () => {
  const events: Array<readonly [HealthEvent, number]> = [];
  for (let attempt = 0; attempt < WINDOW_HEALTH_LIMITS.reloadsMax; attempt++) {
    events.push([GONE, 1_000 + attempt * 1_000]);
  }
  events.push([GONE, 10_000]);
  const steps = run(events);
  const actions = steps.map((step) => step.decision.action);
  assert.deepEqual(actions, ['reload', 'reload', 'reload', 'show-recovery']);
  const last = steps.at(-1);
  assert.equal(last?.decision.action, 'show-recovery');
  if (last?.decision.action === 'show-recovery') {
    assert.equal(last.decision.reason.kind, 'loop-guard');
    if (last.decision.reason.kind === 'loop-guard') {
      assert.equal(last.decision.reason.reloads, WINDOW_HEALTH_LIMITS.reloadsMax);
      assert.equal(last.decision.reason.cause.kind, 'renderer-gone');
    }
  }
  assert.equal(last?.record?.source, 'reload-loop');
  assert.equal(last?.state.recovering, true);
});

test('once the recovery screen is up, further failures are recorded and acted on no more', () => {
  const events: Array<readonly [HealthEvent, number]> = [];
  for (let attempt = 0; attempt <= WINDOW_HEALTH_LIMITS.reloadsMax; attempt++) {
    events.push([LOAD_FAILED, 1_000 + attempt]);
  }
  events.push([LOAD_FAILED, 5_000], [GONE, 5_001]);
  const steps = run(events);
  assert.equal(steps[WINDOW_HEALTH_LIMITS.reloadsMax]?.decision.action, 'show-recovery');
  assert.equal(steps.at(-1)?.decision.action, 'record-only');
  assert.equal(steps.at(-2)?.decision.action, 'record-only');
});

test('reloads older than the window no longer count: a window that ran well gets its allowance back', () => {
  const steps = run([
    [GONE, 0],
    [GONE, 1_000],
    [GONE, 2_000],
    [GONE, WINDOW_HEALTH_LIMITS.reloadWindowMs + 10_000],
  ]);
  assert.equal(steps.at(-1)?.decision.action, 'reload');
  assert.ok((steps.at(-1)?.state.reloadsAtMs.length ?? 99) <= WINDOW_HEALTH_LIMITS.reloadsMax);
});

test('a navigation that was replaced by another is not a failure', () => {
  const [step] = run([[{ kind: 'load-failed', code: -3, description: 'ERR_ABORTED', url: 'x' }, 0]]);
  assert.equal(step?.decision.action, 'ignore');
  assert.equal(step?.record, undefined);
});

test('a renderer that exited cleanly is not a failure', () => {
  const [step] = run([[{ kind: 'renderer-gone', reason: 'clean-exit', exitCode: 0 }, 0]]);
  assert.equal(step?.decision.action, 'ignore');
});

test('every other renderer exit reason is a failure', () => {
  for (const reason of ['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure']) {
    const [step] = run([[{ kind: 'renderer-gone', reason, exitCode: 1 }, 0]]);
    assert.equal(step?.decision.action, 'reload', reason);
  }
});

test('an unresponsive window is recorded, and restarted only when it stays unresponsive', () => {
  const [unresponsive, responsive, tooLong] = run([
    [{ kind: 'unresponsive' }, 0],
    [{ kind: 'responsive' }, 1_000],
    [{ kind: 'unresponsive-too-long' }, 2_000],
  ]);
  assert.equal(unresponsive?.decision.action, 'record-only');
  assert.equal(unresponsive?.record?.source, 'unresponsive');
  assert.equal(responsive?.decision.action, 'record-only');
  assert.equal(tooLong?.decision.action, 'restart-renderer');
  assert.ok(WINDOW_HEALTH_LIMITS.unresponsiveMsMax > 0);
});

test('a helper process that crashed is recorded and the window is left alone', () => {
  const [step] = run([[{ kind: 'child-gone', processType: 'GPU', reason: 'crashed', exitCode: 9 }, 0]]);
  assert.equal(step?.decision.action, 'record-only');
  assert.match(step?.record?.reason ?? '', /GPU: crashed/);
});

test("the person's Reload on the recovery screen restores a full allowance", () => {
  const events: Array<readonly [HealthEvent, number]> = [];
  for (let attempt = 0; attempt <= WINDOW_HEALTH_LIMITS.reloadsMax; attempt++) {
    events.push([GONE, 1_000 + attempt]);
  }
  events.push([{ kind: 'reload-requested' }, 2_000], [GONE, 2_100]);
  const steps = run(events);
  assert.equal(steps.at(-2)?.decision.action, 'reload');
  assert.equal(steps.at(-2)?.state.recovering, false);
  assert.equal(steps.at(-1)?.decision.action, 'reload');
});

test('the reload history never exceeds its bound over a long failing run', () => {
  let state: HealthState = HEALTHY;
  for (let at = 0; at < 500; at++) {
    const step = decideHealth(state, GONE, at * 100);
    state = step.state;
    assert.ok(state.reloadsAtMs.length <= WINDOW_HEALTH_LIMITS.reloadsMax);
  }
});

function record(index: number, overrides: { readonly detail?: string; readonly reason?: string } = {}): CrashRecord {
  return { atMs: 1_700_000_000_000 + index, source: 'renderer-gone', reason: overrides.reason ?? `reason ${index}`, detail: overrides.detail ?? '' };
}

test('the crash log is a ring: the newest entries stay, the oldest go', () => {
  let log: readonly CrashRecord[] = [];
  for (let index = 0; index < CRASH_LOG_LIMITS.entriesMax + 20; index++) {
    log = appendCrash(log, record(index), undefined);
  }
  assert.equal(log.length, CRASH_LOG_LIMITS.entriesMax);
  assert.equal(log.at(-1)?.reason, `reason ${CRASH_LOG_LIMITS.entriesMax + 19}`);
  assert.equal(log[0]?.reason, 'reason 20');
});

test('one record is cut to its field bounds and writes the home directory as a tilde', () => {
  const log = appendCrash(
    [],
    record(0, {
      reason: `/Users/someone/site failed ${'x'.repeat(CRASH_LOG_LIMITS.reasonCharsMax)}`,
      detail: `at /Users/someone/a.ts ${'y'.repeat(CRASH_LOG_LIMITS.detailCharsMax * 2)}`,
    }),
    '/Users/someone',
  );
  assert.equal(log[0]?.reason.length, CRASH_LOG_LIMITS.reasonCharsMax);
  assert.ok(log[0]?.reason.startsWith('~/site failed'));
  assert.equal(log[0]?.detail.length, CRASH_LOG_LIMITS.detailCharsMax);
  assert.ok(log[0]?.detail.startsWith('at ~/a.ts'));
});

test('the log round-trips through text, and a damaged file or entry loses only itself', () => {
  const log = [record(1), record(2, { detail: 'frame' })];
  assert.deepEqual(parseCrashLog(serializeCrashLog(log)), log);
  assert.deepEqual(parseCrashLog(''), []);
  assert.deepEqual(parseCrashLog('not json'), []);
  assert.deepEqual(parseCrashLog('{"a":1}'), []);
  const mixed = JSON.stringify([
    record(1),
    { atMs: 'x', source: 'renderer-gone', reason: 'r', detail: '' },
    { ...record(2), source: 'invented' },
    5,
    undefined,
    record(3),
  ]);
  assert.deepEqual(
    parseCrashLog(mixed).map((entry) => entry.reason),
    ['reason 1', 'reason 3'],
  );
  assert.deepEqual(parseCrashLog('['.repeat(CRASH_LOG_LIMITS.fileBytesMax + 1)), []);
});

test('describing the log lists the newest first', () => {
  const text = describeCrashLog([record(1), record(2, { detail: 'the frames' })]);
  assert.ok(text.indexOf('reason 2') < text.indexOf('reason 1'));
  assert.match(text, /the frames/);
});

test('the log is written to and read from a directory, and an unwritable place does not throw', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-crash-log-'));
  try {
    assert.deepEqual(readCrashLog(directory), []);
    assert.equal(writeCrashLog(directory, [record(1)]), true);
    assert.deepEqual(readCrashLog(directory), [record(1)]);
    fs.writeFileSync(path.join(directory, CRASH_LOG_FILE), 'damaged');
    assert.deepEqual(readCrashLog(directory), []);
    const blocker = path.join(directory, 'file');
    fs.writeFileSync(blocker, '');
    assert.equal(writeCrashLog(path.join(blocker, 'inside'), [record(1)]), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
