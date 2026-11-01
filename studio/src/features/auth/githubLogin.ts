import { githubIconPath } from '../../../vendor/stacki/src/ui/iconPaths';
import { stackiFavicon, stackiMarkPath } from '../../shared/stackiBrand';
import { parseProfile, type GitHubProfile } from './profile';
import { record, string } from '../../shared/validation';
import { cookie, sessionCookie, signSession, verifySession } from './session';
import { SignInFailure, signInMessages, signInStep, type SignInProblem } from './signInFailure';
import { retryAt } from './githubRateLimit';
import { loginWait, waitCookie } from './loginCooldown';
import { loginCountdown } from './loginCountdown';
import { loginLifetimeMs, type LoginAttempts } from './loginAttempts';

export interface AuthConfig {
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
  readonly SESSION_SECRET: string;
  readonly EDITOR_GITHUB_IDS: string;
  readonly STUDIO_ORIGIN: string;
}
export async function githubLogin(
  request: Request,
  config: AuthConfig,
  attempts: LoginAttempts,
  authorize: (profile: GitHubProfile) => Promise<boolean>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname === '/studio/auth/logout') {
    return logout(request, config);
  }
  if (!['/studio/auth/login', '/studio/auth/callback'].includes(url.pathname)) {
    return undefined;
  }
  if (request.method !== 'GET') {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'GET', 'Cache-Control': 'no-store' },
    });
  }
  if ((request.headers.get('Sec-Purpose') ?? request.headers.get('Purpose') ?? '').includes('prefetch')) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  const existing = await reuseLoginSession(request, config, authorize);
  if (existing) {
    return url.pathname === '/studio/auth/callback' ? completeAttempt(existing) : existing;
  }
  if (url.pathname === '/studio/auth/login') {
    const until = await loginWait(request, config.SESSION_SECRET);
    return until > Date.now() ? rateLimitedPage(until, config.SESSION_SECRET) : beginLogin(config);
  }
  const until = await loginWait(request, config.SESSION_SECRET);
  if (until > Date.now()) {
    return completeAttempt(await rateLimitedPage(until, config.SESSION_SECRET));
  }
  try {
    return completeAttempt(await finishLogin(request, config, attempts, authorize));
  } catch (error) {
    const failure = error instanceof SignInFailure ? error : new SignInFailure('unavailable');
    const { problem, stage, status, code } = failure;
    // Never log authorization codes, tokens, query strings, or upstream response bodies.
    console.error('GitHub sign-in failed', {
      problem,
      stage,
      status,
      code,
      retryAfterSeconds: Math.max(0, Math.ceil((failure.retryAt - Date.now()) / 1000)),
    });
    if (problem === 'rate-limit') {
      return completeAttempt(await rateLimitedPage(failure.retryAt, config.SESSION_SECRET));
    }
    return completeAttempt(loginPage(problem, ['expired', 'cancelled', 'email'].includes(problem) ? 400 : 503, `${stage}-${status}-${code}`));
  }
}

async function reuseLoginSession(request: Request, config: AuthConfig, authorize: (profile: GitHubProfile) => Promise<boolean>): Promise<Response | undefined> {
  const current = await verifySession(cookie(request, '__Host-studio'), config.SESSION_SECRET, 'studio');
  if (current) {
    if (await authorize(current)) {
      // Back, refresh, and a second callback should reuse an authorized session instead of OAuth.
      return new Response(null, {
        status: 302,
        headers: { Location: `${config.STUDIO_ORIGIN}/studio`, 'Cache-Control': 'no-store' },
      });
    }
  }
  return undefined;
}

async function finishLogin(request: Request, config: AuthConfig, attempts: LoginAttempts, authorize: (profile: GitHubProfile) => Promise<boolean>) {
  const url = new URL(request.url);
  const state = await verifySession(cookie(request, '__Host-studio-state'), config.SESSION_SECRET, 'login');
  if (!state || state.login !== url.searchParams.get('state')) {
    return loginPage('expired', 403);
  }
  if (url.searchParams.has('error')) {
    return loginPage('cancelled', 400);
  }
  const code = url.searchParams.get('code');
  if (!code) {
    return loginPage('expired', 400);
  }
  if (code.length > 1000) {
    return loginPage('expired', 400);
  }
  const result = await attempts.run(state.login, state.expires, () => completeLogin(code, config, authorize));
  if (result.ok) {
    return result.value;
  }
  switch (result.error) {
    case 'expired':
      return loginPage('expired', 400);
    case 'capacity':
      return loginPage('unavailable', 503, 'callback-attempt-capacity');
  }
}

