import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeConnection } from '../src/features/auth/connectionAuthorization';
import { signSession } from '../src/features/auth/session';

const config = {
  SESSION_SECRET: 'connection-authorization-test-secret',
  EDITOR_GITHUB_IDS: '1',
  GITHUB_APP_ID: '',
  GITHUB_INSTALLATION_ID: '',
  GITHUB_PRIVATE_KEY: '',
  GITHUB_REPOSITORY: '',
  GITHUB_BRANCH: '',
};
function request(session: string, audience?: string) {
  return new Request('https://studio.test/studio/internal/authorize', {
    method: 'POST',
    body: JSON.stringify({ session, audience }),
  });
}
test('open testing still requires a valid session and stops allowing testers when disabled', async () => {
  const identity = { id: 2, login: 'tester', expires: Date.now() + 60_000 };
  const testing = { ...config, EDITOR_ACCESS: 'github' };
  for (const audience of ['studio', 'preview'] as const) {
    const session = await signSession({ ...identity, audience }, config.SESSION_SECRET);
    assert.equal((await authorizeConnection(request(session, audience), testing)).status, 204);
    assert.equal((await authorizeConnection(request(session, audience), config)).status, 403);
    const expired = await signSession({ ...identity, audience, expires: Date.now() - 1_000 }, config.SESSION_SECRET);
    assert.equal((await authorizeConnection(request(expired, audience), testing)).status, 401);
  }
  assert.equal((await authorizeConnection(request('forged'), testing)).status, 401);
});
test('connection leases keep preview and studio sessions separated', async () => {
  const identity = { id: 1, login: 'editor', expires: Date.now() + 60_000 };
  const preview = await signSession({ ...identity, audience: 'preview' }, config.SESSION_SECRET);
  const studio = await signSession({ ...identity, audience: 'studio' }, config.SESSION_SECRET);
  assert.equal((await authorizeConnection(request(preview, 'preview'), config)).status, 204);
  assert.equal((await authorizeConnection(request(studio), config)).status, 204);
  assert.equal((await authorizeConnection(request(preview), config)).status, 401);
  assert.equal((await authorizeConnection(request(studio, 'preview'), config)).status, 401);
  assert.equal((await authorizeConnection(request(preview, 'other'), config)).status, 400);
  assert.equal(
    (
      await authorizeConnection(request(preview, 'preview'), {
        ...config,
        EDITOR_GITHUB_IDS: '',
      })
    ).status,
    403,
  );
});
