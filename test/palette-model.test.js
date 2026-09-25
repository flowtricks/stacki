// Goal: component usage replies cannot put malformed files or counts into the popup.
// Methodology: parse valid success/error variants, then exercise nested fields,
// totals, duplicates, and collection bounds; also pin grouping and preview URLs.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./renderer-module')('paletteModel.ts');

const file = {
  rel: 'src/pages/about.astro',
  path: '/project/src/pages/about.astro',
  kind: 'page',
  count: 2,
};

test('preview URLs respect the project slash policy and preserve encoded file identity', () => {
  const component = {
    name: 'Card', folder: 'Cards & Banners', path: '/project/src/components/Cards & Banners/Card.astro',
  };
  for (const mode of ['always', 'never', 'ignore']) {
    const url = new URL(model.componentPreviewURL('http://localhost:4321/', component, mode));
    assert.equal(url.pathname, mode === 'always' ? '/__avb/preview/' : '/__avb/preview');
    assert.equal(url.searchParams.get('c'), 'Card');
    assert.equal(url.searchParams.get('p'), 'src/components/Cards & Banners/Card.astro');
  }
});

test('component preview messages accept only known status updates', () => {
  for (const status of ['empty', 'ready']) {
    assert.deepEqual(
      model.parseComponentPreviewMessage({ type: 'avb:component-preview', status }),
      { status },
    );
  }
  for (const value of [
    null,
    {},
    { type: 'other', status: 'ready' },
    { type: 'avb:component-preview' },
    { type: 'avb:component-preview', status: 'unknown' },
  ]) {
    assert.equal(model.parseComponentPreviewMessage(value), undefined);
  }
});

test('component usage parser preserves success and operating-error variants', () => {
  assert.deepEqual(model.parseComponentUsage({ files: [file], total: 2 }), {
    kind: 'ready',
    files: [file],
  });
  assert.deepEqual(model.parseComponentUsage({ error: 'scan failed' }), {
    kind: 'error',
    message: 'scan failed',
  });
});

test('component usage parser rejects invalid nested values, totals, and bounds', () => {
  for (const value of [
    null,
    {},
    { error: 'failed', files: [] },
    { files: [{ ...file, rel: 'bad\0path' }] },
    { files: [{ ...file, kind: 'other' }] },
    { files: [{ ...file, count: 0 }] },
    { files: [file], total: 3 },
    { files: [file, file], total: 4 },
    { files: Array(100_001).fill(file) },
  ]) {
    assert.throws(() => model.parseComponentUsage(value));
  }
});

test('component groups keep the root first and folders in name order', () => {
  const component = (name, folder) => ({ path: `/p/${name}.astro`, name, folder });
  assert.deepEqual(
    model
      .groupPaletteComponents([
        component('Zed', 'Z'),
        component('Root', ''),
        component('Alpha', 'A'),
        component('Again', 'A'),
      ])
      .map(([folder, items]) => [folder, items.map((item) => item.name)]),
    [
      ['', ['Root']],
      ['A', ['Alpha', 'Again']],
      ['Z', ['Zed']],
    ],
  );
});
