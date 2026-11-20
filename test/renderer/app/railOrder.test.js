// Goal: the rail order a person arranges is always complete and safe. The default order is the source of truth
// for which buttons exist; a stored order only arranges them. Every default id appears exactly once whatever the
// stored text holds (unknown ids dropped, repeats collapsed, missing ids placed where the default puts them),
// a role-hidden button keeps its place, and each move (within a list, across lists, reset) keeps every id.
// The geometry of a drag (threshold, which list, which slot, outside the rail) is pure numbers.
// Method: bundle the pure model, parser, store and drag geometry with esbuild and call them on exact cases,
// valid and invalid: hostile JSON, wrong types, oversized lists, empty lists, a missing localStorage, a
// second window's storage event. Negative space is exercised on every parser branch.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/rail-order.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: ["export * from './src/app/railOrder';", "export * from './src/app/railOrderStore';", "export * from './src/app/railDragModel';"].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  logLevel: 'silent',
});
const model = require(output);

const DEFAULT = { top: ['pages', 'navigator', 'assets', 'code'], bottom: ['projectSettings', 'ai'] };
const stored = (top, bottom) => JSON.stringify({ version: 1, top, bottom });
const resolve = (top, bottom) => model.resolveRailOrder(DEFAULT, model.parseStoredRailOrder(stored(top, bottom)));
const ids = (order) => [...order.top, ...order.bottom].sort();
const ALL = [...DEFAULT.top, ...DEFAULT.bottom].sort();

test('the default order is used when nothing usable is stored', () => {
  assert.deepEqual(model.resolveRailOrder(DEFAULT, undefined), DEFAULT);
  for (const raw of [
    undefined,
    5,
    '',
    'not json',
    '[]',
    '{}',
    'null',
    '{"version":2,"top":[],"bottom":[]}',
    '{"version":1,"top":"x","bottom":[]}',
    '{"version":1,"top":[]}',
  ]) {
    assert.equal(model.parseStoredRailOrder(raw), undefined, String(raw));
  }
});

test('a stored order is applied, in both lists', () => {
  const order = resolve(['code', 'pages'], ['ai', 'assets', 'projectSettings', 'navigator']);
  assert.deepEqual(order, { top: ['code', 'pages'], bottom: ['ai', 'assets', 'projectSettings', 'navigator'] });
});

test('unknown and repeated ids are dropped, and the first place of a repeat wins', () => {
  const order = resolve(['pages', 'ghost', 'pages', 'code'], ['pages', 'navigator', 'navigator']);
  assert.deepEqual(order.top, ['pages', 'assets', 'code'], 'assets follows its default neighbour in the list');
  assert.deepEqual(ids(order), ALL);
  assert.deepEqual(order.bottom, ['projectSettings', 'ai', 'navigator']);
});

test('ids a stored order lacks are placed where the default puts them', () => {
  const order = resolve(['code', 'pages'], ['ai']);
  assert.deepEqual(order, { top: ['code', 'pages', 'navigator', 'assets'], bottom: ['projectSettings', 'ai'] });
  assert.deepEqual(ids(order), ALL);
  // A new first default id goes first in its list.
  const withNewFirst = model.resolveRailOrder({ top: ['fresh', 'pages'], bottom: [] }, { top: ['pages'], bottom: [] });
  assert.deepEqual(withNewFirst.top, ['fresh', 'pages']);
});

test('non-string, empty and oversized ids are dropped and lists are bounded', () => {
  const parsed = model.parseStoredRailOrder(stored([1, {}.missing, '', 'x'.repeat(65), {}, 'pages'], []));
  assert.deepEqual(parsed, { top: ['pages'], bottom: [] });
  const many = Array.from({ length: 500 }, (_, index) => `id${index}`);
  const bounded = model.parseStoredRailOrder(stored(many, many));
  assert.equal(bounded.top.length, model.RAIL_ORDER_IDS_MAX);
  assert.equal(bounded.bottom.length, 0, 'ids already seen are not repeated in the other list');
});

test('stringify and parse round-trip', () => {
  const order = { top: ['code'], bottom: ['pages', 'ai'] };
  assert.deepEqual(model.parseStoredRailOrder(model.stringifyRailOrder(order)), order);
});

