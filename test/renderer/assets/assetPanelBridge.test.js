// Goal: AssetsPanel receives a bounded, internally consistent asset inventory.
// Methodology: exercise valid and invalid nested replies, then script every
// mutation to distinguish transport failures from malformed contracts.
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../../helpers/rendererModule')('src/features/assets/assetPanelBridge.ts');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');

const root = {
  rel: 'public',
  name: 'public',
  parent: '',
  root: 'public',
  isDir: true,
  isRoot: true,
};
const file = {
  rel: 'public/images/hero.png',
  name: 'hero.png',
  parent: 'public/images',
  root: 'public',
  isDir: false,
  abs: '/project/public/images/hero.png',
  size: 42,
};

test('asset listing parser preserves valid roots, folders, files, and missing state', () => {
  const folder = {
    rel: 'public/images',
    name: 'images',
    parent: 'public',
    root: 'public',
    isDir: true,
  };
  assert.deepEqual(bridge.parseAssetListing({ entries: [root, folder, file], missing: false }), {
    entries: [root, folder, file],
    missing: false,
  });
});

test('asset listing parser rejects malformed paths, relationships, roots, and bounds', () => {
  for (const value of [
    jsonNull,
    { entries: [], missing: 0 },
    { entries: [{ ...file, rel: 'bad\0path' }], missing: false },
    { entries: [{ ...file, root: 'other' }], missing: false },
    { entries: [{ ...file, name: 'other.png' }], missing: false },
    { entries: [{ ...file, parent: 'public' }], missing: false },
    { entries: [{ ...root, rel: 'public/nested' }], missing: false },
    { entries: [root], missing: true },
    { entries: [], missing: false },
    { entries: [file, file], missing: false },
    { entries: Array(100_001).fill(file), missing: false },
  ]) {
    assert.throws(() => bridge.parseAssetListing(value));
  }
});

// The Newest and Oldest sorts read `modifiedMs`: optional (Studio's demo uploads restored from storage
// have none), and when present whole, non-negative milliseconds; anything else is a contract bug.
test('asset listing parser keeps a valid modified time and rejects a malformed one', () => {
  const timed = { ...file, modifiedMs: 1_700_000_000_000 };
  assert.deepEqual(bridge.parseAssetListing({ entries: [root, timed], missing: false }).entries[1], timed);
  assert.equal('modifiedMs' in bridge.parseAssetListing({ entries: [root, file], missing: false }).entries[1], false, 'no time is no key');
  for (const modifiedMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, '1700000000000', jsonNull, true]) {
    assert.throws(() => bridge.parseAssetListing({ entries: [root, { ...file, modifiedMs }], missing: false }), String(modifiedMs));
  }
});

test('asset operations validate payloads, parse replies, and preserve failures', async () => {
  const calls = [];
  global.window = {
    avb: {
      listAssets: async (payload) => ({ entries: [root], missing: false, payload }),
      pickUploadAssets: async (payload) => (calls.push(['pick', payload]), { added: 1 }),
      uploadAssets: async (payload) => (calls.push(['upload', payload]), { added: 2 }),
      moveAsset: async (payload) => (calls.push(['move', payload]), { ok: true }),
      renameAsset: async (payload) => (calls.push(['rename', payload]), { ok: true }),
      deleteAsset: async (payload) => (calls.push(['delete', payload]), { ok: false }),
      mkdirAssets: async (payload) => (calls.push(['mkdir', payload]), { ok: true }),
      onAssetsChanged: () => () => {},
    },
  };
  assert.equal((await bridge.readAssetListing('/project')).ok, true);
  assert.deepEqual(await bridge.pickUploadAssets('/project', 'public'), { ok: true, value: 1 });
  assert.deepEqual(await bridge.uploadAssets('/project', 'public', ['/tmp/a.png']), {
    ok: true,
    value: 2,
  });
  assert.deepEqual(await bridge.moveAsset('/project', 'public/a.png', 'public/images'), {
    ok: true,
    value: true,
  });
  assert.equal((await bridge.renameAsset('/project', 'public/a.png', 'b.png')).ok, true);
  assert.deepEqual(await bridge.deleteAsset('/project', 'public/a.png'), {
    ok: true,
    value: false,
  });
  assert.equal((await bridge.makeAssetDirectory('/project', 'public', 'images')).ok, true);
  assert.equal(calls.length, 6);

  global.window.avb.listAssets = async () => {
    throw new Error('disk offline');
  };
  assert.deepEqual(await bridge.readAssetListing('/project'), {
    ok: false,
    error: 'disk offline',
  });
  global.window.avb.listAssets = async () => ({ entries: [file], missing: 'no' });
  await assert.rejects(() => bridge.readAssetListing('/project'));
  assert.throws(() => bridge.moveAsset('/project\0bad', 'public/a.png', 'public'));
  assert.throws(() => bridge.renameAsset('/project', 'public/a.png', '../bad'));
  assert.throws(() => bridge.makeAssetDirectory('/project', 'public', ' bad '));
});
