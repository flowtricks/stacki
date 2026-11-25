// Waiting for something that is not ready yet, with a stated limit and no busy loop: the
// container waits for its own Astro server before warming it, and the editor waits for the
// Worker's start report. One bounded poll with exponential backoff serves both, with the
// clock and the sleep passed in so a test runs it without waiting.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';

export interface ReadinessLimits {
  readonly attemptsMax: number;
  readonly delayMsMin: number;
  readonly delayMsMax: number;
  readonly deadlineMs: number;
}

/** The container waiting for Astro: Astro answers in seconds, so the probe starts fast and settles at two seconds. */
export const READINESS_LIMITS = {
  attemptsMax: 200,
  delayMsMin: 250,
  delayMsMax: 2_000,
  deadlineMs: 180_000,
} as const satisfies ReadinessLimits;

export interface ReadinessClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

export type ReadinessFailure =
  { readonly kind: 'attempts'; readonly attempts: number } | { readonly kind: 'deadline'; readonly attempts: number; readonly elapsedMs: number };

export interface ReadinessSuccess {
  readonly attempts: number;
  readonly elapsedMs: number;
}

/** 250, 500, 1000, 2000, 2000 ... for the defaults: doubling from the minimum, never above the maximum. */
export function backoffDelayMs(attempt: number, limits: ReadinessLimits): number {
  assert(Number.isSafeInteger(attempt), 'An attempt number is an integer');
  assert(attempt >= 0, 'An attempt number is not negative');
  // Beyond 30 doublings the result is clamped anyway; the cap keeps the exponent finite.
  const doubled = limits.delayMsMin * 2 ** Math.min(attempt, 30);
  return Math.min(limits.delayMsMax, doubled);
}

/**
 * Runs `probe` until it says yes, no more than `attemptsMax` times and no longer than
 * `deadlineMs` in all. A probe that throws counts as "not yet": the server is still starting.
 */
export async function waitUntilReady(
  probe: () => Promise<boolean>,
  clock: ReadinessClock,
  limits: ReadinessLimits = READINESS_LIMITS,
): Promise<Result<ReadinessSuccess, ReadinessFailure>> {
  assert(limits.attemptsMax > 0, 'At least one attempt is allowed');
  assert(limits.delayMsMin <= limits.delayMsMax, 'The delay range is ordered');
  const startedAt = clock.now();
  for (let attempt = 0; attempt < limits.attemptsMax; attempt += 1) {
    const ready = await probe().catch(() => false);
    const elapsedMs = clock.now() - startedAt;
    if (ready) {
      return ok({ attempts: attempt + 1, elapsedMs });
    }
    if (elapsedMs >= limits.deadlineMs) {
      return err({ kind: 'deadline', attempts: attempt + 1, elapsedMs });
    }
    // Never sleep past the deadline: the last wait is cut to what is left.
    await clock.sleep(Math.min(backoffDelayMs(attempt, limits), limits.deadlineMs - elapsedMs));
  }
  return err({ kind: 'attempts', attempts: limits.attemptsMax });
}
