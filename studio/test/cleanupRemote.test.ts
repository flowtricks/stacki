// Goal: committed assets leave remote storage while unpublished bytes and draft records survive.
// Method: exercise real project files and CleanupStore with an in-memory R2 HTTP boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { PublishedFile } from '../src/features/publishing/publishSource';
import { StorageCleanup } from '../src/features/storage/cleanup';
import { CleanupStore, assetDigest, gitBlob } from '../src/features/storage/cleanupStore';
import { parseCandidate } from '../src/features/storage/cleanupTypes';
import { SerialQueue } from '../src/shared/serialQueue';

test('remote cleanup retries safely and retains newer drafts at published paths', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-remote-cleanup-'));
  const files = ['public/fonts/body.woff2', 'src/assets/icons/logo.svg'];
  const committed = Buffer.from('committed');
  const newer = Buffer.from('new draft');
  const objects = new Map([
    ...files.map((file) => ['assets/' + file, committed] as const),
    ['assets/src/assets/newer.webp', newer] as const,
    ['assets/public/unpublished.mp3', newer] as const,
    ['documents/src/pages/index.astro', Buffer.from('collaborative draft')] as const,
  ]);
  let failRemoval = true;
  context.mock.method(
    globalThis,
    'fetch',
    remoteStorage(objects, () => failRemoval),
  );
  try {
    for (const [key, bytes] of objects) {
      if (key.startsWith('assets/')) {
        const filename = path.join(root, key.slice('assets/'.length));
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, bytes);
      }
    }
    const cleanup = new StorageCleanup(
      root,
      new SerialQueue(),
      new CleanupStore(root, 'https://r2.test', 'test-token'),
    );
    const snapshot: readonly PublishedFile[] = [...files, 'src/assets/newer.webp'].map((file) => ({
      path: file,
      sha: gitBlob(committed),
      mode: '100644',
      size: committed.length,
    }));
    const first = await cleanup.afterPublish(snapshot, 'a'.repeat(40));
    assert.ok(first.warning);
    assert.equal(objects.size, 5);
    failRemoval = false;
    const retry = await cleanup.afterPublish(snapshot, 'a'.repeat(40));
    assert.equal(retry.removed, 2);
    assert.equal(objects.size, 3);
    assert.ok(objects.has('assets/src/assets/newer.webp'));
    assert.ok(objects.has('assets/public/unpublished.mp3'));
    assert.ok(objects.has('documents/src/pages/index.astro'));
    for (const file of files) {
      assert.equal(await readFile(path.join(root, file), 'utf8'), 'committed');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function remoteStorage(objects: Map<string, Buffer>, failed: () => boolean) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('x-studio-token'), 'test-token');
    if (String(input).endsWith('/storage')) {
      return Response.json({
        entries: [...objects].map(([key, bytes]) => ({
          key,
          size: bytes.length,
          version: assetDigest(bytes),
        })),
      });
    }
    assert.ok(String(input).endsWith('/storage-remove'));
    if (failed()) {
      return new Response('Temporary failure', { status: 503 });
    }
    assert.equal(init?.method, 'POST');
    assert.equal(typeof init?.body, 'string');
    assert.ok(typeof init?.body === 'string');
    const inputBody: unknown = JSON.parse(init.body);
    const candidate = parseCandidate(inputBody);
    const key = 'assets/' + candidate.file;
    const bytes = objects.get(key);
    assert.ok(bytes);
    assert.equal(candidate.kind, 'published');
    assert.equal(candidate.digest, assetDigest(bytes));
    assert.equal(candidate.version, assetDigest(bytes));
    return Response.json({ removed: objects.delete(key) });
  };
}
