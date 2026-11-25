// Goal: one browser sign-in cannot exchange the same OAuth authorization more than once.
// Method: replay a signed callback concurrently and after completion against a counted GitHub stub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubLogin } from '../src/features/auth/githubLogin';
import { signSession } from '../src/features/auth/session';
import { loginAttemptFixture } from './loginAttemptFixture';

const config = {
  GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-secret',
  SESSION_SECRET: 's'.repeat(32),
  EDITOR_GITHUB_IDS: '',
  STUDIO_ORIGIN: 'https://studio.test',
};

test('concurrent and repeated callbacks perform only one token exchange', async (context) => {
  const attempts = loginAttemptFixture().create();
  let exchanges = 0;
  context.mock.method(globalThis, 'fetch', async (input: string) => {
    if (input.endsWith('/access_token')) {
      exchanges++;
      return Response.json({ access_token: 'test-token' });
    }
    return Response.json({ id: 123, login: 'editor' });
  });
  const state = crypto.randomUUID();
  const signed = await signSession({ id: 1, login: state, audience: 'login', expires: Date.now() + 600_000 }, config.SESSION_SECRET);
  const request = new Request(`${config.STUDIO_ORIGIN}/studio/auth/callback?state=${state}&code=one`, {
    headers: { Cookie: '__Host-studio-state=' + signed },
  });
  const responses = await Promise.all([githubLogin(request, config, attempts, async () => true), githubLogin(request, config, attempts, async () => true)]);
  assert.equal(responses[0]?.status, 302);
  assert.equal(responses[1]?.status, 302);
  assert.equal(exchanges, 1);
  const replay = await githubLogin(request, config, attempts, async () => true);
  assert.equal(replay?.status, 302);
  assert.equal(exchanges, 1);
});

test('HEAD requests and browser prefetches cannot begin or complete sign-in', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => assert.fail('No GitHub request'));
  const attempts = loginAttemptFixture().create();
  for (const pathname of ['/studio/auth/login', '/studio/auth/callback']) {
    const url = config.STUDIO_ORIGIN + pathname;
    for (const method of ['HEAD', 'POST', 'OPTIONS']) {
      const response = await githubLogin(new Request(url, { method }), config, attempts, async () => assert.fail('No authorization lookup'));
      assert.equal(response?.status, 405);
      assert.equal(response?.headers.get('Set-Cookie'), null);
    }
    for (const header of ['Sec-Purpose', 'Purpose']) {
      const response = await githubLogin(new Request(url, { headers: { [header]: 'prefetch' } }), config, attempts, async () =>
        assert.fail('No authorization lookup'),
      );
      assert.equal(response?.status, 204);
      assert.equal(response?.headers.get('Set-Cookie'), null);
    }
  }
});

test('an old callback reuses an authorized session without another OAuth exchange', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => assert.fail('No OAuth request'));
  const session = await signSession({ id: 123, login: 'editor', audience: 'studio', expires: Date.now() + 60_000 }, config.SESSION_SECRET);
  const response = await githubLogin(
    new Request(`${config.STUDIO_ORIGIN}/studio/auth/callback?code=old&state=old`, {
      headers: { Cookie: '__Host-studio=' + session },
    }),
    config,
    loginAttemptFixture().create(),
    async () => true,
  );
  assert.equal(response?.status, 302);
  assert.equal(response?.headers.get('Location'), config.STUDIO_ORIGIN + '/studio');
  assert.match(response?.headers.get('Set-Cookie') ?? '', /__Host-studio-state=;/);
});
