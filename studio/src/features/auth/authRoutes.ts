// Goal: the sign-in routes, for whichever provider is installed. Core owns the flow; the provider fills two gaps.
//   GET  /studio/auth/login     core sets a one-time state cookie, the provider's `begin` answers
//   GET  /studio/auth/callback  core checks `state`, the provider's `identify` says who, core decides and signs
//   POST /studio/auth/logout    core clears the session
//   any  /studio/auth/provider/*  the provider's own extra steps, Studio origin only
// What stays here, and never moves into a provider: the CSRF state, the single-use callback claim, the
// cooldown after a rate limit, the edit policy check, the session cookie and every response header. The
// GitHub provider runs through exactly this flow, which is why its behaviour did not change.
import type { AuthRuntime } from './authRuntime';
import { mayEdit, mintSession, principalFromToken, SESSION_COOKIES } from './authRuntime';
import { field, parsePerson, parseRefusal, type SignInFlow, type SignInRefusal } from './authProvider';
import { loginPage } from './loginPage';
import { loginWait, waitCookie } from './loginCooldown';
import { loginLifetimeMs, type LoginAttempts } from './loginAttempts';
import { SESSION_LIFETIME_MS, SESSION_LIFETIME_SECONDS } from './principalSession';
import { cookie, sessionCookie, signSession, verifySession } from './session';
import { SignInFailure, signInStep } from './signInFailure';

export const AUTH_PATHS = {
  login: '/studio/auth/login',
  callback: '/studio/auth/callback',
  logout: '/studio/auth/logout',
  providerPrefix: '/studio/auth/provider/',
} as const;
const STATE_COOKIE = '__Host-studio-state';
const STATE_COOKIE_SECONDS = 600;
const PROVIDER_PATH_CHARS_MAX = 200;

/** The page-facing name of an installed provider; undefined for the built-in one, which keeps the GitHub page. */
export function installedProviderName(runtime: AuthRuntime): string | undefined {
  return runtime.installed === 'custom' ? runtime.provider.displayName : undefined;
}

export async function authRoutes(request: Request, runtime: AuthRuntime, attempts: LoginAttempts): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === AUTH_PATHS.logout) {
    return logout(request, runtime.origin);
  }
  if (url.pathname.startsWith(AUTH_PATHS.providerPrefix)) {
    return providerRoute(request, url, runtime);
  }
  if (url.pathname !== AUTH_PATHS.login && url.pathname !== AUTH_PATHS.callback) {
    return undefined;
  }
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
  }
  if ((request.headers.get('Sec-Purpose') ?? request.headers.get('Purpose') ?? '').includes('prefetch')) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  const existing = await reuseSession(request, runtime);
  if (existing) {
    return url.pathname === AUTH_PATHS.callback ? completeAttempt(existing) : existing;
  }
  const languages = request.headers.get('Accept-Language');
  const until = await loginWait(request, runtime.secret);
  if (url.pathname === AUTH_PATHS.login) {
    return until > Date.now() ? rateLimitedPage(runtime, until, languages) : beginSignIn(request, runtime);
  }
  if (until > Date.now()) {
    return completeAttempt(await rateLimitedPage(runtime, until, languages));
  }
  try {
    return completeAttempt(await finishSignIn(request, url, runtime, attempts));
  } catch (error) {
    // A programmer error or an unexpected throw inside core's own steps: never a stack trace on the page.
    const failure = error instanceof SignInFailure ? error : new SignInFailure('unavailable');
    return completeAttempt(
      await refusalPage(
        runtime,
        { problem: failure.problem, reference: `${failure.stage}-${failure.status}-${failure.code}`, retryAtMs: failure.retryAt },
        languages,
      ),
    );
  }
}

