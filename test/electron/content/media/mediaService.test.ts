// Goal: the panel's operations over any host (mediaService.ts, mediaOrder.ts)
// keep their promises — uploads never overwrite, a rename moves a file or a
// whole folder, a delete takes the order entry with it, a saved order survives
// listing and renaming, a replacement keeps the key — and media connections are
// kept only encrypted, never listed with their keys (mediaConnectionStore.ts).
// Method: an in-memory MediaStore that behaves as an object store (flat keys,
// folder markers, no order) runs the real service; the connection store runs
// over a temporary folder with a reversible stand-in for the OS encryption.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mediaService, uniqueName } from '#dist/electron/content/media/mediaService.js';
import { applyOrder, orderAfter, parseOrderManifest } from '#dist/electron/content/media/mediaOrder.js';
import { MediaConnectionStore } from '#dist/electron/content/media/mediaConnectionStore.js';
import type { MediaStore, StoredListing } from '#dist/electron/content/media/mediaStore.js';

// A flat key space, as S3 and R2 keep one: folders are prefixes and markers.
function memoryStore(initial: Readonly<Record<string, string>> = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(initial).map(([key, value]) => [key, new TextEncoder().encode(value)]));
  const store: MediaStore = {
    host: 'Memory',
    list(folder: string): Promise<StoredListing> {
      const prefix = folder === '' ? '' : `${folder}/`;
      const folders = new Set<string>();
      const files = [];
      for (const [key, bytes] of objects) {
        if (!key.startsWith(prefix) || key === prefix) {
          continue;
        }
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash >= 0) {
          folders.add(rest.slice(0, slash));
        } else if (rest !== '.stacki-order.json') {
          files.push({ name: rest, sizeBytes: bytes.length, modified: undefined });
        }
      }
      return Promise.resolve({ folders: [...folders], files, truncated: false });
    },
    keysUnder(folder: string) {
      return Promise.resolve(
        [...objects.keys()].filter((key) => key.startsWith(`${folder}/`) && key !== `${folder}/`).map((key) => key.slice(folder.length + 1)),
      );
    },
    read: (key: string) => Promise.resolve(objects.get(key)),
    write(key: string, bytes: Uint8Array) {
      objects.set(key, bytes);
      return Promise.resolve();
    },
    copy(from: string, to: string) {
      const bytes = objects.get(from);
      assert.ok(bytes, `copy source ${from} exists`);
      objects.set(to, bytes);
      return Promise.resolve();
    },
    remove(key: string) {
      objects.delete(key);
      return Promise.resolve();
    },
    createFolder(folder: string) {
      objects.set(`${folder}/`, new Uint8Array());
      return Promise.resolve();
    },
    removeFolder(folder: string) {
      for (const key of [...objects.keys()]) {
        if (key.startsWith(`${folder}/`)) {
          objects.delete(key);
        }
      }
      return Promise.resolve();
    },
    publicURL: (key: string) => `https://cdn.example.com/${key}`,
  };
  const text = (key: string) => new TextDecoder().decode(objects.get(key));
  return { store, objects, text };
}

const bytes = (value: string) => new TextEncoder().encode(value);

test('uploads take free names and never overwrite; listings carry kinds and public URLs', async () => {
  const { store, text } = memoryStore({ 'images/hero.png': 'old' });
  const listing = await mediaService(store).upload('images', [
    { name: 'hero.png', bytes: bytes('new') },
    { name: 'hero.png', bytes: bytes('newer') },
  ]);
  assert.deepEqual(listing.files.map((file) => file.name).sort(), ['hero 2.png', 'hero 3.png', 'hero.png']);
  assert.equal(text('images/hero.png'), 'old');
  const second = listing.files.find((file) => file.name === 'hero 2.png');
  assert.equal(second?.url, 'https://cdn.example.com/images/hero 2.png');
  assert.equal(second?.kind, 'image');
  assert.equal(uniqueName('notes', new Set(['notes', 'notes 2'])), 'notes 3');
});

test('a saved order lists first, survives a rename and loses a deleted file', async () => {
  const { store, text, objects } = memoryStore({ 'a.png': '1', 'b.png': '2', 'c.png': '3' });
  const service = mediaService(store);
  const ordered = await service.reorder('', ['c.png', 'a.png']);
  assert.deepEqual(
    ordered.files.map((file) => file.name),
    ['c.png', 'a.png', 'b.png'],
  );
  assert.deepEqual(JSON.parse(text('.stacki-order.json')), { version: 1, order: ['c.png', 'a.png'] });
  const renamed = await service.rename('', { entry: 'file', from: 'c.png', to: 'z.png' });
  assert.deepEqual(
    renamed.files.map((file) => file.name),
    ['z.png', 'a.png', 'b.png'],
  );
  assert.equal(objects.has('c.png'), false);
  const removed = await service.remove('', { entry: 'file', name: 'z.png' });
  assert.deepEqual(
    removed.files.map((file) => file.name),
    ['a.png', 'b.png'],
  );
  await assert.rejects(service.reorder('', ['gone.png']), /no longer in this folder/);
});