async function completeLogin(code: string, config: AuthConfig, authorize: (profile: GitHubProfile) => Promise<boolean>) {
  const token = await signInStep('token', () => exchangeCode(code, config));
  const profile = await signInStep('profile', () => fetchProfile(token));
  if (!(await signInStep('repository', () => authorize(profile)))) {
    return loginPage('access', 403);
  }
  const session = await signInStep('session', () => signSession({ ...profile, expires: Date.now() + 28_800_000, audience: 'studio' }, config.SESSION_SECRET));
  const headers = new Headers({
    Location: `${config.STUDIO_ORIGIN}/studio`,
    'Cache-Control': 'no-store',
  });
  headers.append('Set-Cookie', sessionCookie('__Host-studio', session, 28_800));
  return new Response(null, { status: 302, headers });
}
async function fetchProfile(token: string) {
  const profileResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Astro-Studio',
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!profileResponse.ok) {
    if (profileResponse.status === 429) {
      throw new SignInFailure('rate-limit', 'profile', 429, 'http', retryAt(profileResponse.headers));
    }
    throw new SignInFailure('unavailable', 'profile', profileResponse.status, 'http');
  }
  return parseProfile(await profileResponse.json());
}
export function loginPage(problem?: SignInProblem, status = 200, reference = '', seconds = 0): Response {
  const message = problem ? signInMessages[problem] : 'Sign in to edit and publish your website.';
  const countdown = loginCountdown(seconds);
  const detail = reference ? `<p>Reference: ${reference.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}</p>` : '';
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Stacki Studio</title>
<link rel="icon" type="image/svg+xml" href="${stackiFavicon}">
<style>
body{background:#111;color:#eee;font:14px system-ui;display:grid;place-items:center;
  min-height:100dvh;margin:0}
main{text-align:center;max-width:32rem;padding:24px}
.studio-logo{display:block;margin:0 auto 24px}
a{display:inline-flex;align-items:center;justify-content:center;gap:10px;background:#eee;
  color:#111;border-radius:8px;padding:12px 20px;text-decoration:none;margin:20px 0}
a svg{flex-shrink:0}
p{color:#999;line-height:1.6}
</style>
</head>
<body><main>
<svg class="studio-logo" width="48" height="48" viewBox="0 0 458 458"
  role="img" aria-label="Stacki">
  <path d="${stackiMarkPath}" fill="currentColor" />
</svg>
<h1>${problem ? 'Unable to sign in' : 'Welcome to your studio'}</h1>
<p id="login-message">${message}${countdown.markup}</p>
<a href="/studio/auth/login">
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="${githubIconPath}" fill="currentColor" />
  </svg>
  <span>Sign in with GitHub</span>
</a>${detail}
</main>${countdown.script}</body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'" + countdown.policy,
      },
    },
  );
}

async function exchangeCode(code: string, config: AuthConfig) {
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Stacki-Studio',
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${config.STUDIO_ORIGIN}/studio/auth/callback`,
    }),
  });
  if (!tokenResponse.ok) {
    if (tokenResponse.status === 429) {
      reportTokenLimit(tokenResponse);
      throw new SignInFailure('rate-limit', 'token', 429, 'http', retryAt(tokenResponse.headers));
    }
    throw new SignInFailure('unavailable', 'token', tokenResponse.status, 'http');
  }
  const data = record(await tokenResponse.json());
  if (data['error'] === 'bad_verification_code') {
    throw new SignInFailure('expired', 'token', tokenResponse.status, 'bad_verification_code');
  }
  if (['incorrect_client_credentials', 'redirect_uri_mismatch'].includes(String(data['error']))) {
    throw new SignInFailure('configuration', 'token', tokenResponse.status, 'credentials_or_callback');
  }
  if (data['error'] === 'unverified_user_email') {
    throw new SignInFailure('email', 'token', tokenResponse.status, 'unverified_user_email');
  }
  if (data['error'] || typeof data['access_token'] !== 'string' || !data['access_token']) {
    throw new SignInFailure('unavailable', 'token', tokenResponse.status, data['error'] ? 'provider_error' : 'missing_token');
  }
  return string(data['access_token'], 1000);
}

async function beginLogin(config: AuthConfig) {
  const state = crypto.randomUUID();
  const signed = await signSession({ id: 1, login: state, expires: Date.now() + loginLifetimeMs, audience: 'login' }, config.SESSION_SECRET);
  const destination = new URL('https://github.com/login/oauth/authorize');
  destination.searchParams.set('client_id', config.GITHUB_CLIENT_ID);
  destination.searchParams.set('redirect_uri', `${config.STUDIO_ORIGIN}/studio/auth/callback`);
  destination.searchParams.set('state', state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: destination.href,
      'Set-Cookie': sessionCookie('__Host-studio-state', signed, 600),
      'Cache-Control': 'no-store',
    },
  });
}

async function rateLimitedPage(until: number, secret: string) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  const response = loginPage('rate-limit', 429, '', seconds);
  response.headers.set('Retry-After', String(seconds));
  response.headers.append('Set-Cookie', await waitCookie(until, secret));
  return response;
}

export function logout(request: Request, config: AuthConfig) {
  if (request.method !== 'POST' || request.headers.get('Origin') !== config.STUDIO_ORIGIN) {
    return new Response('Invalid sign-out request', { status: 403 });
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${config.STUDIO_ORIGIN}/studio`,
      'Set-Cookie': sessionCookie('__Host-studio', '', 0),
      'Cache-Control': 'no-store',
    },
  });
}

function completeAttempt(response: Response): Response {
  // A callback code is single-use. Refresh must never exchange the failed code again.
  response.headers.append('Set-Cookie', sessionCookie('__Host-studio-state', '', 0));
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function reportTokenLimit(response: Response): void {
  // Only fixed, bounded diagnostic headers; never log credentials or provider bodies.
  const names = [
    'x-github-request-id',
    'retry-after',
    'x-ratelimit-resource',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'server',
    'content-type',
  ];
  console.error(
    'GitHub token limit',
    Object.fromEntries(names.map((name) => [name, (response.headers.get(name) ?? '').replace(/[^a-zA-Z0-9:;=., /_-]/g, '').slice(0, 120)])),
  );
}
