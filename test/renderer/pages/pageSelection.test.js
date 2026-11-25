// Goal: the Pages panel's Select mode ticks the right rows: a click toggles one, Shift-click ticks a range in the order
// shown, Select all ticks what is shown (so a search narrows it), a folder is ticked exactly when everything in it is,
// and the homepage can never be ticked. The deletion asks main for the top-most ticks only.
// Method: the pure selection module over small trees, plus one tree of a thousand pages to pin that ticking stays a
// Set operation: no per-row work, a bound on the time of a whole select-all.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../helpers/rendererModule')('src/features/pages/pageSelection.ts');
const tree = require('../../helpers/rendererModule')('src/features/pages/pageTree.ts');
const { measureSpeedFactor } = require('../../helpers/rendererModule')('test/helpers/scaleFixtures.ts');

const page = (name) => ({ path: `/project/src/pages/${name}`, name, route: `/${name}` });
const EMPTY_ORDER = { entries: [] };
const NAMES = ['index.astro', '404.astro', 'about.astro', 'blog/index.astro', 'blog/a.md', 'blog/2024/b.md', 'docs/c.astro'];

function fixture(names = NAMES, folders = ['empty']) {
  const root = tree.buildPageTree(names.map(page), folders);
  const index = model.buildSelectionIndex(root);
  const rows = model.visibleTreeRows(root, EMPTY_ORDER, new Set());
  return { root, index, rows };
}
const keys = (selection) => [...selection].sort();

test('a page row toggles on and off, and the homepage refuses', () => {
  const { index } = fixture();
  const one = model.toggleRow(index, model.NO_SELECTION, 'about.astro');
  assert.deepEqual(keys(one), ['about.astro']);
  assert.deepEqual(keys(model.toggleRow(index, one, 'about.astro')), []);
  assert.equal(index.refused.get('index.astro'), 'homepage');
  assert.deepEqual(keys(model.toggleRow(index, model.NO_SELECTION, 'index.astro')), [], 'the homepage is never ticked');
  assert.equal(index.refused.has('404.astro'), false, 'the 404 page can be deleted, as Page settings allows');
  assert.throws(() => model.toggleRow(index, model.NO_SELECTION, 'nothing.astro'), /the toggled row exists/);
});

test('a folder ticks its whole subtree, and is ticked exactly when everything in it is', () => {
  const { index } = fixture();
  const blog = model.toggleRow(index, model.NO_SELECTION, 'blog/');
  assert.deepEqual(keys(blog), ['blog/', 'blog/2024/', 'blog/2024/b.md', 'blog/a.md', 'blog/index.astro']);
  const without = model.toggleRow(index, blog, 'blog/a.md');
  assert.equal(without.has('blog/'), false, 'unticking a page unticks its folder');
  assert.equal(without.has('blog/2024/'), true, 'a folder untouched keeps its tick');
  assert.deepEqual([...model.partialFolders(index, without)], ['blog/'], 'a folder with some of its pages ticked is partial');
  const restored = model.toggleRow(index, without, 'blog/a.md');
  assert.equal(restored.has('blog/'), true, 'ticking the last page ticks the folder');
  assert.deepEqual(keys(model.toggleRow(index, restored, 'blog/')), [], 'unticking a folder unticks everything in it');
});

test('an empty folder is ticked on its own', () => {
  const { index } = fixture();
  const empty = model.toggleRow(index, model.NO_SELECTION, 'empty/');
  assert.deepEqual(keys(empty), ['empty/']);
  assert.deepEqual(model.selectionTargets(empty), { pages: [], folders: ['empty'] });
  assert.deepEqual(keys(model.toggleRow(index, empty, 'empty/')), []);
});

