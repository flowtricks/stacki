import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { Result } from '../../../vendor/stacki/shared/core/result';

export const loginAttemptsMax = 128;
export const loginLifetimeMs = 600_000;
export type LoginClaimResult = 'claimed' | 'used' | 'full';
export type LoginAttemptError = 'expired' | 'capacity';
export interface LoginClaim {
  readonly state: string;
  readonly expires: number;
}
export interface LoginClaimStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: readonly LoginClaim[]): Promise<void>;
}
interface LoginReply {
  readonly expires: number;
  readonly response: Promise<Result<LoginResponse, LoginAttemptError>>;
}
interface LoginResponse {
  readonly body: string | undefined;
  readonly headers: readonly (readonly [string, string])[];
  readonly status: number;
}
const loginResponseBytesMax = 16_384;
const loginResponseHeadersMax = 32;

export class LoginAttempts {
  private readonly replies = new Map<string, LoginReply>();

  constructor(private readonly claim: (state: string, expires: number) => Promise<LoginClaimResult>) {}

  async run(state: string, expires: number, action: () => Promise<Response>): Promise<Result<Response, LoginAttemptError>> {
    assert(validState(state), 'Login state must be a UUID');
    assert(validExpiry(expires, Date.now()), 'Login state must have a bounded expiry');
    if (expires <= Date.now()) {
      return { ok: false, error: 'expired' };
    }
    for (const [key, entry] of this.replies) {
      if (entry.expires <= Date.now()) {
        this.replies.delete(key);
      }
    }
    const existing = this.replies.get(state);
    if (existing) {
      return restoreLoginOutcome(await existing.response);
    }
    if (this.replies.size >= loginAttemptsMax) {
      return { ok: false, error: 'capacity' };
    }
    // Publish the promise before yielding so parallel callbacks share even failed exchanges.
    const response = this.runClaimed(state, expires, action);
    this.replies.set(state, { expires, response });
    return restoreLoginOutcome(await response);
  }

  private async runClaimed(state: string, expires: number, action: () => Promise<Response>): Promise<Result<LoginResponse, LoginAttemptError>> {
    const result = await this.claim(state, expires);
    switch (result) {
      case 'claimed':
        return { ok: true, value: await snapshotLoginResponse(await action()) };
      case 'used':
        return { ok: false, error: 'expired' };
      case 'full':
        return { ok: false, error: 'capacity' };
    }
  }
}

// The caller must run this read/write pair inside a storage transaction.
export async function claimLoginAttempt(storage: LoginClaimStorage, state: string, expires: number): Promise<LoginClaimResult> {
  const now = Date.now();
  assert(validState(state), 'Login state must be a UUID');
  assert(validExpiry(expires, now), 'Login state must have a bounded expiry');
  if (expires <= now) {
    return 'used';
  }
  const claims = parseLoginClaims(await storage.get('auth/login-attempts'), now).filter((claim) => claim.expires > now);
  if (claims.some((claim) => claim.state === state)) {
    return 'used';
  }
  if (claims.length >= loginAttemptsMax) {
    return 'full';
  }
  // Persist consumption before contacting GitHub; a restart cannot replay a single-use code.
  await storage.put('auth/login-attempts', [...claims, { state, expires }]);
  return 'claimed';
}

export function parseLoginClaims(input: unknown, now: number): readonly LoginClaim[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new Error('Invalid stored login attempts');
  }
  if (input.length > loginAttemptsMax) {
    throw new Error('Stored login attempts exceed limit');
  }
  const values: readonly unknown[] = input;
  const states = new Set<string>();
  return values.map((value) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Invalid stored login attempt');
    }
    if (!('state' in value) || !validState(value.state)) {
      throw new Error('Invalid stored login state');
    }
    if (!('expires' in value) || !validExpiry(value.expires, now)) {
      throw new Error('Invalid stored login expiry');
    }
    if (states.has(value.state)) {
      throw new Error('Duplicate stored login state');
    }
    states.add(value.state);
    return { state: value.state, expires: value.expires };
  });
}

function validState(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validExpiry(value: unknown, now: number): value is number {
  if (typeof value !== 'number') {
    return false;
  }
  if (!Number.isSafeInteger(value)) {
    return false;
  }
  if (value <= 0) {
    return false;
  }
  return value <= now + loginLifetimeMs;
}

async function snapshotLoginResponse(response: Response): Promise<LoginResponse> {
  const body = response.body === null ? undefined : await response.text();
  const headers = [...response.headers.entries()];
  assert(new TextEncoder().encode(body ?? '').length <= loginResponseBytesMax, 'Login page exceeds limit');
  assert(headers.length <= loginResponseHeadersMax, 'Login response headers exceed limit');
  // Streams belong to a Worker request; cache bounded values and create a fresh response per caller.
  return { body, headers, status: response.status };
}

function restoreLoginOutcome(outcome: Result<LoginResponse, LoginAttemptError>): Result<Response, LoginAttemptError> {
  if (!outcome.ok) {
    return outcome;
  }
  const snapshot = outcome.value;
  assert(snapshot.headers.length <= loginResponseHeadersMax, 'Login response headers exceed limit');
  assert(new TextEncoder().encode(snapshot.body ?? '').length <= loginResponseBytesMax, 'Login page exceeds limit');
  const headers = new Headers();
  for (const [name, value] of snapshot.headers) {
    headers.append(name, value);
  }
  return { ok: true, value: new Response(snapshot.body, { status: snapshot.status, headers }) };
}