export function logout(request: Request, origin: string): Response {
  if (request.method !== 'POST' || request.headers.get('Origin') !== origin) {
    return new Response('Invalid sign-out request', { status: 403 });
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${origin}/studio`,
      'Set-Cookie': sessionCookie(SESSION_COOKIES.studio, '', 0),
      'Cache-Control': 'no-store',
    },
  });
}

async function reuseSession(request: Request, runtime: AuthRuntime): Promise<Response | undefined> {
  const principal = await principalFromToken(runtime, cookie(request, SESSION_COOKIES.studio), 'studio');
  // A signed session is already proof of an earlier sign-in, so a cached permission is enough and costs the provider nothing.
  if (principal && (await mayEdit(runtime, principal, 'cached'))) {
    // Back, refresh, and a second callback should reuse an authorized session instead of signing in again.
    return new Response(null, { status: 302, headers: { Location: `${runtime.origin}/studio`, 'Cache-Control': 'no-store' } });
  }
  return undefined;
}

async function beginSignIn(request: Request, runtime: AuthRuntime): Promise<Response> {
  const state = crypto.randomUUID();
  const signed = await signSession({ id: 1, login: state, expires: Date.now() + loginLifetimeMs, audience: 'login' }, runtime.secret);
  const flow = flowFor(runtime, state, request);
  let answer: Response;
  try {
    answer = await runtime.provider.begin(request, flow);
  } catch (error) {
    return providerFailure(runtime, 'begin', error, request.headers.get('Accept-Language'));
  }
  const checked = providerResponse(answer, runtime.origin);
  if (!checked.ok) {
    return providerFailure(runtime, 'begin', new Error(checked.reason), request.headers.get('Accept-Language'));
  }
  checked.response.headers.append('Set-Cookie', sessionCookie(STATE_COOKIE, signed, STATE_COOKIE_SECONDS));
  return checked.response;
}

async function providerRoute(request: Request, url: URL, runtime: AuthRuntime): Promise<Response | undefined> {
  if (runtime.provider.handle === undefined || url.pathname.length > PROVIDER_PATH_CHARS_MAX) {
    return undefined;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('Origin') !== runtime.origin) {
    return new Response('Invalid request origin', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const state = await verifySession(cookie(request, STATE_COOKIE), runtime.secret, 'login');
  if (!state) {
    return loginPage('expired', 403, '', 0, request.headers.get('Accept-Language'), installedProviderName(runtime));
  }
  let answer: Response | undefined;
  try {
    answer = await runtime.provider.handle(request, flowFor(runtime, state.login, request));
  } catch (error) {
    return providerFailure(runtime, 'handle', error, request.headers.get('Accept-Language'));
  }
  if (answer === undefined) {
    return undefined;
  }
  const checked = providerResponse(answer, runtime.origin);
  return checked.ok ? checked.response : providerFailure(runtime, 'handle', new Error(checked.reason), request.headers.get('Accept-Language'));
}

async function finishSignIn(request: Request, url: URL, runtime: AuthRuntime, attempts: LoginAttempts): Promise<Response> {
  const languages = request.headers.get('Accept-Language');
  const state = await verifySession(cookie(request, STATE_COOKIE), runtime.secret, 'login');
  if (!state || state.login !== url.searchParams.get('state')) {
    return loginPage('expired', 403, '', 0, languages ?? undefined, installedProviderName(runtime));
  }
  const result = await attempts.run(state.login, state.expires, () => completeSignIn(request, runtime, state.login));
  if (result.ok) {
    return result.value;
  }
  switch (result.error) {
    case 'expired':
      return loginPage('expired', 400, '', 0, languages ?? undefined, installedProviderName(runtime));
    case 'capacity':
      return loginPage('unavailable', 503, 'callback-attempt-capacity', 0, languages ?? undefined, installedProviderName(runtime));
  }
}

// Provider says who; core validates it, applies the edit policy, and only then signs. Any refusal, thrown error or
// malformed answer from the provider ends in a sign-in page and never in a session.
async function completeSignIn(request: Request, runtime: AuthRuntime, state: string): Promise<Response> {
  const languages = request.headers.get('Accept-Language');
  let answer: unknown;
  try {
    answer = await runtime.provider.identify(request, flowFor(runtime, state, request));
  } catch (error) {
    logRefusal(runtime, { problem: 'unavailable', reference: `identify-0-${errorName(error)}` });
    return refusalPage(runtime, { problem: 'unavailable', reference: `identify-0-${errorName(error)}` }, languages);
  }
  const outcome = typeof answer === 'object' && answer !== null ? answer : undefined;
  if (outcome === undefined || field(outcome, 'ok') !== true) {
    return refusalPage(runtime, parseRefusal(outcome === undefined ? undefined : field(outcome, 'error'), Date.now()), languages);
  }
  const person = parsePerson(field(outcome, 'value'), runtime.providerId);
  if (!person.ok) {
    // The provider broke the contract: log what was wrong (never the value) and refuse.
    console.error('Studio auth provider returned an invalid person', { provider: runtime.providerId, reason: person.error });
    return refusalPage(runtime, { problem: 'unavailable', reference: 'provider-invalid' }, languages);
  }
  const expires = Date.now() + SESSION_LIFETIME_MS;
  const principal = { ...person.value, expires };
  if (!(await signInStep('repository', () => mayEdit(runtime, principal, 'fresh')))) {
    return loginPage('access', 403, '', 0, languages ?? undefined, installedProviderName(runtime));
  }
  const session = await signInStep('session', () => mintSession(runtime, person.value, 'studio', expires));
  const headers = new Headers({ Location: `${runtime.origin}/studio`, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', sessionCookie(SESSION_COOKIES.studio, session, SESSION_LIFETIME_SECONDS));
  return new Response(null, { status: 302, headers });
}

function flowFor(runtime: AuthRuntime, state: string, request: Request): SignInFlow {
  return {
    callbackUrl: `${runtime.origin}${AUTH_PATHS.callback}`,
    state,
    languages: request.headers.get('Accept-Language') ?? undefined,
  };
}

// The sign-in page for a refusal, with the status each problem has always had.
async function refusalPage(runtime: AuthRuntime, refusal: SignInRefusal, languages: string | null | undefined): Promise<Response> {
  const name = installedProviderName(runtime);
  if (refusal.problem !== 'access') {
    logRefusal(runtime, refusal);
  }
  if (refusal.problem === 'rate-limit') {
    return rateLimitedPage(runtime, refusal.retryAtMs ?? Date.now(), languages ?? null);
  }
  if (refusal.problem === 'access') {
    return loginPage('access', 403, '', 0, languages ?? undefined, name);
  }
  const status = ['expired', 'cancelled', 'email'].includes(refusal.problem) ? 400 : 503;
  return loginPage(refusal.problem, status, refusal.reference ?? '', 0, languages ?? undefined, name);
}

async function rateLimitedPage(runtime: AuthRuntime, until: number, languages: string | null): Promise<Response> {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  const response = loginPage('rate-limit', 429, '', seconds, languages ?? undefined, installedProviderName(runtime));
  response.headers.set('Retry-After', String(seconds));
  response.headers.append('Set-Cookie', await waitCookie(until, runtime.secret));
  return response;
}

function providerFailure(runtime: AuthRuntime, step: string, error: unknown, languages: string | null): Response {
  console.error('Studio auth provider failed', { provider: runtime.providerId, step, error: errorName(error) });
  return loginPage('unavailable', 503, `${step}-0-${errorName(error)}`, 0, languages ?? undefined, installedProviderName(runtime));
}

function logRefusal(runtime: AuthRuntime, refusal: SignInRefusal): void {
  // Never log authorization codes, tokens, query strings, or upstream response bodies.
  console.error(`${runtime.provider.displayName} sign-in failed`, {
    problem: refusal.problem,
    reference: refusal.reference ?? '',
    retryAfterSeconds: Math.max(0, Math.ceil(((refusal.retryAtMs ?? 0) - Date.now()) / 1000)),
  });
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unexpected';
}

function completeAttempt(response: Response): Response {
  // A callback code is single-use. Refresh must never exchange the failed code again.
  response.headers.append('Set-Cookie', sessionCookie(STATE_COOKIE, '', 0));
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

type CheckedResponse = { readonly ok: true; readonly response: Response } | { readonly ok: false; readonly reason: string };

// A provider's response is rebuilt, not trusted: no cookies from it, no caching, and a redirect only to https (or
// localhost, for development). It cannot set the session cookie or any other cookie, because it never gets to.
function providerResponse(answer: unknown, origin: string): CheckedResponse {
  if (!(answer instanceof Response)) {
    return { ok: false, reason: 'not-a-response' };
  }
  if (answer.status < 200 || answer.status > 599 || answer.status === 101) {
    return { ok: false, reason: 'bad-status' };
  }
  const headers = new Headers(answer.headers);
  headers.delete('Set-Cookie');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  }
  if (answer.status >= 300 && answer.status < 400) {
    const location = headers.get('Location') ?? '';
    if (!safeRedirect(location, origin)) {
      return { ok: false, reason: 'bad-redirect' };
    }
  }
  return { ok: true, response: new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers }) };
}

function safeRedirect(location: string, origin: string): boolean {
  try {
    const target = new URL(location, origin);
    return target.protocol === 'https:' || (target.protocol === 'http:' && (target.hostname === 'localhost' || target.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}
