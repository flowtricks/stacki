// Goal: a collection table sorts by any column, smallest first then largest first, with
// empty values last; shows each cell as a short line; offers only fields with a line to
// show as columns; and grows wide enough to scroll sideways instead of squeezing columns.
// Method: the pure helpers behind the table run on summaries and fields written here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/remote-columns.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/cms/remoteColumns.ts')],
  absWorkingDir: ROOT,
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  logLevel: 'silent',
});
const { cellText, columnFields, nextSort, sortItems, tableGrid } = require(output);

const item = (id, title, cells, updatedAt = '2026-01-01T00:00:00Z') => ({
  id,
  title,
  subtitle: undefined,
  imageURL: undefined,
  status: 'published',
  updatedAt,
  cells,
});
const rows = [
  item('a', 'Item 10', { order: 3, author: 'Zed' }, '2026-03-01T00:00:00Z'),
  item('b', 'item 2', { order: 1 }, '2026-01-01T00:00:00Z'),
  item('c', 'Item 1', { order: 2, author: 'Amy' }, '2026-02-01T00:00:00Z'),
];
const ids = (sorted) => sorted.map((row) => row.id);
// A grid's tracks: each `minmax(…)` or fixed width.
const tracks = (grid) => grid.match(/minmax\([^)]*\)|\d+px/g).length;

test('a column sorts smallest first, then largest first, and back', () => {
  const first = nextSort(undefined, 'cell:order');
  assert.deepEqual(first, { key: 'cell:order', direction: 'ascending' });
  const second = nextSort(first, 'cell:order');
  assert.equal(second.direction, 'descending');
  assert.equal(nextSort(second, 'cell:order').direction, 'ascending');
  assert.deepEqual(nextSort(second, 'title'), { key: 'title', direction: 'ascending' });
  assert.deepEqual(ids(sortItems(rows, first)), ['b', 'c', 'a']);
  assert.deepEqual(ids(sortItems(rows, second)), ['a', 'c', 'b']);
});

test('names sort as a person reads them, dates by time, and empty values go last', () => {
  assert.deepEqual(ids(sortItems(rows, { key: 'title', direction: 'ascending' })), ['c', 'b', 'a']);
  assert.deepEqual(ids(sortItems(rows, { key: 'updated', direction: 'descending' })), [
    'a',
    'c',
    'b',
  ]);
  for (const direction of ['ascending', 'descending']) {
    const sorted = ids(sortItems(rows, { key: 'cell:author', direction }));
    assert.equal(sorted.at(-1), 'b', `the row without an author is last ${direction}`);
  }
  assert.equal(sortItems(rows, undefined), rows, 'without a sort, the CMS order stands');
});

test('cells read as short lines, and only fields with one can be columns', () => {
  assert.equal(cellText(true), 'Yes');
  assert.equal(cellText(false), 'No');
  assert.equal(cellText(4), '4');
  assert.equal(cellText(undefined), '—');
  assert.equal(cellText(''), '—');
  const field = (name, type) => ({
    name,
    title: name,
    description: '',
    required: false,
    rules: [],
    type,
  });
  const text = { kind: 'string', options: [] };
  const columns = columnFields([
    field('author', text),
    field('cover', { kind: 'string', options: [], asset: 'image' }),
    field('campuses', { kind: 'array', of: [text] }),
    field('gallery', { kind: 'array', of: [{ kind: 'image', fields: [] }] }),
    field('seo', { kind: 'object', name: 'seo', fields: [] }),
    field('live', { kind: 'boolean', options: [] }),
  ]);
  assert.deepEqual(
    columns.map((column) => column.name),
    ['author', 'campuses', 'live'],
  );
});

test('every column keeps a readable width, so many columns scroll sideways', () => {
  const few = tableGrid({ lead: false, status: true, columns: 0 });
  const many = tableGrid({ lead: true, status: true, columns: 8 });
  assert.equal(tracks(few.columns), 4, 'name, status, updated and the pin');
  assert.equal(tracks(many.columns), 13);
  assert.ok(many.widthPx > few.widthPx + 8 * 140);
  assert.throws(() => tableGrid({ lead: false, status: false, columns: 13 }), /few columns/);
});
