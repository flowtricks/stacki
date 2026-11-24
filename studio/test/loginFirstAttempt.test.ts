// Goal: Studio's own behaviour can never be the reason a first GitHub sign-in is told to wait. A first attempt makes
// exactly one token exchange and one profile read, opening the sign-in page calls GitHub zero times, nothing retries,
// no limiter state is shared between visitors, and when GitHub does limit, the page says which step and which signal.
// Method: a fake GitHub that counts every request and answers 429 to any token exchange after the first within its
// window (the strictest limiter we could meet). Each test drives core's real sign-in flow (githubLogin) with fresh
// login-attempt storage; no real credentials, no network.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { githubLogin, type AuthConfig } from '../src/features/auth/githubLogin';
import { REFERENCE_HEADER } from '../src/features/auth/authRoutes';
import { limitSignal } from '../src/features/auth/githubRateLimit';
import { loginAttemptFixture } from './loginAttemptFixture';

const config: AuthConfig = {
  GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-secret',
  SESSION_SECRET: 's'.repeat(32),
  EDITOR_GITHUB_IDS: '',
  STUDIO_ORIGIN: 'https://studio.test',
};
const allow = async () => true;

interface FakeGitHub {
  readonly calls: { token: number; profile: number; other: number };
}

// One token exchange per window is allowed; a second one inside it is refused, the way a strict GitHub limit would.
function fakeGitHub(t: TestContext, tokenAnswer?: () => Response, profileAnswer?: () => Response): FakeGitHub {
  const calls = { token: 0, profile: 0, other: 0 };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      calls.token++;
      if (tokenAnswer) {
        return tokenAnswer();
      }
      return calls.token > 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '300' } }) : Response.json({ access_token: 'user-token' });
    }
    if (url === 'https://api.github.com/user') {
      calls.profile++;
      return profileAnswer ? profileAnswer() : Response.json({ id: 7, login: 'designer' });
    }
    calls.other++;
    return new Response(null, { status: 404 });
  });
  return { calls };
}

async function begin(attempts: ReturnType<ReturnType<typeof loginAttemptFixture>['create']>, headers: Record<string, string> = {}) {
  const response = await githubLogin(new Request(config.STUDIO_ORIGIN + '/studio/auth/login', { headers }), config, attempts, allow);
  assert.ok(response);
  return response;
}

