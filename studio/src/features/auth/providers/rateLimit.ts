// Goal: a bounded in-memory limiter for the public routes of a provider (sign-in start, callback, passkey ceremonies).
// Why in memory: every sign-in route runs inside the one Durable Object of the instance, so one map sees all traffic; a
// restart forgets it, which only loosens a limit for a moment. The map has a ceiling, and an attacker who fills it with
// distinct keys only makes the limiter start over, never grow.
// The key is the connecting address Cloudflare sets (`CF-Connecting-IP`); a client cannot choose it at the edge.
import { assert } from '../../../../vendor/stacki/shared/core/assert';

export const RATE_LIMITS = {
  /** Sign-in starts and callbacks per address per window. A person needs a handful; a script needs more. */
  signInAttemptsMax: 20,
  /** Passkey registration and assertion steps per address per window. */
  passkeyStepsMax: 30,
  /** First-admin setup attempts per address per window, and across all addresses together: the code is a secret. */
  setupAttemptsMax: 5,
  setupAttemptsGlobalMax: 30,
  windowMs: 60_000,
  /** Distinct addresses tracked at once. */
  entriesMax: 2_048,
} as const satisfies Record<string, number>;

export interface RateLimiter {
  /** Counts one use of `key`. Returns 0 when allowed, else the milliseconds until the window reopens. */
  readonly take: (key: string) => number;
}

export function createRateLimiter(options: { readonly attemptsMax: number; readonly windowMs?: number; readonly now?: () => number }): RateLimiter {
  const windowMs = options.windowMs ?? RATE_LIMITS.windowMs;
  const now = options.now ?? Date.now;
  assert(options.attemptsMax > 0, 'A limiter allows at least one attempt');
  const windows = new Map<string, { count: number; startedAt: number }>();
  return {
    take: (key) => {
      const at = now();
      const current = windows.get(key);
      if (current !== undefined && at - current.startedAt < windowMs) {
        current.count += 1;
        return current.count > options.attemptsMax ? current.startedAt + windowMs - at : 0;
      }
      if (windows.size >= RATE_LIMITS.entriesMax) {
        windows.clear();
      }
      windows.set(key, { count: 1, startedAt: at });
      return 0;
    },
  };
}

/** The address a request came from, as the limiter's key. */
export function clientKey(request: Request): string {
  const address = request.headers.get('CF-Connecting-IP') ?? '';
  return /^[0-9a-fA-F:.]{1,45}$/.test(address) ? address : 'unknown';
}
