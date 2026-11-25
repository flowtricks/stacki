// Goal: the rail order a person arranges is always complete and safe. The default order is the source of truth
// for which buttons exist; a stored order only arranges them. Every default id appears exactly once whatever the
// stored text holds (unknown ids dropped, repeats collapsed, missing ids placed where the default puts them),
// a role-hidden button keeps its place, and each move (within a list, across lists, reset) keeps every id.
// Settings is a third container: every move goes through `moveRailItem`, which keeps each id exactly once and never
// puts Settings or the AI button inside Settings. The geometry of a drag (threshold, which list, which slot, the
// Settings button and list, outside the rail) is pure numbers.
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

const DEFAULT = { top: ['pages', 'navigator', 'assets', 'code'], bottom: ['projectSettings', 'ai'], settings: ['secrets', 'mcp'] };
// A version 1 value predates the Settings list; it is still read, and its Settings items are placed by default.
const stored = (top, bottom) => JSON.stringify({ version: 1, top, bottom });
const storedWithSettings = (top, bottom, settings) => JSON.stringify({ version: 2, top, bottom, settings });
const resolve = (top, bottom) => model.resolveRailOrder(DEFAULT, model.parseStoredRailOrder(stored(top, bottom)));
const ids = (order) => [...order.top, ...order.bottom, ...order.settings].sort();
const ALL = [...DEFAULT.top, ...DEFAULT.bottom, ...DEFAULT.settings].sort();
const SETTINGS = DEFAULT.settings;

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
    '{"version":3,"top":[],"bottom":[],"settings":[]}',
    '{"version":2,"top":[],"bottom":[],"settings":"x"}',
    '{"version":1,"top":"x","bottom":[]}',
    '{"version":1,"top":[]}',
  ]) {
    assert.equal(model.parseStoredRailOrder(raw), undefined, String(raw));
  }
});

test('a stored order is applied, in both lists', () => {
  const order = resolve(['code', 'pages'], ['ai', 'assets', 'projectSettings', 'navigator']);
  assert.deepEqual(order, { top: ['code', 'pages'], bottom: ['ai', 'assets', 'projectSettings', 'navigator'], settings: SETTINGS });
});

test('unknown and repeated ids are dropped, and the first place of a repeat wins', () => {
  const order = resolve(['pages', 'ghost', 'pages', 'code'], ['pages', 'navigator', 'navigator']);
  assert.deepEqual(order.top, ['pages', 'assets', 'code'], 'assets follows its default neighbour in the list');
  assert.deepEqual(ids(order), ALL);
  assert.deepEqual(order.bottom, ['projectSettings', 'ai', 'navigator']);
});

test('ids a stored order lacks are placed where the default puts them', () => {
  const order = resolve(['code', 'pages'], ['ai']);
  assert.deepEqual(order, { top: ['code', 'pages', 'navigator', 'assets'], bottom: ['projectSettings', 'ai'], settings: SETTINGS });
  assert.deepEqual(ids(order), ALL);
  // A new first default id goes first in its list.
  const withNewFirst = model.resolveRailOrder({ top: ['fresh', 'pages'], bottom: [], settings: [] }, { top: ['pages'], bottom: [], settings: [] });
  assert.deepEqual(withNewFirst.top, ['fresh', 'pages']);
});

test('non-string, empty and oversized ids are dropped and lists are bounded', () => {
  const parsed = model.parseStoredRailOrder(stored([1, {}.missing, '', 'x'.repeat(65), {}, 'pages'], []));
  assert.deepEqual(parsed, { top: ['pages'], bottom: [], settings: [] });
  const many = Array.from({ length: 500 }, (_, index) => `id${index}`);
  const bounded = model.parseStoredRailOrder(stored(many, many));
  assert.equal(bounded.top.length, model.RAIL_ORDER_IDS_MAX);
  assert.equal(bounded.bottom.length, 0, 'ids already seen are not repeated in the other list');
});

