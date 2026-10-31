// Goal: Git-only publishing survives Vite configuration runner shutdown.
// Method: load the publisher through Vite, close the runner, then capture real Git objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { record } from '../src/shared/validation';

test('publishing still captures after Vite closes its configuration module runner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-publish-runtime-'));
  for (const directory of ['src/pages', 'public', '.stacki/studio/state']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: { build: 'astro build' },
    }),
  );
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Publish snapshot</h1>');
  await writeFile(
    path.join(root, '.stacki/studio/state/github-base.json'),
    JSON.stringify({ sha: 'a'.repeat(40) }),
  );
  const entry = path.join(root, 'publish-entry.ts');
  await writeFile(
    entry,
    `
    import { Publisher } from ${JSON.stringify(path.resolve('src/features/publishing/publish.ts'))};
    const repository = {
      async commit() { return { ok: true, value: { sha: '${'b'.repeat(40)}', url: 'https://example.test/commit' } }; },
      async incoming() { throw new Error('Unexpected sync'); },
      async acceptBase() {},
    };
    export function publish() { return new Publisher(${JSON.stringify(root)}, repository).publish(); }
  `,
  );
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, watch: null },
  });
  try {
    const loaded: unknown = await server.ssrLoadModule(entry);
    const publish = record(loaded)['publish'];
    assert.equal(typeof publish, 'function');
    if (!isCallable(publish)) {
      throw new Error('Missing publish function');
    }
    await server.close();
    const result: unknown = await publish();
    assert.equal(record(result)['kind'], 'committed', JSON.stringify(result));
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

function isCallable(value: unknown): value is () => unknown {
  return typeof value === 'function';
}
