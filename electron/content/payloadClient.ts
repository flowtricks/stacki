// Talking to one Payload server: the address, the account, and every request
// that carries them. Everything the Payload provider says to a server goes
// through `payloadRequest`, so the rules that keep a person out of trouble live
// in one place:
//
//   * a request has a timeout and a size cap on what it reads back;
//   * a redirect is reported, never followed (it would resend the credentials);
//   * a login is never retried in a loop. Payload locks an account for ten
//     minutes after five wrong passwords, so a failed login is remembered for a
//     while and answered from memory instead of being sent again;
//   * the login token lives in memory only: never on disk, never returned to
//     the renderer, never logged. The password stays in the encrypted
//     connection store and is read once per session;
//   * every failure is a `PayloadError` with a stable kind and a translatable
//     message, so the panel can tell "wrong password" from "locked" from "down".
//
// Observed against Payload 3.93 (docs/cms-testing.md).

import { assert } from '../../shared/core/assert';
import { described, type TypedMessageRef } from '../../shared/properties/i18n/messageRef';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { networkCode } from './cmsNetworkFailure';

export const PAYLOAD_LIMITS = {
  readTimeoutMs: 20_000,
  writeTimeoutMs: 30_000,
  uploadTimeoutMs: 120_000,
  /** A reply larger than this is not read: Payload's own answers are far smaller. */
  replyBytesMax: 24 * 1024 * 1024,
  uploadBytesMax: 50 * 1024 * 1024,
  /** A failed login is answered from memory for this long, so a wrong password is sent once, not in a loop. */
  loginBackoffMs: 60_000,
  /** A locked account stays locked for ten minutes; ask again after five. */
  lockedBackoffMs: 5 * 60_000,
  /** A token this close to its expiry is replaced before a request, not after it fails. */
  tokenMarginMs: 30_000,
  /**
   * An account is re-checked (`/me`) when it was last seen to work this long ago. Payload treats an expired,
   * revoked or disabled credential as an anonymous visitor: reads quietly return published content only, with no error.
   */
  identityRecheckMs: 120_000,
  /** The sessions kept at once (one per connection). */
  sessionsMax: 64,
} as const;

export type PayloadAuth = { readonly kind: 'apiKey'; readonly key: string } | { readonly kind: 'password'; readonly email: string; readonly password: string };

export interface PayloadTarget {
  /** The server root, no trailing slash. */
  readonly baseUrl: string;
  /** The auth collection the account belongs to. */
  readonly collection: string;
  readonly auth: PayloadAuth;
}

export type PayloadFailureKind =
  | 'badAddress'
  | 'forbidden'
  | 'invalid'
  | 'locked'
  | 'login'
  | 'loginPaused'
  | 'malformed'
  | 'network'
  | 'noUser'
  | 'notFound'
  | 'rateLimited'
  | 'redirect'
  | 'server'
  | 'timeout'
  | 'tooLarge'
  | 'tooLargeReply'
  | 'unauthorized';

/** A request Payload (or the network) did not complete: expected, shown to the person, never a crash. */
export class PayloadError extends Error {
  constructor(
    readonly failure: PayloadFailureKind,
    readonly status: number | undefined,
    readonly detail: Described,
  ) {
    super(detail.message);
    this.name = 'PayloadError';
  }

  get messageRef(): TypedMessageRef {
    return this.detail.messageRef;
  }
}

type Described = ReturnType<typeof described>;

export interface PayloadRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** The path under the server, from `/api/`, e.g. `/api/posts/7`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: unknown;
  readonly form?: FormData;
  readonly timeoutMs?: number;
}

/** What a session holds for one account on one server. */
class Session {
  token: string | undefined = undefined;
  expiresAtMs = 0;
  /** A login that failed, remembered until `until`, so it is not sent again at once. */
  failure: { readonly error: PayloadError; readonly until: number } | undefined = undefined;

  signedIn(token: string, expiresAtMs: number): void {
    this.token = token;
    this.expiresAtMs = expiresAtMs;
    this.failure = undefined;
  }

  refused(error: PayloadError, until: number): void {
    this.failure = { error, until };
  }

  forgetToken(): void {
    this.token = undefined;
  }
}

const sessions = new Map<string, Session>();
// When each account was last seen to be signed in, by session key.
const identityChecks = new Map<string, number>();

/** Forgets every login: a connection was removed, or a test starts clean. */
export function clearPayloadSessions(): void {
  sessions.clear();
  identityChecks.clear();
}

