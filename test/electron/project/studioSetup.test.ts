// Use real temporary projects to prove installation preserves website files,
// refuses existing folders/symlinks and never activates failed validation.
// Local bundles and mocked downloads also prove development releases stay
// scoped to the application checkout while packaged apps use published releases.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installNewRelease } from '#dist/electron/project/studioInstall.js';
import { automaticStudio, studioStatus, readStudioRelease } from '#dist/electron/project/studioSetup.js';
import { parseRelease } from '#dist/shared/ipc/studioRelease.js';

function release() {
  return parseRelease({
    format: 1,
    version: '1.2.3',
    files: [
      { path: 'package.json', content: '{"name":"@stacki/studio","version":"1.2.3"}' },
      { path: 'package-lock.json', content: '{}' },
      { path: 'Dockerfile', content: 'FROM node:22' },
      { path: 'scripts/build.ts', content: 'export {};' },
      { path: 'src/shared/release.json', content: '{"version":"1.2.3"}' },
      { path: 'vendor/stacki/LICENSE', content: 'MIT' },
      { path: 'templates/cloudflare/wrangler.jsonc', content: '{"name":"your-studio"}' },
    ],
  });
}

test('development setup uses its matching bundle without network', async (context) => {
  context.mock.method(globalThis, 'fetch', () => {
    assert.fail('Development setup must not depend on a published release');
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-development-'));
  const environment = { kind: 'development', appPath: root } as const;
  try {
    await assert.rejects(automaticStudio('1.2.3', environment), /npm run studio:release/);
    const directory = path.join(root, 'studio/release');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'stacki-studio-1.2.3.json'), JSON.stringify(release()));
    assert.deepEqual(await automaticStudio('1.2.3', environment), release());
    await writeFile(path.join(directory, 'stacki-studio-1.2.4.json'), JSON.stringify(release()));
    await assert.rejects(automaticStudio('1.2.4', environment), /version does not match/);
    await assert.rejects(automaticStudio('../1.2.3', environment));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packaged setup downloads the exact release and reports missing bundles', async (context) => {
  const download = context.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, 'https://github.com/flowtricks/stacki-releases/releases/download/v1.2.3/' + 'stacki-studio-1.2.3.json');
    return new Response(JSON.stringify(release()), { status: 200 });
  });
  assert.deepEqual(await automaticStudio('1.2.3', { kind: 'packaged' }), release());
  download.mock.mockImplementation(async () => new Response('Not found', { status: 404 }));
  await assert.rejects(automaticStudio('1.2.3', { kind: 'packaged' }), /use the agent setup prompt in Go live/);
});

test('fresh setup activates validated files and refuses a second install', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-setup-'));
  try {
    await writeFile(path.join(root, 'website.txt'), 'Website stays intact');
    assert.equal((await studioStatus(root, '1.2.3')).kind, 'missing');
    await installNewRelease(path.join(root, 'studio'), release(), async (staging) => {
      await assert.rejects(access(path.join(root, 'studio')));
      assert.equal(await readFile(path.join(staging, 'cloudflare/wrangler.jsonc'), 'utf8'), '{"name":"your-studio"}');
    });
    assert.deepEqual(await studioStatus(root, '2.0.0'), {
      kind: 'installed',
      desktopVersion: '2.0.0',
      version: '1.2.3',
    });
    await assert.rejects(
      installNewRelease(path.join(root, 'studio'), release(), async () => {
        assert.fail('Existing installation must not run validation');
      }),
      /already exists/,
    );
    assert.equal(await readFile(path.join(root, 'website.txt'), 'utf8'), 'Website stays intact');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed setup leaves the project without an installed Studio', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-failure-'));
  try {
    await assert.rejects(
      installNewRelease(path.join(root, 'studio'), release(), async () => {
        throw new Error('Build failed');
      }),
      /Build failed/,
    );
    await assert.rejects(access(path.join(root, 'studio')));
    await assert.rejects(access(path.join(root, '.stacki-studio/update.lock')));
    await mkdir(path.join(root, 'studio'));
    assert.equal((await studioStatus(root, '1.2.3')).kind, 'blocked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('setup rejects symlink targets and invalid local bundles', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-studio-boundary-'));
  try {
    await mkdir(path.join(root, 'elsewhere'));
    await symlink(path.join(root, 'elsewhere'), path.join(root, 'studio'), 'junction');
    assert.equal((await studioStatus(root, '1.2.3')).kind, 'blocked');
    await assert.rejects(installNewRelease(path.join(root, 'studio'), release(), async () => {}));
    const bundle = path.join(root, 'release.json');
    await writeFile(
      bundle,
      JSON.stringify({
        ...release(),
        files: [...release().files, { path: '../website.txt', content: 'must not escape' }],
      }),
    );
    await assert.rejects(readStudioRelease(bundle), /Invalid replaceable/);
    await writeFile(bundle, JSON.stringify(release()));
    assert.equal((await readStudioRelease(bundle)).version, '1.2.3');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
