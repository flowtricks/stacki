// Goal: GitHub grants repository-scoped, expiring installation access without exposing the App key.
// Method: mock only GitHub HTTP, verify scope and validate the returned connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubRepository } from '../src/features/github/github';
import { record } from '../src/shared/validation';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
test('publish credentials are scoped to one repository and contents write', async () => {
  const transport: typeof fetch = async (input, options) => {
    assert.match(String(input), /\/installations\/2\/access_tokens$/);
    assert.deepEqual(record(JSON.parse(String(options?.body))), {
      repositories: ['site'],
      permissions: { contents: 'write' },
    });
    return Response.json({ token: 'test-token' });
  };
  const repository = new GitHubRepository(
    {
      appId: '1',
      installationId: '2',
      repository: 'owner/site',
      branch: 'main',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    transport,
  );
  assert.deepEqual(await repository.publishConnection(), {
    ok: true,
    value: { repository: 'owner/site', branch: 'main', token: 'test-token' },
  });
});