/** Forgets one account's login, e.g. after its connection was saved again with a new password. */
export function forgetPayloadSession(target: PayloadTarget): void {
  sessions.delete(sessionKey(target));
  identityChecks.delete(sessionKey(target));
}

function sessionKey(target: PayloadTarget): string {
  // i18n-ignore: Cache key, not interface text.
  return target.auth.kind === 'password' ? `${target.baseUrl}|${target.collection}|${target.auth.email}` : `${target.baseUrl}|${target.collection}|key`;
}

/**
 * The header value for a request: the API-key header, or the session's JWT. A
 * password connection logs in here when it holds no usable token, and not
 * again while a failed login is remembered.
 */
async function authorization(target: PayloadTarget, options: { readonly replace: 'token' | 'nothing' }): Promise<string> {
  if (target.auth.kind === 'apiKey') {
    assert(target.auth.key.length > 0, 'An API key is present');
    return `${target.collection} API-Key ${target.auth.key}`;
  }
  const key = sessionKey(target);
  let session = sessions.get(key);
  if (session === undefined) {
    assert(sessions.size < PAYLOAD_LIMITS.sessionsMax * 2, 'Sessions stay bounded');
    if (sessions.size >= PAYLOAD_LIMITS.sessionsMax) {
      sessions.clear();
    }
    session = new Session();
    sessions.set(key, session);
  }
  if (options.replace === 'token') {
    session.forgetToken();
  }
  const now = Date.now();
  if (session.token !== undefined && now < session.expiresAtMs - PAYLOAD_LIMITS.tokenMarginMs) {
    return `JWT ${session.token}`;
  }
  if (session.failure !== undefined && now < session.failure.until) {
    throw session.failure.error.failure === 'locked' ? session.failure.error : pausedLogin(session.failure.error);
  }
  const token = await login(target, session);
  return `JWT ${token}`;
}

// The same failure, said as "not tried again yet" when it is a repeat, so a second click on Test
// connection does not look like a second wrong password having been sent.
function pausedLogin(first: PayloadError): PayloadError {
  return new PayloadError('loginPaused', first.status, described('settings.cms.payload.error.loginPaused'));
}

async function login(target: PayloadTarget, session: Session): Promise<string> {
  assert(target.auth.kind === 'password', 'Only a password connection logs in');
  const { email, password } = target.auth;
  let body: unknown;
  try {
    body = await send(
      target,
      {
        method: 'POST',
        path: `/api/${target.collection}/login`,
        body: { email, password },
        timeoutMs: PAYLOAD_LIMITS.readTimeoutMs,
      },
      undefined,
    );
  } catch (error: unknown) {
    if (error instanceof PayloadError) {
      const mapped = loginFailure(error);
      const wait = mapped.failure === 'locked' ? PAYLOAD_LIMITS.lockedBackoffMs : PAYLOAD_LIMITS.loginBackoffMs;
      // A network failure is not a wrong password: remember only what Payload itself refused.
      if (mapped.failure === 'locked' || mapped.failure === 'login') {
        session.refused(mapped, Date.now() + wait);
      }
      throw mapped;
    }
    throw error;
  }
  const token = tokenOf(body);
  if (token === undefined) {
    throw new PayloadError('malformed', 200, described('settings.cms.payload.error.malformed', { address: target.baseUrl }));
  }
  session.signedIn(token.value, token.expiresAtMs);
  assert(token.value.length > 0, 'A session holds the token it logged in with');
  return token.value;
}

// A login answered with 401 is a wrong email or password, unless Payload says the account is locked.
function loginFailure(error: PayloadError): PayloadError {
  if (error.failure === 'locked') {
    return error;
  }
  if (error.failure === 'unauthorized') {
    return new PayloadError('login', error.status, described('settings.cms.payload.error.login'));
  }
  return error;
}

function tokenOf(body: unknown): { readonly value: string; readonly expiresAtMs: number } | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const token: unknown = Reflect.get(body, 'token');
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
    return undefined;
  }
  const exp: unknown = Reflect.get(body, 'exp');
  // `exp` is in seconds; a reply without one still logs in, for a short while.
  const expiresAtMs = typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : Date.now() + 5 * 60_000;
  return { value: token, expiresAtMs };
}

/**
 * One request, parsed. A 401 on a password connection logs in again once and
 * repeats the request (the token expired or was revoked); any other failure
 * is a `PayloadError`.
 */
