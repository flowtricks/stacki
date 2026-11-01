// Exercise CMS wire parsers and request wrappers with real shared parsers. Keep
// transport failures distinct from malformed replies, preserve expression/asset
// metadata, and reject oversized or unknown field declarations at the boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');
const bridge = load('src/features/cms/cmsBridge.ts');
const types = load('src/features/cms/cmsTypes.ts');
const entries = [{ title: 'Entry', image: { __expr: 'hero', __asset: 'src/assets/hero.png' }, tags: ['one'] }];

test('CMS data and declared field types retain their wire meaning', () => {
  assert.deepEqual(bridge.parseCmsRead({ data: { rows: entries, version: 2 } }), {
    data: { rows: entries, version: 2 },
  });
  assert.deepEqual(bridge.parseCmsMeta({ meta: { 'data/site.json': { title: 'text', image: 'image' } } }), {
    meta: { 'data/site.json': { title: 'text', image: 'image' } },
  });
  assert.deepEqual(bridge.parseCmsUsage({ files: ['pages/index.astro'] }), {
    files: ['pages/index.astro'],
  });
  assert.equal(bridge.parseCmsAsset({ value: '/hero.png' }), '/hero.png');
  assert.deepEqual(bridge.parseCmsAsset({ name: 'hero', asset: 'src/assets/hero.png' }), {
    __expr: 'hero',
    __asset: 'src/assets/hero.png',
  });
  assert.equal(bridge.parseCmsSuccess({ ok: true }), undefined);
});

test('CMS parsers reject malformed shapes, field types, and boundary overflow', () => {
  for (const value of [jsonNull, {}, [], { data: NaN }, { data: () => {} }]) {
    assert.throws(() => bridge.parseCmsRead(value));
  }
  for (const value of [jsonNull, {}, { meta: [] }, { meta: { file: { field: 'mystery' } } }, { meta: { file: { field: 12 } } }]) {
    assert.throws(() => bridge.parseCmsMeta(value));
  }
  for (const value of [jsonNull, {}, { files: ['ok', 1] }, { files: ['x'.repeat(32769)] }]) {
    assert.throws(() => bridge.parseCmsUsage(value));
  }
  for (const value of [jsonNull, {}, { value: 1 }, { name: 'hero' }, { name: 4, asset: 'hero' }]) {
    assert.throws(() => bridge.parseCmsAsset(value));
  }
  for (const value of [jsonNull, {}, { ok: 1 }, { ok: false }]) {
    assert.throws(() => bridge.parseCmsSuccess(value));
  }
  const data = 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1);
  assert.throws(() => bridge.parseCmsRead({ data }), /limit/);
  assert.throws(() => bridge.parseCmsRead({ data: Array(100001).fill(0) }), /limit/);
  assert.throws(() => types.parseDeclaredTypes({ ['x'.repeat(32769)]: 'text' }), /limit/);
  assert.throws(() => types.withDeclaredTypes([], {}, Array(129).fill('x')), /path limit/);
  assert.throws(() => types.withDeclaredTypes(Array(100001).fill({}), {}, []), /count limit/);
});

test('CMS requests parse replies outside the operating failure catch', async () => {
  const cases = [
    ['readCms', 'readCms', ['/project', 'data.json'], { data: entries }],
    ['readCmsMeta', 'cmsMeta', ['/project'], { meta: {} }],
    ['writeCms', 'writeCms', ['/project', 'data.json', entries], { ok: true }],
    ['writeCmsMeta', 'setCmsMeta', ['/project', 'data.json', { title: 'text' }], { ok: true }],
    ['readCmsUsage', 'cmsUsage', ['/project', 'data.json'], { files: [] }],
    ['deleteCms', 'deleteCms', ['/project', 'data.json'], { ok: true, rewritten: [] }],
    ['importCmsAsset', 'cmsAssetRef', ['/project', 'data.js#items', 'src/hero.png'], { name: 'hero', asset: 'src/hero.png' }],
  ];
  for (const [method, channel, args, reply] of cases) {
    let calls = 0;
    global.window = {
      avb: {
        [channel]: async () => {
          calls++;
          return reply;
        },
      },
    };
    assert.equal((await bridge[method](...args)).ok, true);
    assert.equal(calls, 1);
    assert.throws(() => bridge[method](jsonNull, ...args.slice(1)), /Expected string/);
    assert.equal(calls, 1, 'bad request never reaches IPC');
    window.avb[channel] = async () => {
      throw new Error('disk full');
    };
    assert.deepEqual(await bridge[method](...args), { ok: false, error: 'disk full' });
    window.avb[channel] = async () => jsonNull;
    await assert.rejects(bridge[method](...args), /Expected object/);
  }
});

test('a declared repeater with no entries yet stays a repeater', () => {
  const fields = [{ key: 'team', label: 'Team', type: 'list' }];
  const declared = { team: 'objects', tags: 'objects' };
  assert.equal(types.withDeclaredTypes(fields, declared, [])[0].type, 'objects');
  assert.equal(types.withDeclaredTypes(fields, { team: 'text' }, [])[0].type, 'list');
  assert.equal(types.bestType('objects', []), 'objects');
  assert.equal(types.bestType('objects', ['a']), 'list');
  assert.equal(types.bestType('list', []), 'list');
});
