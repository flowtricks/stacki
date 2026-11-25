// Goal: the Assets panel's sorts, folder order, middle-cut names, item layout and remembered view are
// exact, total and safe on bad input, because the panel draws whatever these pure functions return.
// Methodology: run the real modules (src/features/assets/assetOrder.ts, assetLayout.ts,
// assetViewPreferences.ts) through the app's bundler and check them on hand-made lists: natural and
// case-blind names, unicode, equal and missing modified times, size ties, and every sort reversed.
// The layout checks the grid's column count against CSS auto-fill arithmetic and that the drawn
// window stays bounded by the viewport however long the list is. The view preferences are checked
// against an in-memory storage: restored per project, independent between projects, bounded, and
// falling back to the defaults on anything malformed, including a storage that throws.
const test = require('node:test');
const assert = require('node:assert/strict');
const order = require('../../helpers/rendererModule')('src/features/assets/assetOrder.ts');
const layout = require('../../helpers/rendererModule')('src/features/assets/assetLayout.ts');
const preferences = require('../../helpers/rendererModule')('src/features/assets/assetViewPreferences.ts');

const file = (name, extra = {}) => ({ rel: `public/${name}`, name, size: 10, ...extra });
const names = (files) => files.map((entry) => entry.name);

test('alphabetical order is natural, case-blind and stable', () => {
  const files = [file('img10.png'), file('Img2.png'), file('img1.png'), file('banner.svg')];
  assert.deepEqual(names(order.sortAssets(files, 'nameAscending')), ['banner.svg', 'img1.png', 'Img2.png', 'img10.png']);
  assert.deepEqual(names(order.sortAssets(files, 'nameDescending')), ['img10.png', 'Img2.png', 'img1.png', 'banner.svg']);
  assert.deepEqual(names(files), ['img10.png', 'Img2.png', 'img1.png', 'banner.svg'], 'the input is not reordered');
});

test('names that differ only in case keep one order by path, both ways round', () => {
  const upper = { rel: 'public/a/Logo.svg', name: 'Logo.svg', size: 1 };
  const lower = { rel: 'public/b/logo.svg', name: 'logo.svg', size: 1 };
  assert.deepEqual(order.sortAssets([lower, upper], 'nameAscending'), [upper, lower]);
  assert.deepEqual(order.sortAssets([upper, lower], 'nameAscending'), [upper, lower]);
  assert.deepEqual(order.sortAssets([upper, lower], 'nameDescending'), [lower, upper]);
});

test('unicode names sort with their base letters and never throw', () => {
  const files = [file('zèbre.png'), file('Éclair.png'), file('eagle.png'), file('😀 smile.png')];
  const sorted = names(order.sortAssets(files, 'nameAscending'));
  assert.equal(sorted.indexOf('eagle.png') < sorted.indexOf('Éclair.png'), true);
  assert.equal(sorted.indexOf('Éclair.png') < sorted.indexOf('zèbre.png'), true);
  assert.equal(sorted.length, 4);
});

test('newest and oldest read the modified time; ties fall to the name', () => {
  const files = [
    file('b.png', { modifiedMs: 200 }),
    file('a.png', { modifiedMs: 200 }),
    file('c.png', { modifiedMs: 300 }),
    file('d.png', { modifiedMs: 100 }),
  ];
  assert.deepEqual(names(order.sortAssets(files, 'newest')), ['c.png', 'a.png', 'b.png', 'd.png']);
  assert.deepEqual(names(order.sortAssets(files, 'oldest')), ['d.png', 'a.png', 'b.png', 'c.png']);
});

test('a file without a modified time goes last in either time order', () => {
  const files = [file('untimed-b.png'), file('timed.png', { modifiedMs: 5 }), file('untimed-a.png')];
  assert.deepEqual(names(order.sortAssets(files, 'newest')), ['timed.png', 'untimed-a.png', 'untimed-b.png']);
  assert.deepEqual(names(order.sortAssets(files, 'oldest')), ['timed.png', 'untimed-a.png', 'untimed-b.png']);
  assert.deepEqual(names(order.sortAssets([file('z.png'), file('a.png')], 'newest')), ['a.png', 'z.png'], 'no times at all is A to Z');
});

test('largest and smallest read the size; ties fall to the name', () => {
  const files = [file('b.png', { size: 5 }), file('a.png', { size: 5 }), file('big.png', { size: 900 }), file('tiny.png', { size: 0 })];
  assert.deepEqual(names(order.sortAssets(files, 'largest')), ['big.png', 'a.png', 'b.png', 'tiny.png']);
  assert.deepEqual(names(order.sortAssets(files, 'smallest')), ['tiny.png', 'a.png', 'b.png', 'big.png']);
});

