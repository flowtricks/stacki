// Goal: a page whose data comes from its own call to an import — a CMS query,
// `const campusPastors = await getCampusPastors()` — shows that data in the binding picker:
// the loop item gets the entry's fields with their values, not "not in this entry".
// Method: find the calls the app would ask the dev server to run, then build the picker's tree
// with a sampled answer the way the dev server returns it, and read the loop item's fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { dataTree, importedCallsInScope } = loadRenderer('src/editor/dataSuggest.ts');

const FRONTMATTER = [
  "import { getCampusPastors, getSermons } from '@/sanity/queries.ts';",
  'const campusPastors = await getCampusPastors();',
  'const sermons = await getSermons(3);',
  'const local = await fetchLocally();',
].join('\n');
const IMPORTS = [
  { name: 'getCampusPastors', path: '@/sanity/queries.ts' },
  { name: 'getSermons', path: '@/sanity/queries.ts' },
];

test('only an import called with no arguments is asked for', () => {
  assert.deepEqual(importedCallsInScope(FRONTMATTER, IMPORTS), [
    { name: 'campusPastors', exportName: 'getCampusPastors', spec: '@/sanity/queries.ts' },
  ]);
  assert.deepEqual(importedCallsInScope('', IMPORTS), []);
  assert.deepEqual(importedCallsInScope(FRONTMATTER, []), [], 'a local function is not run');
});

test('the loop item over a sampled call shows each field with its value', () => {
  const tree = dataTree({
    frontmatter: FRONTMATTER,
    imports: IMPORTS,
    ancestorHeads: ['campusPastors.map((pastor) => ('],
    valueSamples: {
      campusPastors: [
        { campus: 'St. Amant', name: 'Joey & Sarai Kahl' },
        { campus: 'Gonzales', name: 'Mark Stermer', email: 'mark@example.org' },
      ],
    },
  });
  const pastor = tree.find((node) => node.path === 'pastor');
  assert.ok(pastor, 'the loop item is offered');
  assert.deepEqual(pastor.nav, { index: 0, count: 2 }, 'its entries can be stepped through');
  const fields = Object.fromEntries((pastor.children ?? []).map((node) => [node.key, node]));
  assert.deepEqual(
    Object.keys(fields).sort(),
    ['campus', 'email', 'name'],
    'a field one entry lacks is still a field of the item',
  );
  assert.equal(fields.name.preview, '"Joey & Sarai Kahl"', 'the value beside its field');
  const unsampled = dataTree({ frontmatter: FRONTMATTER, imports: IMPORTS });
  const value = unsampled.find((node) => node.path === 'campusPastors');
  assert.equal(value.children, undefined, 'without a sample the value has no known fields');
});
