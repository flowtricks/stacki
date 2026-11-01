// Goal: GitHub login preserves authorization, cooldown, and single-use callback boundaries.
// Method: use signed requests and counted upstream stubs without real credentials.
import { waitCookie } from '../src/features/auth/loginCooldown';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubLogin as handleLogin, type AuthConfig } from '../src/features/auth/githubLogin';
import type { GitHubProfile } from '../src/features/auth/profile';
import { loginAttemptFixture } from './loginAttemptFixture';
import { signSession, verifySession } from '../src/features/auth/session';
import { retryAt } from '../src/features/auth/githubRateLimit';

const attempts = loginAttemptFixture().create();
function githubLogin(request: Request, configuration: AuthConfig, authorize: (profile: GitHubProfile) => Promise<boolean>) {
  return handleLogin(request, configuration, attempts, authorize);
}

const config = {
  GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-secret',
  SESSION_SECRET: 's'.repeat(32),
  EDITOR_GITHUB_IDS: '',
  STUDIO_ORIGIN: 'https://studio.test',
};
async function callback(query = 'code=test-code') {
  const begin = await githubLogin(new Request(config.STUDIO_ORIGIN + '/studio/auth/login'), config, async () => false);
  assert.ok(begin);
  const location = begin.headers.get('Location');
  assert.ok(location);
  const state = new URL(location).searchParams.get('state');
  assert.ok(state);
  return new Request(`${config.STUDIO_ORIGIN}/studio/auth/callback?state=${state}&${query}`, {
    headers: { Cookie: (begin.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '' },
  });
}

test('GitHub HTTP 200 token errors show a fresh sign-in link without creating a session', async (t) => {
  for (const [error, status, message] of [
    ['bad_verification_code', 400, 'expired or was already used'],
    ['incorrect_client_credentials', 503, 'site owner'],
    ['redirect_uri_mismatch', 503, 'callback URL'],
    ['unknown_error', 503, 'temporarily unavailable'],
    ['unverified_user_email', 400, 'verify your primary email'],
  ] as const) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error, error_description: '<secret>' }));
    const response = await githubLogin(await callback(), config, async () => assert.fail('Must not authorize'));
    assert.ok(response);
    assert.equal(response.status, status);
    const html = await response.text();
    assert.ok(html.includes(message));
    assert.ok(html.includes('href="/studio/auth/login"'));
    assert.ok(!html.includes('<secret>'));
    assert.match(response.headers.get('Set-Cookie') ?? '', /__Host-studio-state=;.*Max-Age=0/);
    t.mock.restoreAll();
  }
});

test('rate limiting honors GitHub wait time and blocks repeated exchanges until it expires', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_input: string, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).get('User-Agent'), 'Stacki-Studio');
    return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '120' } });
  });
  const response = await githubLogin(await callback(), config, async () => true);
  assert.ok(response);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '120');
  assert.match(await response.text(), /Wait at least 120 seconds/);
  const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
  assert.ok(cookie);
  const token = cookie.slice(cookie.indexOf('=') + 1);
  assert.equal(await verifySession(token, config.SESSION_SECRET, 'studio'), undefined);
  assert.equal(await verifySession(token, config.SESSION_SECRET, 'preview'), undefined);
  for (const path of ['/studio/auth/login', '/studio/auth/callback?code=same-code']) {
    const blocked = await githubLogin(new Request(config.STUDIO_ORIGIN + path, { headers: { Cookie: cookie } }), config, async () => true);
    assert.equal(blocked?.status, 429);
  }
  assert.equal(calls, 1);
  now += 120_001;
  const retry = await githubLogin(new Request(config.STUDIO_ORIGIN + '/studio/auth/login', { headers: { Cookie: cookie } }), config, async () => true);
  assert.equal(retry?.status, 302);
  assert.ok(retry?.headers.get('Location')?.startsWith('https://github.com/login/oauth/authorize?'));
});

test('valid existing studio sessions do not mint another GitHub token', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Must reuse the signed-in session'));
  const token = await signSession({ id: 123, login: 'editor', audience: 'studio', expires: Date.now() + 60_000 }, config.SESSION_SECRET);
  const response = await githubLogin(
    new Request(config.STUDIO_ORIGIN + '/studio/auth/login', {
      headers: { Cookie: '__Host-studio=' + token },
    }),
    config,
    async () => true,
  );
  assert.equal(response?.headers.get('Location'), config.STUDIO_ORIGIN + '/studio');
});

