// The editor's side of the start report: ask the Worker where the container's start is, with
// growing pauses and a hard limit, until it says ready, says it does not know (an older Worker,
// the demo), or the limit is reached. The clock, the sleep and the reader are passed in so a
// test runs a whole start in no time.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';
import { backoffDelayMs, type ReadinessClock, type ReadinessLimits } from './readiness';
import { parseStartupView, STARTUP_LIMITS, type StartupView } from './startupStages';

export const STARTUP_POLL_LIMITS = {
  attemptsMax: STARTUP_LIMITS.pollsMax,
  delayMsMin: STARTUP_LIMITS.pollMsMin,
  delayMsMax: STARTUP_LIMITS.pollMsMax,
  // At the slowest rate the attempts alone last over fifteen minutes; the container gives up on its own at ten.
  deadlineMs: 900_000,
} as const satisfies ReadinessLimits;

/** `undefined` from a reader means "no such route": polling stops and the screen keeps its generic text. */
export type StartupReader = (signal: AbortSignal) => Promise<Result<StartupView, string> | undefined>;

export type StartupPollEnd = 'ready' | 'unavailable' | 'limit' | 'aborted';

export interface StartupPollOptions {
  readonly read: StartupReader;
  readonly onView: (view: StartupView) => void;
  readonly clock: ReadinessClock;
  readonly signal: AbortSignal;
  /** Wait this long before the first read: a preview that is about to be ready should not cost a request. */
  readonly firstDelayMs: number;
  readonly limits?: ReadinessLimits;
}

export async function pollStartup(options: StartupPollOptions): Promise<StartupPollEnd> {
  const limits = options.limits ?? STARTUP_POLL_LIMITS;
  assert(options.firstDelayMs >= 0, 'The first delay is not negative');
  assert(limits.attemptsMax > 0, 'At least one read is allowed');
  const startedAt = options.clock.now();
  if (options.firstDelayMs > 0) {
    await options.clock.sleep(options.firstDelayMs);
  }
  for (let attempt = 0; attempt < limits.attemptsMax; attempt += 1) {
    if (options.signal.aborted) {
      return 'aborted';
    }
    const answer = await options.read(options.signal).catch(() => undefined);
    if (options.signal.aborted) {
      return 'aborted';
    }
    if (answer === undefined || !answer.ok) {
      return 'unavailable';
    }
    options.onView(answer.value);
    if (answer.value.stage === 'ready') {
      return 'ready';
    }
    const elapsedMs = options.clock.now() - startedAt;
    if (elapsedMs >= limits.deadlineMs) {
      return 'limit';
    }
    await options.clock.sleep(Math.min(backoffDelayMs(attempt, limits), limits.deadlineMs - elapsedMs));
  }
  return 'limit';
}

/** Reads the Worker's route. A non-answer (404, offline, an unreadable body) is "unavailable", never an error to show. */
export async function readStartupView(signal: AbortSignal): Promise<Result<StartupView, string> | undefined> {
  const response = await fetch('/studio/api/startup', {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    return undefined;
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    return undefined;
  }
  const body: unknown = await response.json();
  const view = parseStartupView(body);
  return view.ok ? ok(view.value) : err(view.error);
}