export async function payloadRequest(target: PayloadTarget, request: PayloadRequest): Promise<unknown> {
  assert(request.path.startsWith('/api/'), 'A Payload request names an API path');
  assert(!target.baseUrl.endsWith('/'), 'A parsed address has no trailing slash');
  const first = await verifiedAuthorization(target, request);
  try {
    return await send(target, request, first);
  } catch (error: unknown) {
    // An expired login is an anonymous visitor to Payload: a write is a 403, a protected read a 403 or a 401.
    const refused = error instanceof PayloadError && (error.failure === 'unauthorized' || error.failure === 'forbidden');
    if (!refused || target.auth.kind !== 'password') {
      throw error;
    }
  }
  // The token was refused: log in again, once. A second refusal is final.
  const second = await authorization(target, { replace: 'token' });
  return send(target, request, second);
}

// The header for a request, after making sure the account is still signed in. Payload answers a request with an
// expired token, a revoked one, or a key that was switched off as if nobody were signed in (published content
// only, no error), so the account is looked at again from time to time, and a login that no longer works is
// renewed once (a password) or reported (a key).
async function verifiedAuthorization(target: PayloadTarget, request: PayloadRequest): Promise<string> {
  const header = await authorization(target, { replace: 'nothing' });
  const key = sessionKey(target);
  const last = identityChecks.get(key);
  const isMe = request.path === `/api/${target.collection}/me`;
  if (isMe || (last !== undefined && Date.now() - last < PAYLOAD_LIMITS.identityRecheckMs)) {
    return header;
  }
  if (await signedIn(target, header)) {
    identityChecks.set(key, Date.now());
    return header;
  }
  if (target.auth.kind === 'apiKey') {
    throw new PayloadError('noUser', 200, described('settings.cms.payload.error.noUser', { collection: target.collection }));
  }
  const renewed = await authorization(target, { replace: 'token' });
  if (!(await signedIn(target, renewed))) {
    throw new PayloadError('unauthorized', 200, described('settings.cms.payload.error.unauthorized'));
  }
  identityChecks.set(key, Date.now());
  return renewed;
}

async function signedIn(target: PayloadTarget, header: string): Promise<boolean> {
  const reply = await send(target, { method: 'GET', path: `/api/${target.collection}/me` }, header);
  const user: unknown = typeof reply === 'object' && reply !== null ? Reflect.get(reply, 'user') : undefined;
  return typeof user === 'object' && user !== null;
}