test('folders: made, renamed with everything below them, and deleted whole', async () => {
  const { store, objects } = memoryStore({ 'old/a.png': '1', 'old/deep/b.png': '2', 'old/.stacki-order.json': '{"version":1,"order":["a.png"]}' });
  const service = mediaService(store);
  await service.createFolder('', 'empty');
  assert.ok(objects.has('empty/'));
  await assert.rejects(service.createFolder('', 'empty'), /already exists/);
  const listing = await service.rename('', { entry: 'folder', from: 'old', to: 'new' });
  assert.deepEqual(
    listing.folders.map((folder) => folder.path),
    ['empty', 'new'],
  );
  assert.deepEqual([...objects.keys()].filter((key) => key.startsWith('new/')).sort(), ['new/', 'new/.stacki-order.json', 'new/a.png', 'new/deep/b.png']);
  assert.equal(
    [...objects.keys()].some((key) => key.startsWith('old/')),
    false,
  );
  await assert.rejects(service.rename('', { entry: 'folder', from: 'new', to: 'empty' }), /already exists/);
  await service.remove('', { entry: 'folder', name: 'new' });
  assert.equal(
    [...objects.keys()].some((key) => key.startsWith('new/')),
    false,
  );
});

test('a replacement keeps the key, and only the same kind of media may replace', async () => {
  const { store, text } = memoryStore({ 'hero.png': 'old' });
  const service = mediaService(store);
  const listing = await service.replace('', 'hero.png', { name: 'photo.jpg', bytes: bytes('new') });
  assert.equal(text('hero.png'), 'new');
  assert.deepEqual(
    listing.files.map((file) => file.name),
    ['hero.png'],
  );
  await assert.rejects(service.replace('', 'hero.png', { name: 'clip.mp4', bytes: bytes('x') }), /not a video/);
  await assert.rejects(service.replace('', 'missing.png', { name: 'a.png', bytes: bytes('x') }), /no longer in this folder/);
});

test('order helpers: names people sort, renames, damaged manifests', () => {
  const entries = [{ name: 'img10.png' }, { name: 'img2.png' }, { name: 'cover.png' }];
  assert.deepEqual(
    applyOrder(entries, ['cover.png']).map((entry) => entry.name),
    ['cover.png', 'img2.png', 'img10.png'],
  );
  assert.deepEqual(orderAfter(['a', 'b'], { from: 'a', to: 'c' }), ['c', 'b']);
  assert.deepEqual(orderAfter(['a', 'b'], { from: 'a', to: undefined }), ['b']);
  assert.throws(() => parseOrderManifest({ version: 2, order: [] }), /version/);
  assert.deepEqual(parseOrderManifest({ version: 1, order: ['a', 'a', 3] }), ['a']);
});

test('connections are kept encrypted, listed without keys, and read back in main only', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-media-'));
  try {
    const crypt = {
      available: () => true,
      encrypt: (value: string) => Buffer.from(`enc:${[...value].reverse().join('')}`),
      decrypt: (data: Buffer) => [...data.toString().replace(/^enc:/, '')].reverse().join(''),
    };
    const store = new MediaConnectionStore(crypt, () => folder);
    const secret = { kind: 'keyPair' as const, accessKeyId: 'AKID', secretAccessKey: 'very-secret' };
    const draft = { kind: 'r2' as const, label: 'Media', accountId: 'a'.repeat(32), bucket: 'media', publicBaseUrl: 'https://cdn.example.com', secret };
    const saved = store.save('/site', draft);
    const onDisk = fs.readFileSync(path.join(folder, 'media-connections.json'), 'utf8');
    assert.doesNotMatch(onDisk, /very-secret/);
    // Windows has no POSIX permission bits: it reports 0o666 for any writable file, so owner-only
    // mode is only checkable elsewhere. The keys are encrypted on every platform (above).
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(folder, 'media-connections.json')).mode & 0o777, 0o600);
    }
    assert.equal(JSON.stringify(store.list('/site')).includes('very-secret'), false);
    assert.deepEqual(store.connection('/site', saved.id)?.secret, secret);
    store.save('/site', { ...draft, label: 'Again' });
    assert.equal(store.list('/site').connections.length, 1, 'the same bucket replaces the old connection');
    const locked = new MediaConnectionStore({ ...crypt, available: () => false }, () => folder);
    assert.throws(() => locked.save('/site', draft), /cannot encrypt keys/);
    fs.writeFileSync(path.join(folder, 'media-connections.json'), '{damaged');
    assert.deepEqual(store.list('/site').connections, [], 'a damaged file reads as no connections');
  } finally {
    fs.rmSync(folder, { recursive: true });
  }
});