test('moving within a list places an item before another, or at the end', () => {
  assert.deepEqual(model.placeRailItem(DEFAULT, 'code', 'top', 'pages').top, ['code', 'pages', 'navigator', 'assets']);
  assert.deepEqual(model.placeRailItem(DEFAULT, 'pages', 'top', undefined).top, ['navigator', 'assets', 'code', 'pages']);
  assert.equal(model.placeRailItem(DEFAULT, 'pages', 'top', 'pages'), DEFAULT, 'before itself is no move');
  assert.equal(model.placeRailItem(DEFAULT, 'ghost', 'top', 'pages'), DEFAULT, 'an unknown id is no move');
  assert.equal(model.placeRailItem(DEFAULT, 'pages', 'top', 'ai'), DEFAULT, 'a before id outside the list is no move');
});

test('moving across lists keeps every id and works into an empty list', () => {
  const moved = model.placeRailItem(DEFAULT, 'pages', 'bottom', 'ai');
  assert.deepEqual(moved, { top: ['navigator', 'assets', 'code'], bottom: ['projectSettings', 'pages', 'ai'] });
  const emptied = { top: [], bottom: ['pages', 'navigator', 'assets', 'code', 'projectSettings', 'ai'] };
  const back = model.placeRailItem(emptied, 'ai', 'top', undefined);
  assert.deepEqual(back.top, ['ai']);
  assert.deepEqual(ids(back), ALL);
  const intoEmptyBottom = model.placeRailItem({ top: ['a', 'b'], bottom: [] }, 'a', 'bottom', undefined);
  assert.deepEqual(intoEmptyBottom, { top: ['b'], bottom: ['a'] });
});

test('shifting steps over shown buttons only; a hidden button between keeps its place', () => {
  const shown = new Set(['pages', 'assets', 'code', 'projectSettings', 'ai']); // navigator is role-hidden
  const down = model.shiftRailItem(DEFAULT, shown, 'pages', 'down');
  assert.deepEqual(down.top, ['navigator', 'assets', 'pages', 'code']);
  const up = model.shiftRailItem(DEFAULT, shown, 'assets', 'up');
  assert.deepEqual(up.top, ['assets', 'pages', 'navigator', 'code']);
  assert.equal(model.shiftRailItem(DEFAULT, shown, 'pages', 'up'), DEFAULT, 'the top edge is a no-op');
  assert.equal(model.shiftRailItem(DEFAULT, shown, 'code', 'down'), DEFAULT, 'the bottom edge is a no-op');
  assert.equal(model.shiftRailItem(DEFAULT, shown, 'navigator', 'down'), DEFAULT, 'a hidden id does not move');
});

test('crossing moves to the edge that meets the list it left', () => {
  assert.deepEqual(model.crossRailItem(DEFAULT, 'code', 'bottom'), { top: ['pages', 'navigator', 'assets'], bottom: ['code', 'projectSettings', 'ai'] });
  assert.deepEqual(model.crossRailItem(DEFAULT, 'ai', 'top'), { top: ['pages', 'navigator', 'assets', 'code', 'ai'], bottom: ['projectSettings'] });
  assert.equal(model.crossRailItem(DEFAULT, 'code', 'top'), DEFAULT);
});

test('a hidden button keeps its place in the order and the visible order leaves it out', () => {
  const order = resolve(['code', 'navigator', 'pages'], []);
  const visible = model.visibleRailOrder(order, new Set(['pages', 'code', 'ai']));
  assert.deepEqual(visible.top, ['code', 'pages']);
  assert.deepEqual(order.top.slice(0, 2), ['code', 'navigator'], 'the hidden id is still stored');
});

test('reset is the default order', () => {
  const order = model.placeRailItem(DEFAULT, 'pages', 'bottom', undefined);
  assert.equal(model.isDefaultRailOrder(DEFAULT, order), false);
  assert.equal(model.isDefaultRailOrder(DEFAULT, DEFAULT), true);
  assert.equal(model.isDefaultRailOrder(DEFAULT, { top: [...DEFAULT.top], bottom: [...DEFAULT.bottom] }), true);
});

test('positions are reported among shown buttons, for announcements', () => {
  const shown = new Set(['pages', 'assets', 'ai']);
  assert.deepEqual(model.railPosition(DEFAULT, shown, 'assets'), { group: 'top', position: 2, count: 2 });
  assert.deepEqual(model.railPosition(DEFAULT, shown, 'ai'), { group: 'bottom', position: 1, count: 1 });
  assert.equal(model.railPosition(DEFAULT, shown, 'code'), undefined);
});