test('Shift-click ticks the rows between two clicks in the order shown, either way round', () => {
  const { index, rows } = fixture();
  const order = rows.map((row) => row.key);
  assert.deepEqual(
    order,
    ['index.astro', 'blog/', 'blog/index.astro', 'blog/2024/', 'blog/2024/b.md', 'blog/a.md', 'docs/', 'docs/c.astro', 'empty/', 'about.astro', '404.astro'],
    'the tree as drawn: a folder is followed by its own rows',
  );
  const forward = model.selectRange(index, model.NO_SELECTION, rows, 'blog/a.md', 'docs/c.astro');
  const backward = model.selectRange(index, model.NO_SELECTION, rows, 'docs/c.astro', 'blog/a.md');
  assert.deepEqual(keys(forward), keys(backward));
  assert.equal(forward.has('docs/'), true, 'a folder in the range is ticked with its pages');
  assert.equal(forward.has('blog/a.md'), true);
  assert.equal(forward.has('blog/2024/b.md'), false, 'rows before the range stay unticked');
  const stale = model.selectRange(index, model.NO_SELECTION, rows, 'gone.astro', 'about.astro');
  assert.deepEqual(keys(stale), ['about.astro'], 'an anchor that is no longer shown falls back to one click');
});

test('a range never ticks the homepage', () => {
  const { index, rows } = fixture();
  const all = model.selectRange(index, model.NO_SELECTION, rows, rows[0].key, rows.at(-1).key);
  assert.equal(all.has('index.astro'), false);
  assert.equal(all.has('404.astro'), true);
});

test('Select all ticks what is shown: the whole tree, a collapsed folder with its pages, or only the search results', () => {
  const { root, index } = fixture();
  const collapsed = model.visibleTreeRows(root, EMPTY_ORDER, new Set(['blog']));
  assert.equal(
    collapsed.some((row) => row.key === 'blog/a.md'),
    false,
    'a collapsed folder shows no pages',
  );
  const all = model.selectAllRows(index, model.NO_SELECTION, collapsed);
  assert.equal(all.has('blog/a.md'), true, 'a ticked folder ticks pages it hides');
  assert.equal(all.has('index.astro'), false);
  const found = model.pageSelectionRows([page('about.astro'), page('blog/a.md')]);
  const searched = model.selectAllRows(index, model.NO_SELECTION, found);
  assert.deepEqual(keys(searched), ['about.astro', 'blog/a.md']);
  assert.equal(searched.has('blog/'), false, 'a folder with only some of its pages ticked is not');
});

test('the request names the top-most ticks, so a folder is one however many pages it holds', () => {
  const { index } = fixture();
  const blog = model.toggleRow(index, model.NO_SELECTION, 'blog/');
  const both = model.toggleRow(index, blog, 'about.astro');
  assert.deepEqual(model.selectionTargets(both), { pages: ['about.astro'], folders: ['blog'] });
  assert.equal(model.selectionCount(both), 2);
  assert.equal(model.selectionCount(model.NO_SELECTION), 0);
  const inner = model.toggleRow(index, model.NO_SELECTION, 'blog/2024/');
  assert.deepEqual(model.selectionTargets(inner), { pages: [], folders: ['blog/2024'] });
});

test('a scan that drops a page drops its tick, and its folder with it', () => {
  const { index } = fixture();
  const blog = model.toggleRow(index, model.NO_SELECTION, 'blog/');
  const smaller = fixture(NAMES.filter((name) => name !== 'blog/a.md')).index;
  const pruned = model.pruneSelection(smaller, blog);
  assert.equal(pruned.has('blog/a.md'), false);
  assert.equal(pruned.has('blog/'), true, 'what is left of the folder is all ticked');
  const gone = model.pruneSelection(fixture(['index.astro'], []).index, blog);
  assert.deepEqual(keys(gone), []);
});

test('a thousand pages tick at once, and each click is one set operation', () => {
  const names = ['index.astro'];
  for (let folder = 0; folder < 20; folder++) {
    for (let item = 0; item < 50; item++) {
      names.push(`f${folder}/p${item}.astro`);
    }
  }
  const { index, rows } = fixture(names, []);
  const started = performance.now();
  const all = model.selectAllRows(index, model.NO_SELECTION, rows);
  const clicked = model.toggleRow(index, all, 'f3/p4.astro');
  const elapsedMs = performance.now() - started;
  assert.equal(all.size, 1020, '1000 pages and 20 folders');
  assert.equal(clicked.has('f3/'), false);
  // Half a second on the reference machine, scaled by how much slower this runner measured in the same run.
  const elapsedMsMax = 500 * measureSpeedFactor();
  assert.ok(elapsedMs < elapsedMsMax, `select all and a click on a thousand pages took ${elapsedMs}ms`);
});