test('every sort keeps every file, and an empty or single list as it is', () => {
  for (const sort of order.ASSET_SORTS) {
    assert.deepEqual(order.sortAssets([], sort), []);
    assert.deepEqual(names(order.sortAssets([file('only.png')], sort)), ['only.png']);
    assert.equal(order.sortAssets([file('a'), file('b'), file('c')], sort).length, 3);
  }
});

test('folders sort A to Z, naturally, whatever the files do', () => {
  const folders = [
    { rel: 'public/icons10', name: 'icons10' },
    { rel: 'public/Icons2', name: 'Icons2' },
    { rel: 'public/backgrounds', name: 'backgrounds' },
  ];
  assert.deepEqual(names(order.sortFolders(folders)), ['backgrounds', 'Icons2', 'icons10']);
});

test('the sort and view guards accept their values and nothing else', () => {
  for (const sort of order.ASSET_SORTS) {
    assert.equal(order.isAssetSort(sort), true);
  }
  for (const bad of ['Newest', '', undefined, 3, { kind: 'newest' }]) {
    assert.equal(order.isAssetSort(bad), false);
    assert.equal(order.isAssetView(bad), false);
  }
  assert.deepEqual(order.ASSET_VIEWS, ['grid', 'list', 'compact']);
  assert.equal(order.ASSET_SORT_DEFAULT, 'newest');
  assert.equal(order.ASSET_VIEW_DEFAULT, 'grid');
});

test('a middle cut keeps the end of the name and joins back to the whole name', () => {
  assert.deepEqual(order.middleParts('placeholder.svg', 5), { head: 'placeholde', tail: 'r.svg' });
  assert.deepEqual(order.middleParts('rich-text-image-placeholder.svg', 12), { head: 'rich-text-image-pla', tail: 'ceholder.svg' });
  assert.deepEqual(order.middleParts('a.png', 12), { head: 'a.p', tail: 'ng' }, 'the tail is at most half the name');
  assert.deepEqual(order.middleParts('', 5), { head: '', tail: '' });
  assert.deepEqual(order.middleParts('😀😀😀😀', 1), { head: '😀😀😀', tail: '😀' }, 'an emoji is never split');
  assert.throws(() => order.middleParts('x', 0), /The tail keeps at least one character/);
  assert.throws(() => order.middleParts('x', 1.5), /The tail is a whole number of characters/);
});

test('grid columns follow the panel width as CSS auto-fill counts them', () => {
  assert.equal(layout.itemGeometry('grid', 0).columnCount, 1);
  assert.equal(layout.itemGeometry('grid', 232).columnCount, 3, 'the default panel holds three columns');
  assert.equal(layout.itemGeometry('grid', 320).columnCount, 4);
  assert.equal(layout.itemGeometry('grid', 560).columnCount, 7);
  const geometry = layout.itemGeometry('grid', 232);
  assert.equal(geometry.rowPitchPx, Math.ceil(geometry.tileWidthPx + layout.GRID_NAME_BLOCK_PX + layout.VIEW_METRICS.grid.gapPx));
  assert.equal(layout.itemGeometry('list', 500).columnCount, 1);
  assert.equal(layout.itemGeometry('compact', 500).rowPitchPx, layout.VIEW_METRICS.compact.rowHeightPx + layout.VIEW_METRICS.compact.gapPx);
  assert.throws(() => layout.itemGeometry('grid', -1), /A width is never negative/);
});

test('the drawn window is bounded by the viewport, not by the list', () => {
  const geometry = layout.itemGeometry('compact', 240);
  const viewportHeightPx = 600;
  const visibleRows = Math.ceil(viewportHeightPx / geometry.rowPitchPx) + 1 + 2 * layout.OVERSCAN_ROWS;
  for (const itemCount of [10, 5000, 100000]) {
    for (const viewportTopPx of [0, 12345, itemCount * geometry.rowPitchPx]) {
      const window = layout.itemWindow({ itemCount, geometry, viewportTopPx, viewportHeightPx });
      assert.equal(window.itemEnd - window.itemStart <= visibleRows, true, `${itemCount} items at ${viewportTopPx}px`);
      assert.equal(window.itemEnd <= itemCount, true);
      assert.equal(window.rowCount, itemCount);
    }
  }
  const top = layout.itemWindow({ itemCount: 5000, geometry, viewportTopPx: -300, viewportHeightPx });
  assert.equal(top.itemStart, 0, 'a list still below the fold draws from its start');
  const unmeasured = layout.itemWindow({ itemCount: 5000, geometry, viewportTopPx: 0, viewportHeightPx: 0 });
  assert.equal(unmeasured.itemEnd > 0, true, 'an unmeasured panel still draws a first screen');
  assert.throws(() => layout.itemWindow({ itemCount: -1, geometry, viewportTopPx: 0, viewportHeightPx }), /The item count is not negative/);
});