async function callbackFor(attempts: ReturnType<ReturnType<typeof loginAttemptFixture>['create']>, headers: Record<string, string> = {}) {
  const started = await begin(attempts, headers);
  assert.equal(started.status, 302);
  const state = new URL(started.headers.get('Location') ?? '').searchParams.get('state');
  assert.ok(state);
  const stateCookie = (started.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  return new Request(`${config.STUDIO_ORIGIN}/studio/auth/callback?state=${state}&code=one-time-code`, { headers: { ...headers, Cookie: stateCookie } });
}

test('opening the sign-in page calls GitHub zero times and needs a click to start', async (t) => {
  const github = fakeGitHub(t);
  const attempts = loginAttemptFixture().create();
  for (let i = 0; i < 5; i++) {
    const page = await begin(attempts);
    assert.equal(page.status, 302);
    assert.match(page.headers.get('Location') ?? '', /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  }
  // A browser prefetch of the button never starts a sign-in either.
  const prefetch = await githubLogin(
    new Request(config.STUDIO_ORIGIN + '/studio/auth/login', { headers: { 'Sec-Purpose': 'prefetch' } }),
    config,
    attempts,
    allow,
  );
  assert.equal(prefetch?.status, 204);
  assert.deepEqual(github.calls, { token: 0, profile: 0, other: 0 });
});

test('a first attempt makes one token exchange and one profile read, and is never told to wait', async (t) => {
  const github = fakeGitHub(t);
  const attempts = loginAttemptFixture().create();
  const response = await githubLogin(await callbackFor(attempts), config, attempts, allow);
  assert.equal(response?.status, 302);
  assert.equal(response?.headers.get('Location'), config.STUDIO_ORIGIN + '/studio');
  assert.ok(response?.headers.getSetCookie().some((value) => value.startsWith('__Host-studio=')));
  assert.ok(!response?.headers.getSetCookie().some((value) => value.startsWith('__Host-studio-login-wait=')));
  assert.deepEqual(github.calls, { token: 1, profile: 1, other: 0 });
});

test('a doubled callback (refresh, two tabs, a racing redirect) shares one token exchange', async (t) => {
  const github = fakeGitHub(t);
  const attempts = loginAttemptFixture().create();
  const request = await callbackFor(attempts);
  const answers = await Promise.all([0, 1, 2].map(() => githubLogin(request.clone(), config, attempts, allow)));
  for (const answer of answers) {
    assert.equal(answer?.status, 302);
  }
  assert.equal(github.calls.token, 1);
  // Refreshing the finished callback afterwards does not exchange the used code again.
  const refreshed = await githubLogin(request.clone(), config, attempts, allow);
  assert.notEqual(refreshed?.status, 429);
  assert.equal(github.calls.token, 1);
});

test('no limiter is shared across visitors: many first sign-ins from one address all pass', async (t) => {
  // Every visitor of a Worker can arrive from the same address (an office, a VPN); core keeps no per-address or global
  // counter for GitHub sign-in, so only GitHub itself can ever refuse one.
  let exchanges = 0;
  fakeGitHub(t, () => {
    exchanges++;
    return Response.json({ access_token: `token-${exchanges}` });
  });
  const attempts = loginAttemptFixture().create();
  const visitorsMax = 40;
  for (let visitor = 0; visitor < visitorsMax; visitor++) {
    const response = await githubLogin(await callbackFor(attempts, { 'CF-Connecting-IP': '203.0.113.9' }), config, attempts, allow);
    assert.equal(response?.status, 302, `visitor ${visitor} signs in`);
  }
  assert.equal(exchanges, visitorsMax);
});

test("one visitor's wait never blocks another visitor", async (t) => {
  const github = fakeGitHub(t, () => new Response(null, { status: 429, headers: { 'Retry-After': '300' } }));
  const attempts = loginAttemptFixture().create();
  const limited = await githubLogin(await callbackFor(attempts), config, attempts, allow);
  assert.equal(limited?.status, 429);
  const waitCookie = limited?.headers.getSetCookie().find((value) => value.startsWith('__Host-studio-login-wait='));
  assert.ok(waitCookie, 'the wait lives in the limited visitor’s own signed cookie');
  // The same browser waits; a different browser (no cookie) starts a sign-in at once.
  const sameBrowser = await begin(attempts, { Cookie: waitCookie.split(';')[0] ?? '' });
  assert.equal(sameBrowser.status, 429);
  const otherBrowser = await begin(attempts);
  assert.equal(otherBrowser.status, 302);
  assert.equal(github.calls.token, 1, 'nothing retried the limited exchange');
});

test('a GitHub limit is never retried, and the page names the step and the signal', async (t) => {
  for (const [label, token, profile, reference, seconds] of [
    ['bare 429 at the token step', () => new Response(null, { status: 429 }), undefined, 'token-429-status', 60],
    ['secondary limit at the token step', () => new Response(null, { status: 403, headers: { 'Retry-After': '295' } }), undefined, 'token-403-retry-after', 295],
    [
      'exhausted quota at the profile step',
      undefined,
      () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) } }),
      'profile-403-quota',
      120,
    ],
  ] as const) {
    const github = fakeGitHub(t, token, profile);
    const attempts = loginAttemptFixture().create();
    const response = await githubLogin(await callbackFor(attempts), config, attempts, allow);
    assert.equal(response?.status, 429, label);
    assert.equal(response?.headers.get(REFERENCE_HEADER), reference, label);
    const retry = Number(response?.headers.get('Retry-After'));
    assert.ok(retry >= seconds - 1 && retry <= seconds, `${label}: waits what GitHub said (${retry})`);
    const html = (await response?.text()) ?? '';
    assert.match(html, /<a id="login-button" [^>]*aria-disabled="true"/, `${label}: the button is disabled while waiting`);
    assert.match(html, /Try again in \d+:\d\d/, label);
    assert.ok(github.calls.token <= 1, `${label}: one exchange at most`);
    assert.ok(github.calls.profile <= 1, `${label}: one profile read at most`);
    t.mock.restoreAll();
  }
});

test('a successful or non-limit answer never carries a wait or a limit reference', async (t) => {
  fakeGitHub(t, () => Response.json({ error: 'bad_verification_code' }));
  const attempts = loginAttemptFixture().create();
  const response = await githubLogin(await callbackFor(attempts), config, attempts, allow);
  assert.equal(response?.status, 400);
  assert.equal(response?.headers.get(REFERENCE_HEADER), null);
  assert.equal(response?.headers.get('Retry-After'), null);
  assert.doesNotMatch((await response?.text()) ?? '', /<a [^>]*aria-disabled/);
});

test('limit signals: Retry-After wins, then an exhausted quota, else the bare status', () => {
  assert.equal(limitSignal(new Headers({ 'Retry-After': '1', 'x-ratelimit-remaining': '0' })), 'retry-after');
  assert.equal(limitSignal(new Headers({ 'x-ratelimit-remaining': '0' })), 'quota');
  assert.equal(limitSignal(new Headers({ 'x-ratelimit-remaining': '1' })), 'status');
  assert.equal(limitSignal(new Headers()), 'status');
});
