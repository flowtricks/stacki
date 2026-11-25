// Goal: the small pieces every built-in provider shares: the rate-limited start page and the person it returns.
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import type { ProviderPerson, SignInRefusal } from '../authProvider';
import { loginPage } from '../loginPage';
import { clientKey, createRateLimiter, RATE_LIMITS, type RateLimiter } from './rateLimit';

export function signInLimiter(): RateLimiter {
  return createRateLimiter({ attemptsMax: RATE_LIMITS.signInAttemptsMax });
}

/** A sign-in page answering 429 with the wait, or undefined when this address may continue. */
export function limitedStart(limiter: RateLimiter, request: Request, displayName: string): Response | undefined {
  const waitMs = limiter.take(clientKey(request));
  if (waitMs === 0) {
    return undefined;
  }
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  const page = loginPage('rate-limit', 429, '', seconds, request.headers.get('Accept-Language'), displayName);
  page.headers.set('Retry-After', String(seconds));
  return page;
}

/** The refusal for a limited callback; core clamps `retryAtMs` and shows its own countdown. */
export function limitedRefusal(limiter: RateLimiter, request: Request, nowMs: number): SignInRefusal | undefined {
  const waitMs = limiter.take(clientKey(request));
  return waitMs === 0 ? undefined : { problem: 'rate-limit', retryAtMs: nowMs + waitMs };
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

/** `https` only: an avatar over any other scheme is dropped, not shown. */
export function httpsAvatar(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function nameFromEmail(email: string): string {
  return email.slice(0, email.indexOf('@')) || email;
}

/** A person for core to parse, with only the fields that are present (exactOptionalPropertyTypes). */
export function person(fields: {
  readonly identity: string;
  readonly name: string;
  readonly email?: string | undefined;
  readonly avatarUrl?: string | undefined;
}): Result<ProviderPerson, SignInRefusal> {
  return ok({
    identity: fields.identity,
    name: fields.name.slice(0, 100),
    ...(fields.email === undefined ? {} : { email: fields.email }),
    ...(fields.avatarUrl === undefined ? {} : { avatarUrl: fields.avatarUrl }),
  });
}

export function refuse(refusal: SignInRefusal): Result<ProviderPerson, SignInRefusal> {
  return err(refusal);
}