test('arrow keys move in two dimensions on the grid and stop at the ends', () => {
  assert.equal(layout.nextIndex('ArrowRight', 0, 10, 3), 1);
  assert.equal(layout.nextIndex('ArrowDown', 1, 10, 3), 4);
  assert.equal(layout.nextIndex('ArrowUp', 1, 10, 3), 0);
  assert.equal(layout.nextIndex('ArrowDown', 8, 10, 3), 9);
  assert.equal(layout.nextIndex('ArrowLeft', 0, 10, 3), 0);
  assert.equal(layout.nextIndex('Home', 7, 10, 3), 0);
  assert.equal(layout.nextIndex('End', 2, 10, 3), 9);
  assert.equal(layout.nextIndex('ArrowDown', 2, 10, 1), 3, 'a list moves one row at a time');
  assert.equal(layout.nextIndex('Enter', 2, 10, 3), undefined);
  assert.throws(() => layout.nextIndex('ArrowDown', 0, 0, 3), /Moving needs an item to move to/);
});

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : JSON.parse('null')),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('the view and sort are remembered per project, each independently', () => {
  const storage = memoryStorage();
  assert.deepEqual(preferences.loadAssetViewChoice('/one', storage), { view: 'grid', sort: 'newest' }, 'a new project opens on the defaults');
  preferences.saveAssetViewChoice('/one', { view: 'list', sort: 'nameAscending' }, storage);
  preferences.saveAssetViewChoice('/two', { view: 'compact', sort: 'largest' }, storage);
  assert.deepEqual(preferences.loadAssetViewChoice('/one', storage), { view: 'list', sort: 'nameAscending' });
  assert.deepEqual(preferences.loadAssetViewChoice('/two', storage), { view: 'compact', sort: 'largest' });
  preferences.saveAssetViewChoice('/one', { view: 'grid', sort: 'oldest' }, storage);
  assert.deepEqual(preferences.loadAssetViewChoice('/two', storage), { view: 'compact', sort: 'largest' }, 'changing one leaves the other');
  assert.deepEqual(preferences.loadAssetViewChoice('C:\\Sites\\One', storage), { view: 'grid', sort: 'newest' }, 'a Windows path is its own project');
});

test('the remembered list is bounded and forgets the least recently changed first', () => {
  const storage = memoryStorage();
  for (let index = 0; index <= preferences.ASSET_VIEW_PROJECTS_MAX; index += 1) {
    preferences.saveAssetViewChoice(`/project-${index}`, { view: 'list', sort: 'oldest' }, storage);
  }
  const stored = preferences.parseStoredAssetViews(storage.values.get(preferences.ASSET_VIEWS_KEY));
  assert.equal(stored.length, preferences.ASSET_VIEW_PROJECTS_MAX);
  assert.deepEqual(preferences.loadAssetViewChoice('/project-0', storage), { view: 'grid', sort: 'newest' });
  assert.deepEqual(preferences.loadAssetViewChoice(`/project-${preferences.ASSET_VIEW_PROJECTS_MAX}`, storage), { view: 'list', sort: 'oldest' });
});

test('anything malformed in storage is dropped, never trusted', () => {
  const good = ['/good', { view: 'list', sort: 'smallest' }];
  for (const raw of [undefined, 42, '', 'not json', '{}', '[1,2]', JSON.stringify([['/a', { view: 'tiles', sort: 'newest' }]])]) {
    assert.deepEqual(preferences.parseStoredAssetViews(raw), []);
  }
  const mixed = JSON.stringify([
    good,
    ['', { view: 'list', sort: 'newest' }],
    ['/x'],
    ['/y', { view: 'list' }],
    ['/z', 'grid'],
    ['/good', { view: 'grid', sort: 'newest' }],
  ]);
  assert.deepEqual(preferences.parseStoredAssetViews(mixed), [good], 'only the valid entry, once');
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  assert.deepEqual(preferences.loadAssetViewChoice('/one', throwing), { view: 'grid', sort: 'newest' });
  assert.doesNotThrow(() => preferences.saveAssetViewChoice('/one', { view: 'list', sort: 'newest' }, throwing));
  assert.throws(() => preferences.saveAssetViewChoice('', { view: 'list', sort: 'newest' }, memoryStorage()), /A remembered choice belongs to a project/);
});