async function send(target: PayloadTarget, request: PayloadRequest, authorizationValue: string | undefined): Promise<unknown> {
  const url = `${target.baseUrl}${request.path}${queryString(request.query)}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authorizationValue !== undefined) {
    headers['Authorization'] = authorizationValue;
  }
  let body: string | FormData | undefined;
  if (request.form !== undefined) {
    body = request.form;
  } else if (request.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(request.body);
  }
  const timeoutMs = request.timeoutMs ?? (request.method === 'GET' ? PAYLOAD_LIMITS.readTimeoutMs : PAYLOAD_LIMITS.writeTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      // A redirect would resend the credentials to wherever it points; say so instead of following.
      redirect: 'manual',
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    throw networkError(error, target.baseUrl);
  }
  const text = await readReply(response, target);
  return judge(response, text, target, request);
}

function queryString(query: PayloadRequest['query']): string {
  if (query === undefined) {
    return '';
  }
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    parameters.append(name, String(value));
  }
  const text = parameters.toString();
  return text.length === 0 ? '' : `?${text}`;
}

// The reply as text, refusing one larger than the cap (by its header and while reading), and
// turning a connection cut mid-reply into the network failure it is.
async function readReply(response: Response, target: PayloadTarget): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PAYLOAD_LIMITS.replyBytesMax) {
    await response.body?.cancel().catch(() => undefined);
    throw new PayloadError('tooLargeReply', response.status, described('settings.cms.payload.error.tooLargeReply'));
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // Bounded by the byte cap: each pass adds at least one byte or ends the loop.
    for (let pass = 0; pass <= PAYLOAD_LIMITS.replyBytesMax; pass += 1) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > PAYLOAD_LIMITS.replyBytesMax) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadError('tooLargeReply', response.status, described('settings.cms.payload.error.tooLargeReply'));
      }
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    if (error instanceof PayloadError) {
      throw error;
    }
    throw networkError(error, target.baseUrl);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function judge(response: Response, text: string, target: PayloadTarget, request: PayloadRequest): unknown {
  const status = response.status;
  if (status >= 300 && status < 400) {
    const location = (response.headers.get('location') ?? 'another address').slice(0, 200);
    throw new PayloadError('redirect', status, described('settings.cms.payload.error.redirect', { address: target.baseUrl, location }));
  }
  if (status >= 200 && status < 300) {
    return parseReply(text, status, target);
  }
  throw failureFor(status, text, target, request);
}

function parseReply(text: string, status: number, target: PayloadTarget): unknown {
  if (text.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new PayloadError('malformed', status, described('settings.cms.payload.error.malformed', { address: target.baseUrl }));
  }
}

function failureFor(status: number, text: string, target: PayloadTarget, request: PayloadRequest): PayloadError {
  const detail = errorDetail(text);
  if (status === 401) {
    // A locked account says so in words; the status is the same as for a wrong password.
    if (detail !== undefined && /locked/i.test(detail)) {
      return new PayloadError('locked', status, described('settings.cms.payload.error.locked'));
    }
    return new PayloadError('unauthorized', status, described('settings.cms.payload.error.unauthorized'));
  }
  if (status === 403) {
    return new PayloadError('forbidden', status, described('settings.cms.payload.error.forbidden'));
  }
  if (status === 404) {
    // `/me` on a wrong address or collection is a 404 with a message-less body; a document is a plain not found.
    const address = `${target.baseUrl}${request.path}`;
    const probing = request.path === `/api/${target.collection}/me`;
    return probing
      ? new PayloadError('badAddress', status, described('settings.cms.payload.error.badAddress', { address }))
      : new PayloadError('notFound', status, described('settings.cms.payload.error.notFound'));
  }
  if (status === 413) {
    return new PayloadError('tooLarge', status, described('settings.cms.payload.error.tooLarge', { limit: '50 MB' }));
  }
  if (status === 429) {
    return new PayloadError('rateLimited', status, described('settings.cms.payload.error.rateLimited'));
  }
  if (status >= 500) {
    return new PayloadError('server', status, described('settings.cms.payload.error.server', { status }));
  }
  return new PayloadError('invalid', status, described('settings.cms.payload.error.invalid', { detail: (detail ?? `HTTP ${status}`).slice(0, 400) }));
}

/**
 * What Payload said was wrong, in its own words: validation errors name each field
 * (`Alt: This field is required.`); other errors have a single message.
 */
export function errorDetail(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const errors: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'errors') : undefined;
  if (!Array.isArray(errors)) {
    const message: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'message') : undefined;
    return typeof message === 'string' ? message.slice(0, 400) : undefined;
  }
  const first: unknown = errors[0];
  if (typeof first !== 'object' || first === null) {
    return undefined;
  }
  const field = fieldProblems(first);
  if (field !== undefined) {
    return field;
  }
  const message: unknown = Reflect.get(first, 'message');
  return typeof message === 'string' ? message.slice(0, 400) : undefined;
}

// `{ data: { errors: [{ label, message }] } }`, joined into one line.
function fieldProblems(error: object): string | undefined {
  const data: unknown = Reflect.get(error, 'data');
  const list: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'errors') : undefined;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const lines: string[] = [];
  for (const entry of list.slice(0, 5)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const label: unknown = Reflect.get(entry, 'label') ?? Reflect.get(entry, 'path');
    const message: unknown = Reflect.get(entry, 'message');
    if (typeof message === 'string') {
      lines.push(typeof label === 'string' ? `${label}: ${message}` : message);
    }
  }
  return lines.length === 0 ? undefined : lines.join(' ').slice(0, 400);
}

// A request that never got an answer, as the person should read it (cmsNetworkFailure.ts says the same in English).
function networkError(error: unknown, address: string): PayloadError {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new PayloadError('timeout', undefined, described('settings.cms.payload.error.timeout'));
  }
  const code = networkCode(error);
  if (code === 'ECONNREFUSED') {
    return new PayloadError('network', undefined, described('settings.cms.payload.error.refused', { address }));
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new PayloadError('network', undefined, described('settings.cms.payload.error.unresolved', { address }));
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return new PayloadError('network', undefined, described('settings.cms.payload.error.cutOff', { address }));
  }
  if (code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
    return new PayloadError('network', undefined, described('settings.cms.payload.error.wrongProtocol', { address }));
  }
  if (code !== undefined && CERTIFICATE_CODES.has(code)) {
    return new PayloadError('network', undefined, described('settings.cms.payload.error.certificate', { address, code }));
  }
  return new PayloadError('network', undefined, described('settings.cms.payload.error.network'));
}

const CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A server-relative address as an absolute one: Payload's upload `url` is `/api/media/file/x.png`. */
export function absoluteUrl(baseUrl: string, address: string): string {
  if (/^https?:\/\//i.test(address)) {
    return address;
  }
  return `${baseUrl}${address.startsWith('/') ? '' : '/'}${address}`;
}
