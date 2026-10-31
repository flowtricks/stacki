// Goal: asset edits and catalog defaults preserve real project files.
// Method: mutate disposable directories and validate listings through the shared parser.
import { localUploadPath } from '../src/features/storage/cleanupStore';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mutateAsset } from '../src/features/assets/assetOperations';
import { assetCatalog } from '../src/features/assets/assetCatalog';
import { readAssetState, restoreAssetState } from '../src/features/assets/assetState';
import { saveAsset } from '../src/features/storage/assetStorage';
import { parseAssetListing } from '../vendor/stacki/src/features/assets/assetPanelBridge';
import { Publisher } from '../src/features/publishing/publish';
import type { PublishSource } from '../src/features/publishing/publishSource';
import { ok } from '../vendor/stacki/shared/core/result';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-assets-'));
  for (const directory of ['src/assets', 'public', '.stacki/studio/state', 'node_modules']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(
    path.join(root, '.stacki/studio/state/github-base.json'),
    JSON.stringify({ sha: 'a'.repeat(40) }),
  );
  return root;
}
test('Stacki listing and real folder, upload, rename, move, delete and recovery', async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, 'src/assets/images'));
    await mutateAsset(root, { kind: 'mkdir', rel: 'public', name: 'photos' });
    await saveAsset(root, 'public/photos/first.png', Buffer.from('original bytes'));
    const listing = parseAssetListing(await assetCatalog(root));
    assert.equal(listing.missing, false);
    for (const directory of ['src/assets', 'src/assets/images']) {
      assert.ok(listing.entries.some((entry) => entry.rel === directory && entry.isDir));
    }
    assert.ok(listing.entries.some((entry) => entry.rel === 'public/photos' && entry.isDir));
    await mutateAsset(root, { kind: 'rename', rel: 'public/photos/first.png', name: 'second.png' });
    await mutateAsset(root, {
      kind: 'move',
      rel: 'public/photos/second.png',
      destination: 'src/assets',
    });
    assert.equal(
      await readFile(path.join(root, 'src/assets/second.png'), 'utf8'),
      'original bytes',
    );
    await mutateAsset(root, { kind: 'rename', rel: 'public/photos', name: 'gallery' });
    await assert.rejects(access(path.join(root, 'public/photos')));
    await access(path.join(root, 'public/gallery'));
    await mutateAsset(root, { kind: 'delete', rel: 'src/assets/second.png' });
    await assert.rejects(access(localUploadPath(root, 'public/photos/first.png')));
    await assert.rejects(access(localUploadPath(root, 'src/assets/second.png')));
    await writeFile(path.join(root, 'src/assets/second.png'), 'restored old durable upload');
    await restoreAssetState(root);
    await assert.rejects(access(path.join(root, 'src/assets/second.png')));
    assert.deepEqual((await readAssetState(root)).deleted, [
      'public/photos/first.png',
      'public/photos/second.png',
      'src/assets/second.png',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('asset operations reject collisions, traversal, root moves and mixed code folders', async () => {
  const root = await fixture();
  try {
    await saveAsset(root, 'public/one.png', Buffer.from('one'));
    await saveAsset(root, 'public/two.png', Buffer.from('two'));
    await assert.rejects(
      mutateAsset(root, { kind: 'rename', rel: 'public/one.png', name: 'two.png' }),
      /already exists/,
    );
    await assert.rejects(
      mutateAsset(root, { kind: 'move', rel: 'public', destination: 'src' }),
      /Invalid project path/,
    );
    await assert.rejects(mutateAsset(root, { kind: 'mkdir', rel: 'public', name: '../outside' }));
    await writeFile(path.join(root, 'src/assets/code.ts'), 'keep code');
    await assert.rejects(
      mutateAsset(root, { kind: 'rename', rel: 'src/assets', name: 'new' }),
      /Unsupported asset/,
    );
    await symlink(path.join(root, 'public/one.png'), path.join(root, 'src/assets/link.png'));
    await assert.rejects(
      mutateAsset(root, { kind: 'delete', rel: 'src/assets/link.png' }),
      /Symbolic/,
    );
    assert.equal(await readFile(path.join(root, 'public/one.png'), 'utf8'), 'one');
    assert.equal(await readFile(path.join(root, 'src/assets/code.ts'), 'utf8'), 'keep code');
    assert.deepEqual((await readAssetState(root)).deleted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('asset deletion is included in the built publication snapshot', async () => {
  const root = await fixture();
  try {
    await saveAsset(root, 'public/old.png', Buffer.from('old'));
    await mutateAsset(root, { kind: 'rename', rel: 'public/old.png', name: 'new.png' });
    let committed: PublishSource | undefined;
    const publisher = new Publisher(
      root,
      {
        async commit(files) {
          committed = files;
          return ok({ sha: 'b'.repeat(40), url: 'https://example.com/commit' });
        },
        async incoming() {
          throw new Error('Unexpected synchronization');
        },
        async acceptBase() {},
      },
      undefined,
      async (snapshot) => {
        assert.equal(await readFile(path.join(snapshot, 'public/new.png'), 'utf8'), 'old');
        await assert.rejects(access(path.join(snapshot, 'public/old.png')));
      },
    );
    const state = await publisher.publish();
    assert.equal(state.kind, 'committed', JSON.stringify(state));
    assert.ok(committed?.deleted.includes('public/old.png'));
    assert.ok(committed?.files.some((file) => file.path === 'public/new.png'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
