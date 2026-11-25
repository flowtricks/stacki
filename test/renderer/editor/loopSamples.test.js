// Goal: a loop item in the binding picker shows a sampled element's fields with their values
// whatever the loop's list comes from — a fetch, a JSON or module import, Astro.glob and
// import.meta.glob, a filtered collection query, any CMS client's query, a field of an outer
// loop's item, or a literal — and still says where a collection list comes from ("stats
// entries"). A list with no sample still offers the item, with the field names it knows, and
// says "no sample" rather than showing nothing or throwing.
// Method: each source kind is written as a page writes it, and the picker's tree is built
// with value samples shaped exactly as the dev server's scope route returns them (the render's
// own values, first items only, with a `more` marker); the loop item's fields and previews
// are then read. Unsampled sources build the same tree with no samples. The keying helpers
// that file samples per page are checked on their own.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { dataTree } = loadRenderer('src/editor/dataSuggest.ts');
const { keyScopeSamples, withoutFileSamples } = loadRenderer('src/editor/scopeSampleValues.ts');

const STATS = [
  { id: 'untitled', data: { Number: '61.4%', Header: 'Uptime' } },
  { id: 'second', data: { Number: '12', Header: 'Sites' } },
  { __stacki: 'more', count: 6 },
];

// The loop item's fields as {key: preview}, recursing into objects.
function fieldsOf(node, depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'a data tree is bounded in depth');
  return Object.fromEntries((node?.children ?? []).map((child) => [child.key, child.children ? fieldsOf(child, depth + 1) : child.preview]));
}

function itemOf(context, name = 'item') {
  const item = dataTree(context).find((node) => node.path === name);
  assert.ok(item, `the loop item ${name} is offered`);
  return item;
}

test('a list fetched in frontmatter samples through a path inside the response', () => {
  const frontmatter = ['const response = await fetch("https://example.org/stats.json");', 'const data = await response.json();'].join('\n');
  const item = itemOf({ frontmatter, ancestorHeads: ['data.items.map((item) => ('], valueSamples: { response: { ok: true }, data: { items: STATS } } });
  assert.deepEqual(fieldsOf(item), { id: '"untitled"', data: { Number: '"61.4%"', Header: '"Uptime"' } });
  assert.deepEqual(item.nav, { index: 0, count: 2 }, 'the sampled items can be stepped through');
  // `.then((r) => r.json())` in one statement samples the same way.
  const chained = itemOf({
    frontmatter: 'const stats = await fetch(url).then((r) => r.json());',
    ancestorHeads: ['stats.slice(0, 3).map((item) => ('],
    valueSamples: { stats: STATS },
  });
  assert.equal(fieldsOf(chained).data.Header, '"Uptime"');
});

test('a destructured response field samples as its own value', () => {
  const frontmatter = 'const { items } = await (await fetch(url)).json();';
  const item = itemOf({ frontmatter, ancestorHeads: ['items.map((item) => ('], valueSamples: { items: STATS } });
  assert.equal(fieldsOf(item).id, '"untitled"');
});

test('a JSON import and a named array export sample as imports', () => {
  const imports = [
    { name: 'team', path: '../data/team.json' },
    { name: 'posts', path: '../data/posts' },
  ];
  const valueSamples = { team: [{ name: 'Ada', role: 'Lead' }], posts: [{ title: 'Hello', tags: ['a'] }] };
  const member = itemOf({ frontmatter: '', imports, ancestorHeads: ['team.map((member) => ('], valueSamples }, 'member');
  assert.deepEqual(fieldsOf(member), { name: '"Ada"', role: '"Lead"' });
  const post = itemOf({ frontmatter: '', imports, ancestorHeads: ['posts.map((post) => ('], valueSamples }, 'post');
  assert.equal(fieldsOf(post).title, '"Hello"');
  const unsampled = dataTree({ frontmatter: '', imports }).find((node) => node.path === 'team');
  assert.equal(unsampled.kind, 'imported', 'without a sample an import is still offered, marked imported');
});

test('Astro.glob and an eager import.meta.glob sample their modules', () => {
  const glob = itemOf(
    {
      frontmatter: "const posts = await Astro.glob('../posts/*.md');",
      ancestorHeads: ['posts.map((post) => ('],
      valueSamples: { posts: [{ frontmatter: { title: 'First' }, url: '/posts/first', file: '/site/src/posts/first.md' }] },
    },
    'post',
  );
  assert.deepEqual(fieldsOf(glob).frontmatter, { title: '"First"' });
  const modules = itemOf(
    {
      frontmatter: "const modules = import.meta.glob('../data/*.json', { eager: true });",
      ancestorHeads: ['Object.values(modules).map((module) => ('],
      valueSamples: { modules: { '../data/a.json': { default: { name: 'A' } }, '../data/b.json': { default: { name: 'B', extra: 1 } } } },
    },
    'module',
  );
  assert.deepEqual(fieldsOf(modules), { default: { name: '"A"' } });
  assert.deepEqual(modules.nav, { index: 0, count: 2 });
  assert.ok(
    modules.children.every((child) => child.path.startsWith('module.')),
    'the values of an object are read as the item, not as the object’s keys',
  );
});

