// Asset response contracts reject malformed paths, sizes, and collections before
// rendering. Scripted preload calls distinguish disk failures from contract bugs.
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');
const { parseAssetEntry, parseAssetEntries, listAssetEntries, resolveAssetImport, parseAssetDimensions, readAssetDimensions } =
  loadRenderer('src/ipc/assetBridge.ts');
const file = {
  rel: 'public/a.png',
  name: 'a.png',
  parent: 'public',
  root: 'public',
  isDir: false,
  abs: '/p/public/a.png',
  size: 12,
};
const directory = {
  rel: 'public',
  name: 'public',
  parent: '',
  root: 'public',
  isDir: true,
  isRoot: true,
};
assert.deepEqual(parseAssetEntry(file), file);
assert.deepEqual(parseAssetEntry(directory), directory);
assert.deepEqual(parseAssetEntries({ entries: [directory, file] }).entries, [directory, file]);
for (const invalid of [
  PLATFORM_NULL,
  [],
  {},
  { ...file, isDir: 'false' },
  { ...file, abs: PLATFORM_NULL },
  { ...file, size: -1 },
  { ...file, size: 1.5 },
  { ...file, size: NaN },
  { ...file, size: Number.MAX_SAFE_INTEGER + 1 },
  { ...file, root: PLATFORM_NULL },
  { ...file, rel: 'bad\0path' },
  { ...file, rel: 'x'.repeat(32769) },
  { ...directory, isRoot: 'true' },
]) {
  assert.throws(() => parseAssetEntry(invalid));
}
assert.throws(() => parseAssetEntries({ entries: Array(100001).fill(file) }), /Array exceeds limit/);
assert.throws(() => parseAssetEntries({ entries: PLATFORM_NULL }), /Expected array/);
assert.deepEqual(parseAssetDimensions({ dims: { w: 640, h: 480 } }), { w: 640, h: 480 });
// Absence is `undefined` (AGENTS.md §6): an image whose size is unknown sends
// `dims: undefined`, which structured clone keeps, and never `null`.
assert.equal(parseAssetDimensions({ dims: undefined }), undefined);
for (const invalid of [
  PLATFORM_NULL,
  { dims: PLATFORM_NULL },
  { dims: [] },
  { dims: { w: 1 } },
  ...[0, -1, 1.5, NaN, Infinity, '20', 0x1_0000_0000].flatMap((value) => [{ dims: { w: value, h: 1 } }, { dims: { w: 1, h: value } }]),
]) {
  assert.throws(() => parseAssetDimensions(invalid));
}
assert.deepEqual(parseAssetDimensions({ dims: { w: 0xffff_ffff, h: 1 } }), {
  w: 0xffff_ffff,
  h: 1,
});
(async () => {
  global.window = { avb: { listAssets: async () => ({ entries: [file] }) } };
  assert.deepEqual(await listAssetEntries('/p'), { ok: true, value: [file] });
  window.avb.listAssets = async () => {
    throw new Error('disk unavailable');
  };
  assert.deepEqual(await listAssetEntries('/p'), { ok: false, error: 'disk unavailable' });
  window.avb.listAssets = async () => ({ entries: [PLATFORM_NULL] });
  await assert.rejects(() => listAssetEntries('/p'), /Expected object/);
  const request = ['/p', '/p/src/pages/index.astro', '../assets/hero.png'];
  window.avb.resolveSourcePath = async (payload) => {
    assert.deepEqual(payload, { projectPath: request[0], fromFile: request[1], spec: request[2] });
    return { ok: true, rel: 'src/assets/hero.png' };
  };
  assert.deepEqual(await resolveAssetImport(...request), { ok: true, rel: 'src/assets/hero.png' });
  window.avb.resolveSourcePath = async () => ({ ok: false });
  assert.deepEqual(await resolveAssetImport(...request), { ok: false });
  window.avb.resolveSourcePath = async () => {
    throw new Error('unavailable');
  };
  assert.deepEqual(await resolveAssetImport(...request), { ok: false });
  for (const response of [PLATFORM_NULL, {}, { ok: true, rel: 0 }, { ok: true, rel: 'x'.repeat(32769) }, { ok: true, rel: 'bad\0path' }]) {
    window.avb.resolveSourcePath = async () => response;
    await assert.rejects(() => resolveAssetImport(...request));
  }
  window.avb.assetDimensions = async (payload) => {
    assert.deepEqual(payload, { projectPath: '/p', rel: 'public/hero.png' });
    return { dims: { w: 640, h: 480 } };
  };
  assert.deepEqual(await readAssetDimensions('/p', 'public/hero.png'), {
    ok: true,
    value: { w: 640, h: 480 },
  });
  window.avb.assetDimensions = async () => ({ dims: undefined });
  assert.deepEqual(await readAssetDimensions('/p', 'public/hero.png'), {
    ok: true,
    value: undefined,
  });
  window.avb.assetDimensions = async () => {
    throw new Error('unavailable');
  };
  assert.deepEqual(await readAssetDimensions('/p', 'public/hero.png'), {
    ok: false,
    error: 'unavailable',
  });
  window.avb.assetDimensions = async () => ({ dims: { w: -1, h: 2 } });
  await assert.rejects(() => readAssetDimensions('/p', 'public/hero.png'));
  console.log('renderer-assets: parser bounds and operating-failure checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
