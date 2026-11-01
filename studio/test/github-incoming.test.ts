import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubRepository } from '../src/features/github/github';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const page = 'src/pages/index.astro';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
type Change = { filename: string; status: string; previous_filename?: string };

function repository(changes: readonly Change[], trees?: readonly unknown[]) {
  const reads: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/access_tokens')) {
      return Response.json({ token: 'test-token' });
    }
    if (url.pathname.endsWith('/git/ref/heads/main')) {
      return Response.json({ object: { sha: head } });
    }
    if (url.pathname.includes('/compare/')) {
      return Response.json({ status: 'ahead', files: changes });
    }
    if (url.pathname.includes('/git/trees/')) {
      assert.ok(trees);
      return Response.json(trees[url.pathname.endsWith(base) ? 0 : 1]);
    }
    const file = url.pathname.split('/contents/')[1];
    assert.ok(file && file.startsWith('src/'), `Unexpected content read: ${url}`);
    reads.push(file);
    return Response.json({
      encoding: 'base64',
      content: Buffer.from(url.searchParams.get('ref') === base ? 'before' : 'after').toString('base64'),
    });
  };
  return {
    reads,
    client: new GitHubRepository(
      {
        appId: '1',
        installationId: '2',
        repository: 'owner/site',
        branch: 'main',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      transport,
    ),
  };
}

test('deployment-only commits advance sync without reading deployment files', async () => {
  for (const status of ['added', 'modified', 'removed']) {
    const { client, reads } = repository(
      ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml', 'studio/src/cloudflare/site.ts'].map((filename) => ({ filename, status })),
    );
    assert.deepEqual(await client.incoming(base), { sha: head, files: [] });
    assert.deepEqual(reads, []);
  }
});

test('deployment changes do not block or discard accompanying source changes', async () => {
  const { client } = repository([
    { filename: 'wrangler.jsonc', status: 'modified' },
    { filename: page, status: 'modified' },
  ]);
  assert.deepEqual(await client.incoming(base), {
    sha: head,
    files: [{ file: page, before: 'before', after: 'after' }],
  });
});

test('renames across the independently deployed boundary retain both editable sides', async () => {
  for (const outside of ['wrangler.json', 'studio/page.astro']) {
    const movedOut = repository([{ filename: outside, previous_filename: page, status: 'renamed' }]);
    assert.deepEqual((await movedOut.client.incoming(base)).files, [{ file: page, before: 'before', after: null }]);
    const movedIn = repository([{ filename: page, previous_filename: outside, status: 'renamed' }]);
    assert.deepEqual((await movedIn.client.incoming(base)).files, [{ file: page, before: null, after: 'after' }]);
  }
});

test('runtime and binary changes still block syncing, including renamed old paths', async () => {
  for (const filename of ['package.json', 'package-lock.json', 'astro.config.mjs', 'public/a.png']) {
    await assert.rejects(repository([{ filename, status: 'modified' }]).client.incoming(base), /fresh repository revision/);
    await assert.rejects(
      repository([{ filename: 'wrangler.json', previous_filename: filename, status: 'renamed' }]).client.incoming(base),
      /fresh repository revision/,
    );
  }
});

test('the complete-tree fallback applies the same deployment exclusion', async () => {
  const entry = (path: string, sha: string) => ({ path, sha, mode: '100644', type: 'blob' });
  const trees = [base, head].map((sha) => ({
    truncated: false,
    tree: [entry('wrangler.jsonc', sha), entry(page, sha)],
  }));
  const { client } = repository(
    Array.from({ length: 300 }, (_, index) => ({
      filename: `studio/${index}.ts`,
      status: 'modified',
    })),
    trees,
  );
  assert.deepEqual(await client.incoming(base), {
    sha: head,
    files: [{ file: page, before: 'before', after: 'after' }],
  });
});
