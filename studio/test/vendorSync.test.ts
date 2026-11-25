// Goal: the Studio vendor assemble can run from several processes at once without a reader ever
// seeing a missing or half-written file (the TS6053 and ENOTEMPTY floods of 1.4.6 and 1.4.7), and
// an unchanged tree is not touched at all.
// Methodology: syncTree runs on a temporary folder built with path.join (Windows-safe) and is
// checked for exact contents, for untouched modification times when nothing changed, and for
// removal of stale files; withVendorLock is raced by two holders with a fake sleep, a stale lock is
// taken over, and a lock that never frees fails at its bound with a message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncTree, VENDOR_SYNC_LIMITS, withVendorLock } from '../scripts/vendorSync';

async function temporaryFolder(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'stacki-vendor-sync-'));
}

test('the tree ends up holding exactly the inventory, and a second run writes nothing', async () => {
  const root = await temporaryFolder();
  try {
    await mkdir(path.join(root, 'old'), { recursive: true });
    await writeFile(path.join(root, 'old', 'stale.ts'), 'gone');
    const files = new Map<string, string | Buffer>([
      ['shared/a.ts', 'export const a = 1;\n'],
      ['src/deep/b.ts', Buffer.from('export const b = 2;\n')],
    ]);
    assert.deepEqual(await syncTree(root, files), { written: 2, removed: 1 });
    assert.equal(await readFile(path.join(root, 'shared', 'a.ts'), 'utf8'), 'export const a = 1;\n');
    const before = (await stat(path.join(root, 'shared', 'a.ts'))).mtimeMs;
    assert.deepEqual(await syncTree(root, files), { written: 0, removed: 0 });
    assert.equal((await stat(path.join(root, 'shared', 'a.ts'))).mtimeMs, before, 'an unchanged file is not rewritten');
    await assert.rejects(syncTree(root, new Map([['../escape.ts', 'x']])), /leaves the tree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two concurrent assembles of the same sources both succeed and agree', async () => {
  const root = await temporaryFolder();
  try {
    const files = new Map<string, string | Buffer>(Array.from({ length: 50 }, (_, index) => [`f/${index}.ts`, `export const v${index} = ${index};\n`]));
    const lock = path.join(root, 'lock');
    const results = await Promise.all(
      [1, 2].map(() =>
        withVendorLock(
          lock,
          () => syncTree(path.join(root, 'tree'), files),
          () => new Promise((resolve) => setTimeout(resolve, 5)),
        ),
      ),
    );
    assert.equal((results[0]?.written ?? 0) + (results[1]?.written ?? 0), 50, 'the first holder writes everything');
    assert.equal(Math.min(results[0]?.written ?? 0, results[1]?.written ?? 0), 0, 'the second finds nothing to do');
    await assert.rejects(stat(lock), 'the lock is released');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale lock is taken over; a live one fails at the bound', async () => {
  const root = await temporaryFolder();
  try {
    const lock = path.join(root, 'lock');
    await mkdir(lock);
    const old = new Date(Date.now() - VENDOR_SYNC_LIMITS.lockStaleMs - 60_000);
    await utimes(lock, old, old);
    assert.equal(
      await withVendorLock(
        lock,
        () => Promise.resolve('ran'),
        () => Promise.resolve(),
      ),
      'ran',
    );
    await mkdir(lock);
    let sleeps = 0;
    await assert.rejects(
      withVendorLock(
        lock,
        () => Promise.resolve('never'),
        () => {
          sleeps += 1;
          return Promise.resolve();
        },
      ),
      /Another Studio assemble held/,
    );
    assert.equal(sleeps, Math.ceil(VENDOR_SYNC_LIMITS.lockWaitMsMax / VENDOR_SYNC_LIMITS.lockPollMs) + 1, 'the wait is bounded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
