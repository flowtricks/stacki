// Goal: waiting for a server that is still starting is bounded in attempts and in time, backs off, and
// treats a failing probe as "not yet" rather than as a crash.
// Method: a fake clock whose sleep advances time without waiting; probes that answer on a chosen attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelayMs, READINESS_LIMITS, waitUntilReady, type ReadinessClock, type ReadinessLimits } from '../src/features/startup/readiness';

function fakeClock() {
  let nowMs = 1_000;
  const sleeps: number[] = [];
  const clock: ReadinessClock = {
    now: () => nowMs,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      nowMs += delayMs;
    },
  };
  return { clock, sleeps };
}
const limits: ReadinessLimits = { attemptsMax: 10, delayMsMin: 250, delayMsMax: 2_000, deadlineMs: 60_000 };

test('backoff doubles from the minimum and never passes the maximum', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 50].map((attempt) => backoffDelayMs(attempt, limits)),
    [250, 500, 1_000, 2_000, 2_000, 2_000, 2_000],
  );
});

test('backoff refuses a negative or fractional attempt number', () => {
  assert.throws(() => backoffDelayMs(-1, limits), /Assertion failed: An attempt number is not negative/);
  assert.throws(() => backoffDelayMs(1.5, limits), /Assertion failed: An attempt number is an integer/);
});

test('a probe that answers on the third try succeeds after two backoff sleeps', async () => {
  const { clock, sleeps } = fakeClock();
  let calls = 0;
  const result = await waitUntilReady(async () => ++calls === 3, clock, limits);
  assert.deepEqual(result, { ok: true, value: { attempts: 3, elapsedMs: 750 } });
  assert.deepEqual(sleeps, [250, 500]);
});

test('a probe that throws counts as not ready yet', async () => {
  const { clock } = fakeClock();
  let calls = 0;
  const result = await waitUntilReady(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('connection refused');
      }
      return true;
    },
    clock,
    limits,
  );
  assert.equal(result.ok, true);
});

test('the attempt limit ends the wait with the attempts made', async () => {
  const { clock } = fakeClock();
  const result = await waitUntilReady(async () => false, clock, { ...limits, attemptsMax: 4 });
  assert.deepEqual(result, { ok: false, error: { kind: 'attempts', attempts: 4 } });
});

test('the deadline ends the wait and the last sleep is cut to what is left of it', async () => {
  const { clock, sleeps } = fakeClock();
  const result = await waitUntilReady(async () => false, clock, { attemptsMax: 100, delayMsMin: 250, delayMsMax: 2_000, deadlineMs: 5_000 });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.kind === 'deadline');
  assert.ok(!result.ok && result.error.kind === 'deadline' && result.error.elapsedMs >= 5_000);
  assert.equal(
    sleeps.reduce((total, delayMs) => total + delayMs, 0),
    5_000,
  );
});

test('the container defaults are bounded: attempts, delay and a deadline of minutes, not unlimited', () => {
  assert.ok(READINESS_LIMITS.attemptsMax <= 1_000);
  assert.ok(READINESS_LIMITS.delayMsMax <= 5_000);
  // The bound is stated in minutes, the unit a person reasons about, so no millisecond literal is compared.
  const deadlineMinutes = READINESS_LIMITS.deadlineMs / (60 * 1000);
  assert.ok(deadlineMinutes <= 10, 'readiness gives up within ten minutes');
});

test('a limit set with no attempts is a programmer error', async () => {
  const { clock } = fakeClock();
  await assert.rejects(
    waitUntilReady(async () => true, clock, { ...limits, attemptsMax: 0 }),
    /At least one attempt is allowed/,
  );
});
