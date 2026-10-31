// Exercise directory replacement on disk, preserving real project state and
// proving failed validation cannot replace a customized installation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installRelease } from '../src/features/updates/install';
import { isNewerRelease, parseRelease, retainedPath } from '../src/features/updates/release';
import { prepareStudioBranch } from '../src/features/updates/githubUpdate';
import { record } from '../src/shared/validation';

function release() {
  return parseRelease({
    format: 1,
    version: '1.2.3',
    files: [
      { path: 'package.json', content: '{"name":"@stacki/studio","version":"1.2.3"}' },
      { path: 'package-lock.json', content: '{}' },
      { path: 'Dockerfile', content: 'FROM node:22' },
      { path: 'scripts/build.ts', content: 'export const version = "1.2.3";' },
      { path: 'src/shared/release.json', content: '{"version":"1.2.3"}' },
      { path: 'vendor/stacki/LICENSE', content: 'MIT' },
    ],
  });
}
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-update-'));
  for (const file of [
    'src/pages/index.astro',
    'studio/src/custom.ts',
    'studio/.studio/draft.json',
    'studio/cloudflare/wrangler.jsonc',
    'studio/.env',
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), file);
  }
  return root;
}
test('an accepted update replaces customized Studio code and preserves project data', async () => {
  const root = await project();
  try {
    const result = await installRelease(path.join(root, 'studio'), release(), async (candidate) => {
      assert.equal(
        record(JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8')))['version'],
        '1.2.3',
      );
      assert.equal(
        await readFile(path.join(root, 'studio/src/custom.ts'), 'utf8'),
        'studio/src/custom.ts',
      );
    });
    assert.ok(result.backup);
    assert.equal(
      await readFile(path.join(result.backup, 'src/custom.ts'), 'utf8'),
      'studio/src/custom.ts',
    );
    await assert.rejects(access(path.join(root, 'studio/src/custom.ts')));
    for (const file of [
      'src/pages/index.astro',
      'studio/.studio/draft.json',
      'studio/cloudflare/wrangler.jsonc',
      'studio/.env',
    ]) {
      assert.equal(await readFile(path.join(root, file), 'utf8'), file);
    }
    // Update backups live under `.stacki/studio/`, which ignores its own contents.
    assert.equal(await readFile(path.join(root, '.stacki/studio/.gitignore'), 'utf8'), '*\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('a failed candidate leaves current code, connection settings and drafts untouched', async () => {
  const root = await project();
  try {
    await assert.rejects(
      installRelease(path.join(root, 'studio'), release(), async () => {
        throw new Error('injected compiler failure');
      }),
      /compiler failure/,
    );
    for (const file of ['src/custom.ts', '.studio/draft.json', '.env']) {
      assert.equal(await readFile(path.join(root, 'studio', file), 'utf8'), 'studio/' + file);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('release validation rejects traversal, credentials, metadata and duplicate files', () => {
  for (const name of [
    '../src/pages/index.astro',
    '/tmp/file',
    '.env',
    '.git/config',
    'src/../../file',
    'cloudflare/wrangler.jsonc',
    'src\\file.ts',
  ]) {
    assert.throws(() =>
      parseRelease({ ...release(), files: [...release().files, { path: name, content: '' }] }),
    );
  }
  assert.throws(() =>
    parseRelease({ ...release(), files: [...release().files, release().files[0]] }),
  );
  assert.equal(retainedPath('.studio/draft.json'), true);
  assert.equal(retainedPath('src/custom.ts'), false);
});
test('hosted updates create a replacement subtree and review branch without changing main', async () => {
  const calls: { endpoint: string; method: string | undefined; body: unknown }[] = [];
  const result = await prepareStudioBranch(
    'owner/site',
    'a'.repeat(40),
    release(),
    async (endpoint, method, body) => {
      calls.push({ endpoint, method, body });
      if (endpoint.includes('/commits/') && !method) {
        return { tree: { sha: 'base' } };
      }
      if (endpoint.endsWith('/trees/base')) {
        return { tree: [{ path: 'studio', type: 'tree', mode: '040000', sha: 'studio' }] };
      }
      if (endpoint.includes('/trees/studio?')) {
        return {
          tree: [
            { path: 'src/custom.ts', mode: '100644', type: 'blob', sha: 'custom' },
            { path: 'cloudflare/wrangler.jsonc', mode: '100644', type: 'blob', sha: 'config' },
          ],
        };
      }
      return { sha: 'b'.repeat(40) };
    },
  );
  assert.match(result.branch, /^stacki\/studio-1\.2\.3-/);
  assert.equal(
    calls.some((call) => call.method === 'PATCH'),
    false,
  );
  const treeCall = calls.find((call) => call.endpoint.endsWith('/trees') && call.method === 'POST');
  assert.ok(treeCall);
  const tree = record(treeCall.body)['tree'];
  assert.ok(Array.isArray(tree));
  assert.ok(tree.some((entry: unknown) => record(entry)['path'] === 'cloudflare/wrangler.jsonc'));
  assert.equal(
    tree.some((entry: unknown) => record(entry)['path'] === 'src/custom.ts'),
    false,
  );
});

test('update checks compare full semantic versions without offering downgrades', () => {
  assert.equal(isNewerRelease('1.10.0', '1.9.9'), true);
  assert.equal(isNewerRelease('2.0.0', '1.99.0'), true);
  assert.equal(isNewerRelease('1.5.0', '1.5.0'), false);
  assert.equal(isNewerRelease('1.4.0', '1.5.0'), false);
});
