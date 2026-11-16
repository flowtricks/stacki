// Goal: the stage trace costs nothing when off, stamps stages on the clock it is given when on,
// stays inside its bounds, and turns a run into durations. Method: a fake clock, then the
// bounds (runs kept, stages per run), then stamps from another process sorted by time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STAGE_TRACE_LIMITS, STAGE_TRACE_OFF, createStageTrace, stageDurations } from '#dist/shared/core/stageTrace.js';

test('a trace that is off is the shared no-op and records nothing', () => {
  const trace = createStageTrace({ enabled: false, clock: () => assert.fail('an off trace never reads the clock') });
  assert.equal(trace, STAGE_TRACE_OFF);
  trace.begin('insert');
  trace.mark('placed');
  assert.equal(trace.finish(), undefined);
  assert.deepEqual(trace.runs(), []);
});

test('stages are stamped on the clock and read back as durations', () => {
  let now = 100;
  const trace = createStageTrace({ enabled: true, clock: () => now });
  trace.mark('before any run is dropped');
  trace.begin('insert p');
  now = 104;
  trace.mark('placed');
  now = 110;
  trace.mark('written');
  trace.markAt('frame showed it', 103);
  const run = trace.finish();
  assert.ok(run);
  assert.deepEqual(
    stageDurations(run).map((entry) => [entry.stage, entry.sinceStartMs, entry.sincePreviousMs]),
    [
      ['begin', 0, 0],
      ['frame showed it', 3, 3],
      ['placed', 4, 1],
      ['written', 10, 6],
    ],
  );
  assert.equal(trace.finish(), undefined, 'a run closes once');
});

test('runs and stages are bounded', () => {
  const trace = createStageTrace({ enabled: true, clock: () => 0 });
  for (let run = 0; run < STAGE_TRACE_LIMITS.runsMax + 5; run += 1) {
    trace.begin(`run ${run}`);
  }
  trace.finish();
  assert.equal(trace.runs().length, STAGE_TRACE_LIMITS.runsMax);
  assert.equal(trace.runs()[0]?.label, 'run 5');
  trace.begin('long');
  for (let stage = 0; stage < STAGE_TRACE_LIMITS.stagesMax + 3; stage += 1) {
    trace.mark(`stage ${stage}`);
  }
  const long = trace.finish();
  assert.equal(long?.stages.length, STAGE_TRACE_LIMITS.stagesMax);
  assert.equal(long?.dropped, 4);
});
