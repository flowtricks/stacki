// Goal: the start report is parsed at both ends (the container's POST at the Durable Object, the
// Worker's readout in the editor), and the Durable Object's log keeps one ordered history per start.
// Method: known-good and known-bad shapes for each parser; the log driven through a whole start, a late
// report, a restart, and each container phase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStartupReport, parseStartupView, STARTUP_LIMITS, STARTUP_STAGES } from '../src/features/startup/startupStages';
import { NEW_PROCESS_MARGIN_MS, StartupLog } from '../src/features/startup/startupLog';
import { startupStep, STARTUP_STAGE_KEYS } from '../src/features/startup/startupText';

test('a report with a known stage and a sane clock is accepted', () => {
  assert.deepEqual(parseStartupReport({ stage: 'drafts', sinceStartMs: 4_200 }), { ok: true, value: { stage: 'drafts', sinceStartMs: 4_200 } });
});

test('a report that is not what the container sends is refused, each way it can differ', () => {
  const bad: readonly unknown[] = [
    undefined,
    null,
    'drafts',
    [],
    {},
    { stage: 'drafts' },
    { stage: 'warming', sinceStartMs: 1 },
    { stage: 7, sinceStartMs: 1 },
    { stage: 'drafts', sinceStartMs: '1' },
    { stage: 'drafts', sinceStartMs: 1.5 },
    { stage: 'drafts', sinceStartMs: -1 },
    { stage: 'drafts', sinceStartMs: STARTUP_LIMITS.sinceStartMsMax + 1 },
    { stage: 'drafts', sinceStartMs: Number.NaN },
  ];
  for (const input of bad) {
    assert.equal(parseStartupReport(input).ok, false, JSON.stringify(input));
  }
});

test('the Worker readout parses with its history, and an over-long or malformed one does not', () => {
  const good = { stage: 'server', history: [{ stage: 'repository', sinceStartMs: 100 }] };
  assert.deepEqual(parseStartupView(good), { ok: true, value: good });
  assert.equal(parseStartupView({ stage: 'server' }).ok, false);
  assert.equal(parseStartupView({ stage: 'server', history: 'x' }).ok, false);
  assert.equal(parseStartupView({ stage: 'nowhere', history: [] }).ok, false);
  assert.equal(parseStartupView({ stage: 'server', history: [{ stage: 'x', sinceStartMs: 1 }] }).ok, false);
  const tooLong = Array.from({ length: STARTUP_LIMITS.historyMax + 1 }, () => ({ stage: 'drafts', sinceStartMs: 1 }));
  assert.equal(parseStartupView({ stage: 'server', history: tooLong }).ok, false);
});

test('every stage has a message key and a step, and ready is not a step', () => {
  for (const stage of STARTUP_STAGES) {
    assert.match(STARTUP_STAGE_KEYS[stage], /^studio\.boot\.stage\./);
  }
  assert.deepEqual(startupStep('container'), { step: 1, total: 6 });
  assert.deepEqual(startupStep('compile'), { step: 6, total: 6 });
  assert.deepEqual(startupStep('ready'), { step: 6, total: 6 });
});

test('a whole start is kept in order, once per stage', () => {
  const log = new StartupLog();
  STARTUP_STAGES.forEach((stage, index) => log.record({ stage, sinceStartMs: index * 1_000 }));
  const view = log.view('serving');
  assert.equal(view.stage, 'ready');
  assert.deepEqual(
    view.history.map((entry) => entry.stage),
    [...STARTUP_STAGES],
  );
});

test('a late report of an earlier stage and a repeated report change nothing', () => {
  const log = new StartupLog();
  log.record({ stage: 'drafts', sinceStartMs: 5_000 });
  log.record({ stage: 'repository', sinceStartMs: 4_900 });
  log.record({ stage: 'drafts', sinceStartMs: 5_001 });
  assert.deepEqual(log.view('starting').history, [{ stage: 'drafts', sinceStartMs: 5_000 }]);
});

test('a clock far behind the last report is a new process and starts a new history', () => {
  const log = new StartupLog();
  log.record({ stage: 'ready', sinceStartMs: 30_000 });
  log.record({ stage: 'repository', sinceStartMs: 300 });
  assert.deepEqual(log.view('starting'), { stage: 'repository', history: [{ stage: 'repository', sinceStartMs: 300 }] });
  assert.ok(NEW_PROCESS_MARGIN_MS >= 5_000, 'the margin covers a report delayed to its own time limit');
});

test('the view follows the container phase', () => {
  const log = new StartupLog();
  assert.deepEqual(log.view('stopped'), { stage: 'container', history: [] });
  assert.deepEqual(log.view('starting'), { stage: 'container', history: [] });
  // A Durable Object that lost its memory while the container kept serving still answers: the server is up.
  assert.deepEqual(log.view('serving'), { stage: 'ready', history: [] });
  log.record({ stage: 'dependencies', sinceStartMs: 9_000 });
  assert.equal(log.view('starting').stage, 'dependencies');
  assert.deepEqual(log.view('stopped'), { stage: 'container', history: [] });
  log.reset();
  assert.deepEqual(log.view('starting'), { stage: 'container', history: [] });
});