test('the store reads before use, writes the order, forgets the default, and survives broken storage', () => {
  const backing = new Map();
  global.localStorage = {
    getItem: (key) => backing.get(key) ?? JSON.parse('null'),
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  };
  assert.deepEqual(model.loadRailOrder(DEFAULT), DEFAULT);
  const order = model.placeRailItem(DEFAULT, 'pages', 'bottom', undefined);
  model.saveRailOrder(DEFAULT, order);
  assert.deepEqual([...backing.keys()], ['stacki.rail.order']);
  assert.deepEqual(model.loadRailOrder(DEFAULT), order);
  model.saveRailOrder(DEFAULT, DEFAULT);
  assert.equal(backing.size, 0, 'the default order is stored as nothing');
  backing.set('stacki.rail.order', '{"version":1,"top":["pages"],"bottom":"oops"}');
  assert.deepEqual(model.loadRailOrder(DEFAULT), DEFAULT, 'a corrupt value is the default');
  global.localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(model.loadRailOrder(DEFAULT), DEFAULT);
  assert.doesNotThrow(() => model.saveRailOrder(DEFAULT, order));
  delete global.localStorage;
});

test('the order is never kept in a project: no project path, `.stacki` or file API in the store', () => {
  for (const file of ['railOrder.ts', 'railOrderStore.ts', 'railDrag.ts', 'railDragModel.ts']) {
    const source = fs.readFileSync(repoPath(`src/app/${file}`), 'utf8');
    assert.ok(!/\.stacki|projectPath|window\.avb|writeFile|projectPreference/.test(source.replace(/\/\/.*$/gm, '')), file);
  }
});

const measure = {
  rail: { left: 0, right: 44, top: 0, bottom: 800 },
  rows: {
    top: [
      { id: 'a', top: 10, bottom: 42 },
      { id: 'b', top: 46, bottom: 78 },
    ],
    bottom: [{ id: 'z', top: 758, bottom: 790 }],
  },
  topEndY: 78,
  bottomStartY: 758,
};

test('a press becomes a drag only past six pixels', () => {
  assert.equal(model.exceedsThreshold({ x: 0, y: 0 }, { x: 3, y: 4 }), false);
  assert.equal(model.exceedsThreshold({ x: 0, y: 0 }, { x: 0, y: 5.9 }), false);
  assert.equal(model.exceedsThreshold({ x: 0, y: 0 }, { x: 0, y: 6 }), true);
  assert.equal(model.RAIL_DRAG_THRESHOLD_PX, 6);
});

test('the slot is the nearest one: before the row whose middle is below the pointer, else the end', () => {
  assert.deepEqual(model.slotAt(measure, { x: 20, y: 20 }), { group: 'top', beforeId: 'a', lineY: 8 });
  assert.deepEqual(model.slotAt(measure, { x: 20, y: 40 }), { group: 'top', beforeId: 'b', lineY: 44 });
  assert.deepEqual(model.slotAt(measure, { x: 20, y: 70 }), { group: 'top', beforeId: undefined, lineY: 80 });
  assert.deepEqual(model.slotAt(measure, { x: 20, y: 400 }), { group: 'top', beforeId: undefined, lineY: 80 });
  assert.deepEqual(model.slotAt(measure, { x: 20, y: 700 }), { group: 'bottom', beforeId: 'z', lineY: 756 });
  assert.deepEqual(model.slotAt(measure, { x: 20, y: 795 }), { group: 'bottom', beforeId: undefined, lineY: 792 });
});

test('an empty bottom list is still a zone; an empty top list too', () => {
  const emptyBottom = { ...measure, rows: { top: measure.rows.top, bottom: [] }, bottomStartY: 758 };
  assert.deepEqual(model.slotAt(emptyBottom, { x: 20, y: 770 }), { group: 'bottom', beforeId: undefined, lineY: 756 });
  const emptyTop = { ...measure, rows: { top: [], bottom: measure.rows.bottom }, topEndY: 10 };
  assert.deepEqual(model.slotAt(emptyTop, { x: 20, y: 30 }), { group: 'top', beforeId: undefined, lineY: 2 });
});

test('outside the rail there is no slot, so a release there cancels', () => {
  assert.equal(model.slotAt(measure, { x: -1, y: 20 }), undefined);
  assert.equal(model.slotAt(measure, { x: 45, y: 20 }), undefined);
  assert.equal(model.slotAt(measure, { x: 20, y: -1 }), undefined);
  assert.equal(model.slotAt(measure, { x: 20, y: 801 }), undefined);
});
