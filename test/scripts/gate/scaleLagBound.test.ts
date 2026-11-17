// Goal: the event-loop bound of the scale suites is relative to the machine, not a fixed number of
// milliseconds: on the reference machine it is 250 ms, on a machine k times slower at a fixed
// workload it is 250 * k, it is never stricter than 250 ms, and it is capped at four times, so an
// operation that never yields still fails on any runner. The override still wins.
// Methodology: speedFactorFor is pure and gets each side of the clamp; measureSpeedFactor runs with
// a fake clock that makes every run take a chosen time; lagMsBound runs once with the override set.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibrationWorkload, LAG_LIMITS, lagMsBound, measureSpeedFactor, speedFactorFor } from '../../helpers/scaleFixtures.ts';

test('the factor is the calibration time over the reference, clamped to [1, 4]', () => {
  assert.equal(speedFactorFor(LAG_LIMITS.calibrationReferenceMs), 1);
  assert.equal(speedFactorFor(LAG_LIMITS.calibrationReferenceMs * 2), 2);
  assert.equal(speedFactorFor(LAG_LIMITS.calibrationReferenceMs / 3), 1, 'a faster machine is not held stricter');
  assert.equal(speedFactorFor(LAG_LIMITS.calibrationReferenceMs * 40), LAG_LIMITS.factorMax, 'a non-yielding operation still fails');
  assert.throws(() => speedFactorFor(0), /a positive number/);
  assert.throws(() => speedFactorFor(Number.NaN), /a positive number/);
});

test('the measured factor is the median run against the reference', () => {
  let now = 0;
  let calls = 0;
  // Each run's start and end; runs take 30 ms, so the factor is 2.
  const clock = (): number => {
    calls += 1;
    now += calls % 2 === 0 ? LAG_LIMITS.calibrationReferenceMs * 2 : 0;
    return now;
  };
  assert.equal(measureSpeedFactor(clock), 2);
  assert.equal(calls, LAG_LIMITS.calibrationRuns * 2);
  assert.ok(calibrationWorkload() > 0, 'the workload does real work');
});

test('the override wins', () => {
  process.env['STACKI_SCALE_LAG_MS'] = '900';
  try {
    assert.equal(lagMsBound(), 900);
  } finally {
    delete process.env['STACKI_SCALE_LAG_MS'];
  }
});
