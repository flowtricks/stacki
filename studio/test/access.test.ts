import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessCheck, hasWritePermission } from '../src/features/auth/repositoryAccess';
import { logout } from '../src/features/auth/githubLogin';
import { parseProfile, avatarURL } from '../src/features/auth/profile';

const allowlist = {
  EDITOR_GITHUB_IDS: '123',
  GITHUB_APP_ID: 'app',
  GITHUB_INSTALLATION_ID: 'installation',
  GITHUB_PRIVATE_KEY: 'test',
  GITHUB_REPOSITORY: 'owner/site',
  GITHUB_BRANCH: 'main',
};
const config = { ...allowlist, EDITOR_ACCESS: 'repository' };
test('repository permission checks require both write access and the signed numeric identity', () => {
  for (const permission of ['write', 'admin']) {
    assert.equal(hasWritePermission({ permission, user: { id: 123 } }, 123), true);
  }
  for (const permission of ['read', 'none', 'triage']) {
    assert.equal(hasWritePermission({ permission, user: { id: 123 } }, 123), false);
  }
  assert.equal(hasWritePermission({ permission: 'admin', user: { id: 999 } }, 123), false);
});
test('cached access expires, revoked collaborators are denied, and API errors fail closed', async () => {
  let time = 0;
  let permission = 'write';
  let calls = 0;
  const check = createAccessCheck(
    async () => {
      calls++;
      if (permission === 'error') {
        throw new Error('GitHub unavailable');
      }
      return { permission, user: { id: 123 } };
    },
    () => time,
  );
  const identity = { id: 123, login: 'editor' };
  assert.equal(await check(identity, config), true);
  permission = 'read';
  assert.equal(await check(identity, config), true);
  assert.equal(calls, 1);
  time += 300_001;
  assert.equal(await check(identity, config), false);
  permission = 'write';
  assert.equal(await check(identity, config, true), true, 'New sign-ins bypass the cache');
  permission = 'error';
  time += 300_001;
  await assert.rejects(check(identity, config), /GitHub unavailable/);
});
test('pending invitations and strangers do not inherit the old owner allowlist', async () => {
  const check = createAccessCheck(async () => null);
  assert.equal(await check({ id: 123, login: 'editor' }, config), false);
});
test('GitHub testing access admits non-collaborators and is reversible without cached grants', async () => {
  let calls = 0;
  const check = createAccessCheck(async () => {
    calls++;
    return null;
  });
  const identity = { id: 456, login: 'tester' };
  const testing = { ...config, EDITOR_ACCESS: 'github' };
  assert.equal(await check(identity, config), false);
  assert.equal(await check(identity, testing), true, 'Testing overrides cached repository denial');
  assert.equal(await check(identity, testing, true), true, 'Connection leases allow testers');
  assert.equal(calls, 1, 'Testing does not require a repository permission lookup');
  assert.equal(await check(identity, config, true), false, 'Repository access applies again');
  assert.equal(calls, 2);
});
test('only the exact github mode opens testing; omitted and unknown modes keep the allowlist', async () => {
  const check = createAccessCheck(async () => assert.fail('Must not query GitHub'));
  for (const mode of [undefined, '', 'public', 'Github', 'github ']) {
    const access = { ...allowlist, ...(mode === undefined ? {} : { EDITOR_ACCESS: mode }) };
    assert.equal(await check({ id: 456, login: 'tester' }, access), false);
    assert.equal(await check({ id: 123, login: 'owner' }, access), true);
  }
});
test('sign out requires a same-origin POST and expires the studio cookie', () => {
  const auth = {
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    SESSION_SECRET: '',
    EDITOR_GITHUB_IDS: '',
    STUDIO_ORIGIN: 'https://studio.test',
  };
  assert.equal(logout(new Request('https://studio.test/studio/auth/logout'), auth).status, 403);
  assert.equal(
    logout(
      new Request('https://studio.test/studio/auth/logout', {
        method: 'POST',
        headers: { Origin: 'https://other.test' },
      }),
      auth,
    ).status,
    403,
  );
  const response = logout(
    new Request('https://studio.test/studio/auth/logout', {
      method: 'POST',
      headers: { Origin: auth.STUDIO_ORIGIN },
    }),
    auth,
  );
  assert.equal(response.status, 303);
  assert.match(response.headers.get('Set-Cookie') ?? '', /__Host-studio=;.*Max-Age=0/);
});
test('avatars use a verified GitHub ID, never an arbitrary peer-provided image URL', () => {
  assert.deepEqual(parseProfile({ id: 123, login: 'editor' }), { id: 123, login: 'editor' });
  assert.equal(avatarURL(123), 'https://avatars.githubusercontent.com/u/123?s=64');
  assert.throws(() => parseProfile({ id: -1, login: 'editor' }));
  assert.throws(() => parseProfile({ id: 123, login: '../other' }));
});

test('the permission lookup reuses one installation token and surfaces a GitHub limit with its wait', async () => {
  const { collaboratorPermission } = await import('../src/features/auth/repositoryAccess');
  const { GitHubRateLimitError } = await import('../src/features/auth/githubRateLimit');
  const { generateKeyPairSync } = await import('node:crypto');
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const github = { appId: 'app', installationId: 'cache-test', privateKey, repository: 'owner/site', branch: 'main' };
  let mints = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes('/access_tokens')) {
      mints++;
      return Response.json({ token: 'installation-token' });
    }
    return new Response(null, { status: 403, headers: { 'Retry-After': '120' } });
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(collaboratorPermission(github, 'editor', globalThis.fetch), (error: unknown) => {
        return error instanceof GitHubRateLimitError && error.retryAt > Date.now() + 100_000;
      });
    }
    assert.equal(mints, 1, 'The second lookup reuses the cached token');
  } finally {
    globalThis.fetch = original;
  }
});