test('stringify and parse round-trip', () => {
  const order = { top: ['code'], bottom: ['pages', 'ai'], settings: ['mcp'] };
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
  assert.deepEqual(moved, { top: ['navigator', 'assets', 'code'], bottom: ['projectSettings', 'pages', 'ai'], settings: SETTINGS });
  const emptied = { top: [], bottom: ['pages', 'navigator', 'assets', 'code', 'projectSettings', 'ai'], settings: SETTINGS };
  const back = model.placeRailItem(emptied, 'ai', 'top', undefined);
  assert.deepEqual(back.top, ['ai']);
  assert.deepEqual(ids(back), ALL);
  const intoEmptyBottom = model.placeRailItem({ top: ['a', 'b'], bottom: [], settings: [] }, 'a', 'bottom', undefined);
  assert.deepEqual(intoEmptyBottom, { top: ['b'], bottom: ['a'], settings: [] });
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
  assert.deepEqual(model.crossRailItem(DEFAULT, 'code', 'bottom'), {
    top: ['pages', 'navigator', 'assets'],
    bottom: ['code', 'projectSettings', 'ai'],
    settings: SETTINGS,
  });
  assert.deepEqual(model.crossRailItem(DEFAULT, 'ai', 'top'), {
    top: ['pages', 'navigator', 'assets', 'code', 'ai'],
    bottom: ['projectSettings'],
    settings: SETTINGS,
  });
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
  assert.equal(model.isDefaultRailOrder(DEFAULT, { top: [...DEFAULT.top], bottom: [...DEFAULT.bottom], settings: [...DEFAULT.settings] }), true);
  assert.equal(model.isDefaultRailOrder(DEFAULT, { ...DEFAULT, settings: ['mcp', 'secrets'] }), false, 'a Settings reorder is not the default');
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
  for (const file of ['railOrder.ts', 'railOrderStore.ts', 'railDrag.ts', 'railDragModel.ts', 'railItems.ts', 'SettingsRailRows.tsx']) {
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

// ---------------------------------------------------------------------------
// Settings as a third container
// ---------------------------------------------------------------------------

// Each id once across all three lists: the invariant every move must keep.
const assertWhole = (order) => {
  assert.deepEqual(ids(order), ALL);
  assert.ok(!order.settings.includes('projectSettings') && !order.settings.includes('ai'), 'no fixed item inside Settings');
};

test('moveRailItem moves a rail panel into Settings and a Settings view out onto the rail, keeping every id once', () => {
  const into = model.moveRailItem(DEFAULT, 'assets', { container: 'settings', beforeId: 'mcp' });
  assert.deepEqual(into.settings, ['secrets', 'assets', 'mcp']);
  assert.ok(!into.top.includes('assets'), 'it leaves the rail');
  assertWhole(into);
  const out = model.moveRailItem(into, 'secrets', { container: 'bottom', beforeId: 'projectSettings' });
  assert.deepEqual(out.bottom, ['secrets', 'projectSettings', 'ai']);
  assert.deepEqual(out.settings, ['assets', 'mcp']);
  assertWhole(out);
  const reordered = model.moveRailItem(DEFAULT, 'mcp', { container: 'settings', beforeId: 'secrets' });
  assert.deepEqual(reordered.settings, ['mcp', 'secrets']);
  assertWhole(reordered);
});

test('moveRailItem negative space: unknown id, fixed item, same place, foreign before id, empty containers', () => {
  assert.equal(model.moveRailItem(DEFAULT, 'ghost', { container: 'settings', beforeId: undefined }), DEFAULT, 'an unknown id is no move');
  assert.equal(model.moveRailItem(DEFAULT, 'projectSettings', { container: 'settings', beforeId: undefined }), DEFAULT, 'Settings never goes inside itself');
  assert.equal(model.moveRailItem(DEFAULT, 'ai', { container: 'settings', beforeId: 'secrets' }), DEFAULT, 'the AI button is fixed to the rail');
  assert.equal(model.moveRailItem(DEFAULT, 'mcp', { container: 'settings', beforeId: undefined }), DEFAULT, 'a move to where it is returns the same order');
  assert.equal(model.moveRailItem(DEFAULT, 'secrets', { container: 'settings', beforeId: 'mcp' }), DEFAULT, 'before its own follower is where it is');
  assert.equal(model.moveRailItem(DEFAULT, 'pages', { container: 'settings', beforeId: 'navigator' }), DEFAULT, 'a before id outside the target is no move');
  // Fixed items still reorder on the rail.
  assert.deepEqual(model.moveRailItem(DEFAULT, 'ai', { container: 'bottom', beforeId: 'projectSettings' }).bottom, ['ai', 'projectSettings']);
  // Every item moved into Settings, then every Settings item out: no container needs anything in it.
  let order = DEFAULT;
  for (const id of [...DEFAULT.top]) {
    order = model.moveIntoSettings(order, id);
  }
  assert.deepEqual(order.top, []);
  assertWhole(order);
  for (const id of [...order.settings]) {
    order = model.moveOutOfSettings(order, id);
  }
  assert.deepEqual(order.settings, []);
  assert.deepEqual(order.bottom.slice(-2), ['projectSettings', 'ai'], 'rows leave for the place right above Settings');
  assertWhole(order);
  assert.equal(model.moveOutOfSettings(order, 'pages'), order, 'an item not in Settings is not moved out');
});

test('moveRailItem asserts its invariant: an order with a repeated id or a fixed item in Settings is a programmer error', () => {
  assert.throws(
    () => model.moveRailItem({ top: ['a', 'a'], bottom: [], settings: [] }, 'a', { container: 'bottom', beforeId: undefined }),
    /holds each id once/,
  );
  assert.throws(() => model.moveRailItem({ top: ['a'], bottom: [], settings: ['a'] }, 'a', { container: 'top', beforeId: undefined }), /holds each id once/);
  assert.throws(
    () => model.moveRailItem({ top: ['a'], bottom: [], settings: ['ai'] }, 'a', { container: 'settings', beforeId: undefined }),
    /never go inside Settings/,
  );
});

test('a random walk of moves never loses or repeats an item', () => {
  const containers = ['top', 'bottom', 'settings'];
  // A fixed seed: a failure repeats exactly.
  let seed = 7;
  const next = (count) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * count);
  };
  let order = DEFAULT;
  for (let step = 0; step < 500; step += 1) {
    const id = ALL[next(ALL.length)];
    const container = containers[next(containers.length)];
    const list = order[container];
    const beforeId = next(2) === 0 ? undefined : list[next(Math.max(list.length, 1))];
    order = model.moveRailItem(order, id, { container, beforeId });
    assertWhole(order);
  }
});

test('the stored Settings list is parsed and resolved: unknown ids dropped, fixed items put back on the rail, new views appended', () => {
  const parsed = model.parseStoredRailOrder(storedWithSettings(['pages'], ['ai'], ['assets', 'ghost', 'pages', 7, 'projectSettings']));
  assert.deepEqual(parsed, { top: ['pages'], bottom: ['ai'], settings: ['assets', 'ghost', 'projectSettings'] }, 'a repeat of a rail id keeps its rail place');
  const order = model.resolveRailOrder(DEFAULT, parsed);
  assert.deepEqual(order.settings, ['secrets', 'mcp', 'assets'], 'the Settings views it lacks go where the default puts them: first, in default order');
  assert.ok(order.bottom.includes('projectSettings'), 'Settings stored inside itself is put back on the rail');
  assertWhole(order);
  // A version 1 value: the Settings list comes whole from the default.
  assert.deepEqual(resolve(['code'], ['ai']).settings, SETTINGS);
  const bounded = model.parseStoredRailOrder(
    storedWithSettings(
      [],
      [],
      Array.from({ length: 500 }, (_, index) => `id${index}`),
    ),
  );
  assert.equal(bounded.settings.length, model.RAIL_ORDER_IDS_MAX);
});

test('positions in Settings are announced as Settings', () => {
  const shown = new Set(['secrets', 'mcp']);
  assert.deepEqual(model.railPosition(DEFAULT, shown, 'mcp'), { group: 'settings', position: 2, count: 2 });
  const shifted = model.shiftRailItem(DEFAULT, shown, 'mcp', 'up');
  assert.deepEqual(shifted.settings, ['mcp', 'secrets']);
});

test('the Settings button and the Settings list are drop targets; the button edges still reorder around it', () => {
  const withSettings = {
    ...measure,
    settingsButton: { top: 758, bottom: 790 },
    settings: {
      left: 50,
      right: 300,
      top: 100,
      bottom: 400,
      rows: [
        { id: 'secrets', top: 110, bottom: 140 },
        { id: 'mcp', top: 146, bottom: 176 },
      ],
    },
  };
  assert.deepEqual(model.slotAt(withSettings, { x: 20, y: 774 }), { group: 'settingsButton' }, 'the middle of Settings drops inside it');
  assert.deepEqual(model.slotAt(withSettings, { x: 20, y: 760 }), { group: 'bottom', beforeId: 'z', lineY: 756 }, 'its top edge reorders before it');
  assert.deepEqual(model.slotAt(withSettings, { x: 100, y: 120 }), { group: 'settings', beforeId: 'secrets', lineY: 109 });
  assert.deepEqual(model.slotAt(withSettings, { x: 100, y: 150 }), { group: 'settings', beforeId: 'mcp', lineY: 145 });
  assert.deepEqual(model.slotAt(withSettings, { x: 100, y: 390 }), { group: 'settings', beforeId: undefined, lineY: 177 });
  const empty = { ...withSettings, settings: { ...withSettings.settings, rows: [] } };
  assert.deepEqual(model.slotAt(empty, { x: 100, y: 300 }), { group: 'settings', beforeId: undefined, lineY: 102 }, 'an empty Settings list is still a target');
  assert.equal(model.slotAt(withSettings, { x: 400, y: 120 }), undefined, 'beside the list is no target');
  // Without the Settings zones (a fixed item is dragged), the geometry is the rail's alone.
  assert.deepEqual(model.slotAt(measure, { x: 20, y: 774 }), { group: 'bottom', beforeId: undefined, lineY: 792 });
});

test('a drop turns into the order: the Settings button appends to Settings', () => {
  assert.deepEqual(model.orderAfterDrop(DEFAULT, 'code', { group: 'settingsButton' }).settings, ['secrets', 'mcp', 'code']);
  assert.deepEqual(model.orderAfterDrop(DEFAULT, 'mcp', { group: 'top', beforeId: 'pages', lineY: 0 }).top[0], 'mcp');
  assert.equal(model.orderAfterDrop(DEFAULT, 'ai', { group: 'settingsButton' }), DEFAULT);
});
