// Goal: remove committed upload copies while preserving drafts and newer asset bytes.
// Method: exercise real files, version checks and published manifests across supported paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StorageCleanup } from '../src/features/storage/cleanup';
import { saveAsset } from '../src/features/storage/assetStorage';
import { localUploadPath, keepLocalUpload, gitBlob } from '../src/features/storage/cleanupStore';
import { publishedAssetTree } from '../src/features/storage/publishedAssetTree';
import { SerialQueue } from '../src/shared/serialQueue';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cleanup-'));
  for (const directory of ['src/pages', 'public', '.stacki/studio/state']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Draft</h1>');
  await writeFile(
    path.join(root, '.stacki/studio/state/github-base.json'),
    JSON.stringify({ sha: 'a'.repeat(40) }),
  );
  const draft = path.join(
    root,
    '.stacki/studio/state',
    Buffer.from('src/pages/index.astro').toString('base64url') + '.bin',
  );
  await writeFile(draft, 'CRDT identity must remain');
  const queue = new SerialQueue();
  return { root, draft, queue, cleanup: new StorageCleanup(root, queue) };
}
test('cleanup deletes only reviewed unreferenced uploads and retains drafts and repository assets', async () => {
  const { root, draft, cleanup } = await fixture();
  try {
    await writeFile(path.join(root, 'public/repository.png'), 'repository');
    await saveAsset(root, 'public/unused.png', Buffer.from('unused'));
    await saveAsset(root, 'public/in-use.png', Buffer.from('used'));
    await writeFile(path.join(root, 'src/pages/index.astro'), '<img src="/in-use.png">');
    const report = await cleanup.inspect();
    assert.equal(report.assetBytes, 10);
    assert.equal(report.draftBytes, Buffer.byteLength('CRDT identity must remain'));
    assert.deepEqual(
      report.candidates.map((item) => item.file),
      ['public/unused.png'],
    );
    const result = await cleanup.clean(report.candidates);
    assert.equal(result.removed, 1);
    assert.equal(result.freedBytes, 6);
    await assert.rejects(access(path.join(root, 'public/unused.png')));
    await assert.rejects(access(localUploadPath(root, 'public/unused.png')));
    assert.equal(await readFile(draft, 'utf8'), 'CRDT identity must remain');
    assert.equal(await readFile(path.join(root, 'public/repository.png'), 'utf8'), 'repository');
    assert.equal(await readFile(path.join(root, 'public/in-use.png'), 'utf8'), 'used');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('a new reference or same-size replacement invalidates a previously reviewed cleanup', async () => {
  const { root, cleanup } = await fixture();
  try {
    await saveAsset(root, 'public/photo.png', Buffer.from('first'));
    const plan = (await cleanup.inspect()).candidates;
    await writeFile(path.join(root, 'src/pages/index.astro'), '<img src="/photo.png">');
    await assert.rejects(cleanup.clean(plan), /references changed/);
    await access(localUploadPath(root, 'public/photo.png'));
    await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>No image</h1>');
    await writeFile(path.join(root, 'public/photo.png'), 'other');
    await keepLocalUpload(root, 'public/photo.png', Buffer.from('other'));
    await assert.rejects(cleanup.clean(plan), /references changed/);
    assert.equal(await readFile(path.join(root, 'public/photo.png'), 'utf8'), 'other');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('references in CSS, encoded URLs, escaped JSON, and root configuration protect uploads', async () => {
  const { root, cleanup } = await fixture();
  try {
    for (const file of ['css.png', 'space name.png', 'escape.png', 'config.png']) {
      await saveAsset(root, 'public/' + file, Buffer.from('image'));
    }
    await writeFile(path.join(root, 'public/style.css'), 'a {background:url(/css.png)}');
    await writeFile(path.join(root, 'src/pages/index.astro'), '<img src="/space%20name.png">');
    await writeFile(path.join(root, 'src/data.json'), '{"image":"/esca\\u0070e.png"}');
    await writeFile(path.join(root, 'astro.config.mjs'), 'export default { image: "/config.png" }');
    assert.deepEqual((await cleanup.inspect()).candidates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('publishing removes identical stored copies but preserves the project and newer uploads', async () => {
  const { root, draft, cleanup } = await fixture();
  try {
    await saveAsset(root, 'public/published.png', Buffer.from('committed'));
    await saveAsset(root, 'public/newer.png', Buffer.from('draft'));
    const result = await cleanup.afterPublish(
      [
        {
          path: 'public/published.png',
          sha: gitBlob(Buffer.from('committed')),
          mode: '100644',
          size: 9,
        },
      ],
      'a'.repeat(40),
    );
    assert.equal(result.removed, 1);
    assert.equal(await readFile(path.join(root, 'public/published.png'), 'utf8'), 'committed');
    await assert.rejects(access(localUploadPath(root, 'public/published.png')));
    assert.equal(await readFile(localUploadPath(root, 'public/newer.png'), 'utf8'), 'draft');
    assert.equal(await readFile(draft, 'utf8'), 'CRDT identity must remain');
    assert.deepEqual(
      (await cleanup.inspect()).candidates.map((item) => item.file),
      ['public/newer.png'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('a published path with different draft bytes is never treated as an unused upload', async () => {
  const { root, cleanup } = await fixture();
  try {
    await saveAsset(root, 'public/photo.png', Buffer.from('draft'));
    await cleanup.store.rememberPublished(
      'a'.repeat(40),
      new Map([['public/photo.png', gitBlob(Buffer.from('older'))]]),
    );
    assert.deepEqual((await cleanup.inspect()).candidates, []);
    const result = await cleanup.afterPublish(
      [{ path: 'public/photo.png', sha: gitBlob(Buffer.from('older')), mode: '100644', size: 5 }],
      'a'.repeat(40),
    );
    assert.equal(result.removed, 0);
    assert.equal(await readFile(localUploadPath(root, 'public/photo.png'), 'utf8'), 'draft');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('cleanup refuses incomplete reference scans, symbolic links, and changed baselines', async () => {
  const { root, cleanup } = await fixture();
  try {
    await saveAsset(root, 'public/photo.png', Buffer.from('draft'));
    await writeFile(path.join(root, 'src/large.json'), ' '.repeat(4_000_001));
    await assert.rejects(cleanup.inspect(), /scan incomplete/);
    await rm(path.join(root, 'src/large.json'));
    await symlink('/tmp', path.join(root, 'src/linked'));
    await assert.rejects(cleanup.inspect(), /symbolic links/);
    await rm(path.join(root, 'src/linked'));
    await cleanup.store.rememberPublished('b'.repeat(40), new Map());
    await assert.rejects(cleanup.inspect(), /revision changed/);
    await access(localUploadPath(root, 'public/photo.png'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('published asset trees fail closed on truncation and linked assets', () => {
  assert.throws(() => publishedAssetTree({ truncated: true, tree: [] }), /Incomplete/);
  assert.throws(
    () =>
      publishedAssetTree({
        truncated: false,
        tree: [{ path: 'public/photo.png', mode: '120000', type: 'blob', sha: 'a'.repeat(40) }],
      }),
    /Linked/,
  );
  assert.deepEqual(
    publishedAssetTree({
      truncated: false,
      tree: [{ path: 'public/photo.png', mode: '100644', type: 'blob', sha: 'a'.repeat(40) }],
    }),
    [{ file: 'public/photo.png', sha: 'a'.repeat(40) }],
  );
});

test('published copies are removed for every supported format in nested public and source folders', async () => {
  const { root, draft, cleanup } = await fixture();
  const extensions = [
    'svg',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'avif',
    'ico',
    'bmp',
    'tif',
    'tiff',
    'mp4',
    'webm',
    'mov',
    'm4v',
    'ogv',
    'mp3',
    'wav',
    'ogg',
    'm4a',
    'flac',
    'aac',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'eot',
    'pdf',
  ];
  const files = ['public/nested', 'src/assets/nested'].flatMap((directory) =>
    extensions.map((extension) => `${directory}/upload.${extension}`),
  );
  try {
    const bytes = Buffer.from('committed');
    for (const file of files) {
      await saveAsset(root, file, bytes);
    }
    const result = await cleanup.afterPublish(
      files.map((file) => ({
        path: file,
        sha: gitBlob(bytes),
        mode: '100644',
        size: bytes.length,
      })),
      'a'.repeat(40),
    );
    assert.equal(result.removed, files.length);
    assert.equal(result.freedBytes, files.length * bytes.length);
    for (const file of files) {
      assert.equal(await readFile(path.join(root, file), 'utf8'), 'committed');
      await assert.rejects(access(localUploadPath(root, file)));
    }
    assert.equal(await readFile(draft, 'utf8'), 'CRDT identity must remain');
    assert.deepEqual((await cleanup.inspect()).candidates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('published manifests include nested source assets and reject unsafe paths', () => {
  const files = ['public/fonts/body.woff2', 'src/assets/icons/logo.svg'];
  const tree = files.map((file) => ({
    path: file,
    mode: '100644',
    type: 'blob',
    sha: 'a'.repeat(40),
  }));
  assert.deepEqual(
    publishedAssetTree({ truncated: false, tree }),
    files.map((file) => ({ file, sha: 'a'.repeat(40) })),
  );
  assert.throws(
    () =>
      publishedAssetTree({
        truncated: false,
        tree: [{ path: 'src/../private.png', mode: '100644', type: 'blob', sha: 'a'.repeat(40) }],
      }),
    /Invalid project path/,
  );
  assert.throws(
    () =>
      publishedAssetTree({
        truncated: false,
        tree: [{ path: 'src/assets/logo.svg', mode: '120000', type: 'blob', sha: 'a'.repeat(40) }],
      }),
    /Linked/,
  );
});
