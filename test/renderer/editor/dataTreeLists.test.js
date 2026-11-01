// What the data picker shows inside a builder export's component.
//
//   node test/renderer/editor/dataTreeLists.test.js
//
// A Webflow export reads its lists through a helper,
// `items1 = queryItems(collections["campus"] || [], {…})`, and reshapes each
// entry to `{ id, fields }`. The picker used to see `items1` as an unknown
// value, so the loop item inside it showed no fields and every binding read
// "not in this entry". It also listed each renamed prop twice: once by its
// local name (`propPaddingTop`) with only a type, and again by its prop name
// (`paddingTop`), which is not a name the file can use. And `collections`, an
// object holding lists, was offered as a list itself.
//
// Checked here: the loop item opens to the reshaped item's fields with the
// sampled entry's values; a renamed prop is listed once, by its local name,
// with its prop's value; an object of lists opens to each list.

const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { dataTree } = load('src/editor/dataSuggest.ts');
// The app hands the tree the loop reader's answers; the tree's own module stays parser-free.
const { collectionReader } = load('src/editor/collectionReader.ts');

const frontmatter = [
  'const {',
  '  paddingTop: propPaddingTop = "large",',
  '  filters: propFilters = {"filterFor": "ALL", "fields": []}',
  '} = Astro.props;',
  'const collections = {',
  '  "campus": (await getCollection("campus")).map(entry => ({id: entry.data._id ?? entry.id, fields: { ...entry.data, slug: entry.id }}))',
  '};',
  'const items1 = queryItems(collections["campus"] || [], ({"sort": [], "filter": propFilters}), {});',
].join('\n');
const imports = [
  { name: 'getCollection', path: 'astro:content' },
  { name: 'queryItems', path: '@/lib/collection-query' },
];
const tree = dataTree({
  frontmatter,
  imports,
  collectionReader,
  propsSchema: [{ name: 'paddingTop', type: 'enum', optional: true, default: 'large' }],
  propsSample: { paddingTop: 'main' },
  collectionSamples: { campus: { id: 'worcester', data: { _id: 'abc', name: 'Worcester' } } },
  ancestorHeads: ['items1.map((item0) => ('],
});
const byPath = new Map(tree.map((node) => [node.path, node]));

// The loop item: one reshaped item, with the sampled entry's values.
const item = byPath.get('item0');
assert.ok(item, 'the loop item is listed');
const fields = item.children.find((node) => node.path === 'item0.fields');
assert.ok(fields, `the item opens to its fields: ${JSON.stringify(item.children.map((node) => node.path))}`);
assert.equal(fields.children.find((node) => node.key === 'name').preview, '"Worcester"');
assert.equal(byPath.get('items1').kind, 'list');

// Renamed props: listed once, by the local name, with the prop's value.
assert.equal(byPath.get('propPaddingTop').preview, '"main"');
assert.equal(byPath.has('paddingTop'), false, 'the prop name is not a name in scope');

// An object of lists opens to each list; it is not a list itself.
const holder = byPath.get('collections');
assert.equal(holder.kind, 'object');
assert.equal(holder.preview, '1 list');
assert.equal(holder.children[0].path, 'collections.campus');
assert.equal(holder.children[0].kind, 'list');

// A field a dot can't reach (`campus-pastor-name`, as an export names them)
// is `["campus-pastor-name"]`: the tree's path for it is code that runs, the
// binding reads as one chip, and its value is found by that path.
const { childPath, pathSteps, sampleAt } = load('src/editor/dataSample.ts');
const { BIND_PATH_RE } = load('src/editor/bindings.ts');
const { scopeChips } = load('src/editor/dataScope.ts');
const dashed = dataTree({
  frontmatter,
  imports,
  collectionReader,
  collectionSamples: { campus: { id: 'w', data: { 'campus-pastor-name': 'Tony' } } },
  ancestorHeads: ['items1.map((item0) => ('],
})
  .find((node) => node.path === 'item0')
  .children.find((node) => node.path === 'item0.fields').children[0];
assert.equal(dashed.path, 'item0.fields["campus-pastor-name"]');
assert.equal(dashed.preview, '"Tony"');
assert.equal(childPath('a', 'b'), 'a.b');
assert.ok(BIND_PATH_RE.test('item0.fields["campus-pastor-name"]'));
assert.ok(!BIND_PATH_RE.test('item0.fields[name]'), 'a computed step is code');
assert.deepEqual(scopeChips('item0.fields["campus-pastor-name"] ?? ""', new Set(['item0'])), [{ from: 0, to: 34, path: 'item0.fields["campus-pastor-name"]' }]);
assert.deepEqual(
  scopeChips('item0.fields["a"].map(f)', new Set(['item0'])).map((chip) => chip.path),
  ['item0.fields["a"]'],
  'a method call is not part of the value',
);
assert.deepEqual(
  pathSteps('a["b-c"][0].d').map((step) => step.key),
  ['a', 'b-c', 0, 'd'],
);
assert.equal(sampleAt({ a: { 'b-c': [{ d: 1 }] } }, 'a["b-c"][0].d'), 1);
assert.equal(sampleAt({ a: 1 }, 'a[b]'), undefined, 'a path it cannot read finds nothing');

console.log('data-tree-lists: ok');
