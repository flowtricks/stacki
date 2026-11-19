// How long to wait when GitHub limits a request and gives no better guidance (its documented minimum for secondary limits).
export const rateLimitWaitMsDefault = 60_000;
// Upper bound on any wait we honour: a bad header must never lock a visitor out for days via the wait cookie.
export const rateLimitWaitMsMax = 3_600_000;

// An expected failure, not a bug: GitHub asked us to slow down, and `retryAt` (epoch ms) says until when.
export class GitHubRateLimitError extends Error {
  constructor(
    readonly status: number,
    readonly retryAt: number,
  ) {
    super(`GitHub is limiting requests (${status}).`);
    this.name = 'GitHubRateLimitError';
  }
}

// GitHub signals a limit as 429, or as 403 carrying Retry-After (secondary limit) or x-ratelimit-remaining: 0 (primary limit).
// Headers only: the body is never read, so no upstream text can leak into logs or pages.
export function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) {
    return true;
  }
  if (status === 403) {
    if (headers.has('Retry-After')) {
      return true;
    }
    return headers.get('x-ratelimit-remaining') === '0';
  }
  return false;
}

// Honor GitHub's wait headers; without one, its guidance is to wait at least a minute. The result is clamped to rateLimitWaitMsMax.
export function retryAt(headers: Headers, now = Date.now()): number {
  const ceiling = now + rateLimitWaitMsMax;
  const retry = headers.get('Retry-After');
  if (retry) {
    const time = /^\d+$/.test(retry) ? now + Number(retry) * 1000 : /^[A-Za-z]{3}, /.test(retry) ? Date.parse(retry) : NaN;
    if (Number.isSafeInteger(time) && time > now) {
      return Math.min(time, ceiling);
    }
  }
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
  if (headers.get('x-ratelimit-remaining') === '0' && Number.isSafeInteger(reset) && reset > now) {
    return Math.min(reset, ceiling);
  }
  return now + rateLimitWaitMsDefault;
}

// Throws GitHubRateLimitError when the response is a limit; otherwise returns so the caller handles other failures.
export function throwIfRateLimited(response: Response): void {
  if (isRateLimited(response.status, response.headers)) {
    throw new GitHubRateLimitError(response.status, retryAt(response.headers));
  }
}
