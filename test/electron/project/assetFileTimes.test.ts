// Goal: the asset listing gives each file its modified time, from the same stat that gives its size, so
// the Assets panel's Newest and Oldest sorts order what is on disk. Method: build a temporary project,
// stamp files with known times (`fs.utimesSync`), list it with the real main-process scanner and check
// each entry's `modifiedMs` is the whole-millisecond mtime; folders carry none. Names that differ only
// in case live in separate folders, so the test holds on case-insensitive disks (macOS, Windows).
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listAssetEntries } from '#dist/electron/project/assetFiles.js';

test('listed files carry their whole-millisecond modified time; folders carry none', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-asset-times-'));
  try {
    const stamps = [
      { rel: path.join('public', 'images', 'old.png'), seconds: 1_600_000_000 },
      { rel: path.join('public', 'images', 'new.png'), seconds: 1_700_000_000.5 },
      { rel: path.join('public', 'Upper', 'Logo.svg'), seconds: 1_650_000_000 },
      { rel: path.join('public', 'lower', 'logo.svg'), seconds: 1_660_000_000 },
    ];
    for (const stamp of stamps) {
      const absolute = path.join(root, stamp.rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, 'x');
      fs.utimesSync(absolute, stamp.seconds, stamp.seconds);
    }
    const { entries } = listAssetEntries(root);
    for (const stamp of stamps) {
      const rel = stamp.rel.split(path.sep).join('/');
      const entry = entries.find((candidate) => candidate.rel === rel);
      assert.ok(entry, `${rel} is listed`);
      assert.ok(!entry.isDir, `${rel} is a file`);
      assert.equal(entry.modifiedMs, Math.floor(fs.statSync(path.join(root, stamp.rel)).mtimeMs), `${rel} has its mtime`);
      assert.equal(Number.isSafeInteger(entry.modifiedMs), true, `${rel} has whole milliseconds`);
    }
    for (const folder of entries.filter((entry) => entry.isDir)) {
      assert.equal('modifiedMs' in folder, false, `${folder.rel} has no time`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