test('GitHub cooldown accepts seconds or dates, honors reset, and defaults to a minute', () => {
  const now = 1_000_000;
  assert.equal(retryAt(new Headers({ 'Retry-After': '120' }), now), now + 120_000);
  assert.equal(retryAt(new Headers({ 'Retry-After': new Date(now + 120_000).toUTCString() }), now), now + 120_000);
  assert.equal(retryAt(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1400' }), now), 1_400_000);
  for (const retry of ['', '-1', 'not-a-date']) {
    assert.equal(retryAt(new Headers({ 'Retry-After': retry }), now), now + 60_000);
  }
});

test('failure diagnostics identify the stage without exposing tokens or upstream bodies', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  t.mock.method(globalThis, 'fetch', async (input: string) =>
    input.endsWith('/user') ? new Response('private provider response', { status: 403 }) : Response.json({ access_token: 'private-token' }),
  );
  const profileError = await githubLogin(await callback(), config, async () => true);
  assert.match((await profileError?.text()) ?? '', /profile-403-http/);
  t.mock.method(globalThis, 'fetch', async (input: string) =>
    Response.json(input.endsWith('/user') ? { id: 123, login: 'editor' } : { access_token: 'private-token' }),
  );
  const repositoryError = await githubLogin(await callback(), config, async () => {
    throw new Error('private repository details');
  });
  assert.match((await repositoryError?.text()) ?? '', /repository-0-unexpected/);
  assert.ok(!JSON.stringify(logs).includes('private'));
});

test('missing state and cancelled authorization fail closed before token exchange', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Must not exchange code'));
  for (const request of [new Request(config.STUDIO_ORIGIN + '/studio/auth/callback?code=test'), await callback('error=access_denied')]) {
    const response = await githubLogin(request, config, async () => assert.fail('Must not authorize'));
    assert.ok(response);
    assert.ok(response.status >= 400);
    assert.match(response.headers.get('Set-Cookie') ?? '', /__Host-studio-state=;.*Max-Age=0/);
    assert.match(await response.text(), /Sign in with GitHub/);
  }
});

test('transport failures offer a retry and do not reveal upstream error details', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('private upstream details');
  });
  const response = await githubLogin(await callback(), config, async () => false);
  assert.ok(response);
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.match(html, /temporarily unavailable/);
  assert.ok(!html.includes('private upstream details'));
});

test('only a verified GitHub profile with repository write access receives a session', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string) =>
    Response.json(input.endsWith('/user') ? { id: 123, login: 'editor' } : { access_token: 'test-token' }),
  );
  const denied = await githubLogin(await callback(), config, async () => false);
  assert.equal(denied?.status, 403);
  assert.match(denied?.headers.get('Set-Cookie') ?? '', /__Host-studio-state=;.*Max-Age=0/);
  const allowed = await githubLogin(await callback(), config, async (profile) => {
    assert.deepEqual(profile, { id: 123, login: 'editor' });
    return true;
  });
  assert.equal(allowed?.status, 302);
  assert.equal(allowed?.headers.get('Location'), config.STUDIO_ORIGIN + '/studio');
  assert.match(allowed?.headers.get('Set-Cookie') ?? '', /__Host-studio=.+HttpOnly; Secure/);
});

test('an authorized existing session can return to Studio during an OAuth cooldown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Do not retry GitHub OAuth'));
  const token = await signSession({ id: 123, login: 'editor', audience: 'studio', expires: Date.now() + 600_000 }, config.SESSION_SECRET);
  const wait = await waitCookie(Date.now() + 300_000, config.SESSION_SECRET);
  const request = new Request(config.STUDIO_ORIGIN + '/studio/auth/login', {
    headers: { Cookie: '__Host-studio=' + token + '; ' + wait.split(';')[0] },
  });
  const allowed = await githubLogin(request, config, async () => true);
  assert.equal(allowed?.status, 302);
  assert.equal(allowed?.headers.get('Location'), config.STUDIO_ORIGIN + '/studio');
  const denied = await githubLogin(request, config, async () => false);
  assert.equal(denied?.status, 429);
});

test('refreshing a throttled callback after the wait cannot reuse its code', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(null, { status: 429, headers: { 'Retry-After': '300' } });
  });
  const request = await callback();
  const response = await githubLogin(request, config, async () => true);
  assert.ok(response);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some((value) => value.startsWith('__Host-studio-state=;') && value.includes('Max-Age=0')));
  const wait = cookies.find((value) => value.startsWith('__Host-studio-login-wait='));
  assert.ok(wait);
  now += 300_001;
  const refreshed = await githubLogin(
    new Request(request.url, {
      headers: { Cookie: wait.split(';')[0] ?? '' },
    }),
    config,
    async () => assert.fail('No session without a new sign-in'),
  );
  assert.equal(refreshed?.status, 403);
  assert.match((await refreshed?.text()) ?? '', /Start a new GitHub sign-in/);
  assert.equal(calls, 1);
});

test('a callback opened during an existing wait clears its old state without contacting GitHub', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Must honor the existing wait'));
  const request = await callback();
  const wait = await waitCookie(Date.now() + 300_000, config.SESSION_SECRET);
  const response = await githubLogin(
    new Request(request.url, {
      headers: { Cookie: request.headers.get('Cookie') + '; ' + wait.split(';')[0] },
    }),
    config,
    async () => false,
  );
  assert.equal(response?.status, 429);
  assert.ok(response?.headers.getSetCookie().some((value) => value.startsWith('__Host-studio-state=;') && value.includes('Max-Age=0')));
});
