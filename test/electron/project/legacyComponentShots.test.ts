// Goal: the one-time cleanup removes the photograph cache an earlier version wrote, only the names that
// version wrote, within its bounds, and is a no-op once the cache is gone.
// Methodology: real temporary userData folders: the old layout with photographs, a meta file and a stray
// temporary; a folder holding a file the old version never wrote; a name that is not a project key; then
// a second run on what is left, and a run where there was never a cache.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { LEGACY_SHOTS_DIRECTORY, removeLegacyComponentShots } from '#dist/electron/project/legacyComponentShots.js';

function userData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-legacy-shots-'));
}

test('the old cache goes: photographs, meta and temporaries, each project folder and the cache folder itself', async () => {
  const root = userData();
  try {
    const cache = path.join(root, LEGACY_SHOTS_DIRECTORY);
    for (const key of ['0123456789abcdef', 'fedcba9876543210']) {
      fs.mkdirSync(path.join(cache, key), { recursive: true });
      fs.writeFileSync(path.join(cache, key, '00112233aabbccdd.jpg'), 'jpeg');
      fs.writeFileSync(path.join(cache, key, 'meta.json'), '{}');
      fs.writeFileSync(path.join(cache, key, 'meta.json.123.tmp'), '{}');
    }
    assert.deepEqual(await removeLegacyComponentShots(root), { filesRemoved: 6, foldersRemoved: 2, foldersKept: 0 });
    assert.equal(fs.existsSync(cache), false);
    assert.equal(await removeLegacyComponentShots(root), undefined, 'once gone, there is nothing to do');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('negative space: files the old version never wrote, and folders that are not its project keys, are kept', async () => {
  const root = userData();
  try {
    const cache = path.join(root, LEGACY_SHOTS_DIRECTORY);
    fs.mkdirSync(path.join(cache, '0123456789abcdef'), { recursive: true });
    fs.writeFileSync(path.join(cache, '0123456789abcdef', '00112233aabbccdd.jpg'), 'jpeg');
    fs.writeFileSync(path.join(cache, '0123456789abcdef', 'notes.txt'), 'mine');
    fs.mkdirSync(path.join(cache, 'Not A Key'));
    fs.writeFileSync(path.join(cache, 'Not A Key', 'meta.json'), '{}');
    assert.deepEqual(await removeLegacyComponentShots(root), { filesRemoved: 1, foldersRemoved: 0, foldersKept: 2 });
    assert.equal(fs.readFileSync(path.join(cache, '0123456789abcdef', 'notes.txt'), 'utf8'), 'mine');
    assert.equal(fs.existsSync(path.join(cache, 'Not A Key', 'meta.json')), true);
    assert.equal(fs.existsSync(path.join(cache, '0123456789abcdef', '00112233aabbccdd.jpg')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('without a cache nothing happens, and userData must be absolute', async () => {
  const root = userData();
  try {
    assert.equal(await removeLegacyComponentShots(root), undefined);
    await assert.rejects(removeLegacyComponentShots('relative'), /userData is an absolute path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