test('a filtered or sorted collection query samples the render’s list and names its collection', () => {
  const frontmatter = [
    "const statsEntries = await getCollection('stats', ({ data }) => !data.draft); // stacki:query",
    "const sorted = (await getCollection('stats')).sort((a, b) => a.id.localeCompare(b.id));",
  ].join('\n');
  const tree = dataTree({ frontmatter, ancestorHeads: ['statsEntries.map((item) => ('], valueSamples: { statsEntries: STATS } });
  const source = tree.find((node) => node.path === 'statsEntries');
  assert.equal(source.preview, 'stats entries', 'the list says where it comes from');
  assert.deepEqual(fieldsOf(tree.find((node) => node.path === 'item')).data, { Number: '"61.4%"', Header: '"Uptime"' });
  // The collection's own sample still answers when the render has not been sampled.
  const fallback = itemOf({ frontmatter, ancestorHeads: ['sorted.map((item) => ('], collectionSamples: { stats: STATS[0] } });
  assert.equal(fieldsOf(fallback).id, '"untitled"');
});

test('a CMS client’s query samples whatever the client shape', () => {
  const frontmatter = [
    "import { client } from '../sanity/client';",
    'const pastors = await client.fetch(groq`*[_type == "pastor"]{ name, campus->{ title } }`);',
    'const posts = await sdk.getEntries({ content_type: "post" });',
  ].join('\n');
  const valueSamples = {
    pastors: [{ name: 'Mark', campus: { title: 'Gonzales' } }],
    posts: { items: [{ fields: { title: 'Hello' } }], total: 1 },
  };
  const pastor = itemOf({ frontmatter, ancestorHeads: ['pastors.map((pastor) => ('], valueSamples }, 'pastor');
  assert.deepEqual(fieldsOf(pastor), { name: '"Mark"', campus: { title: '"Gonzales"' } });
  const post = itemOf({ frontmatter, ancestorHeads: ['posts.items.map((post) => ('], valueSamples }, 'post');
  assert.deepEqual(fieldsOf(post), { fields: { title: '"Hello"' } });
});

test('a nested loop’s item samples from the outer item’s sample', () => {
  const campuses = [
    { title: 'St. Amant', pastors: [{ name: 'Joey' }, { name: 'Sarai', email: 'sarai@example.org' }] },
    { title: 'Gonzales', pastors: [{ name: 'Mark' }] },
  ];
  const context = {
    frontmatter: 'const campuses = await getCampuses();',
    ancestorHeads: ['campuses.map((item) => (', 'item.pastors.map((pastor) => ('],
    valueSamples: { campuses },
  };
  const tree = dataTree(context);
  assert.deepEqual(
    tree.slice(0, 2).map((node) => node.path),
    ['pastor', 'item'],
    'the innermost item leads',
  );
  const pastor = tree[0];
  assert.deepEqual(fieldsOf(pastor), { name: '"Joey"', email: '"sarai@example.org"' }, 'every field any pastor has');
  assert.deepEqual(pastor.nav, { index: 0, count: 2 });
  // Stepping the outer item moves the inner list with it.
  const stepped = dataTree({ ...context, itemIndex: { item: 1 } })[0];
  assert.deepEqual(fieldsOf(stepped), { name: '"Mark"' });
  // An inner item that repeats the outer name shadows it, as in JavaScript.
  const shadowed = dataTree({ ...context, ancestorHeads: ['campuses.map((item) => (', 'item.pastors.map((item) => (', 'item.tags.map((tag) => ('] });
  const inner = shadowed.find((node) => node.path === 'item');
  assert.equal(fieldsOf(inner).name, '"Joey"');
  assert.equal(shadowed.find((node) => node.path === 'tag').preview, 'no sample', 'the inner item has no tags, and the outer one is not consulted');
});

test('a literal array in frontmatter samples without the dev server', () => {
  const frontmatter = 'const stats = [{ label: "Uptime", value: "99%" }, { label: "Sites", value: "12" }];';
  const item = itemOf({ frontmatter, ancestorHeads: ['stats.map((item) => ('] });
  assert.deepEqual(fieldsOf(item), { label: '"Uptime"', value: '"99%"' });
});

test('a list with no sample still offers the item and says no sample', () => {
  const unsampled = itemOf({ frontmatter: 'const stats = await fetch(url).then((r) => r.json());', ancestorHeads: ['stats.map((item) => ('] });
  assert.equal(unsampled.preview, 'no sample');
  assert.equal(unsampled.kind, 'loop item');
  assert.equal(unsampled.children, undefined);
  // A list written inline in the template cannot be followed.
  const inline = itemOf({ frontmatter: '', ancestorHeads: ['(await getPosts()).map((item) => ('] });
  assert.equal(inline.preview, 'no sample');
  // A prop declared as a list of a shape gives field names, with no values.
  const shaped = itemOf({
    frontmatter: 'const { times } = Astro.props;',
    propsSchema: [{ name: 'times', shapeIsList: true, shape: [{ name: 'label', type: 'text' }] }],
    ancestorHeads: ['times.map((item) => ('],
  });
  assert.deepEqual(Object.keys(fieldsOf(shaped)), ['label']);
  // A sampled list that is empty says so.
  const empty = itemOf({ frontmatter: 'const stats = await load();', ancestorHeads: ['stats.map((item) => ('], valueSamples: { stats: [] } });
  assert.equal(empty.preview, 'no items');
});

test('scope samples are filed per page, and a page’s new answer replaces its old one', () => {
  const keyed = keyScopeSamples('src/pages/stats.astro', { stats: [1], data: { a: 1 } });
  assert.deepEqual(keyed, { 'src/pages/stats.astro|stats': [1], 'src/pages/stats.astro|data': { a: 1 } });
  const kept = withoutFileSamples({ ...keyed, 'src/pages/other.astro|stats': [2] }, 'src/pages/stats.astro');
  assert.deepEqual(kept, { 'src/pages/other.astro|stats': [2] });
  assert.throws(() => keyScopeSamples('', { stats: [1] }), /belong to a file/);
});
