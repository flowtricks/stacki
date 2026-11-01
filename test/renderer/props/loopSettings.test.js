// The loop list settings' words and checks, apart from React.
//
//   node test/renderer/props/loopSettings.test.js
//
// What a closed filter or sort says ("Category = Get Involved", "Date · Newest
// to oldest"), which Source menu entry a reading selects, how a schema's fields
// become filter and sort fields, and — the part that keeps the page safe — that
// a filter being made is written only once its value is valid: a number that
// is not one, a date that is not one, or an empty search never becomes code.

const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const model = load('src/features/props/loopSettingsModel.ts');
const catalog = load('src/features/props/loopCatalog.ts');

const fields = [
  {
    path: 'category',
    title: 'Category',
    kind: 'reference',
    options: [{ title: 'Get Involved', value: 'get-involved' }],
    references: [],
  },
  { path: 'order', title: 'Sort Order', kind: 'number', options: [], references: [] },
  { path: 'date', title: 'Published On', kind: 'date', options: [], references: [] },
  { path: 'featured', title: 'Featured', kind: 'boolean', options: [], references: [] },
];

// Summaries.
assert.equal(
  model.conditionSummary(
    {
      kind: 'test',
      field: 'category',
      operator: 'is',
      value: { kind: 'reference', id: 'get-involved' },
    },
    fields,
    [],
  ),
  'Category = Get Involved',
);
assert.equal(
  model.conditionSummary({ kind: 'test', field: 'featured', operator: 'isTrue' }, fields, []),
  'Featured is on',
);
assert.equal(
  model.conditionSummary(
    { kind: 'test', field: 'order', operator: 'atMost', value: 3 },
    fields,
    [],
  ),
  'Sort Order ≤ 3',
);
assert.match(
  model.conditionSummary(
    { kind: 'test', field: 'date', operator: 'before', value: '2024-01-05' },
    fields,
    [],
  ),
  /^Published On is before .*2024/,
);
assert.equal(
  model.conditionSummary({ kind: 'custom', code: 'a  &&\n b' }, fields, []),
  'Custom: a && b',
);
assert.equal(
  model.conditionSummary({ kind: 'test', field: 'campus-name', operator: 'isSet' }, undefined, []),
  'Campus Name is set',
  'unloaded fields read by name',
);
assert.equal(
  model.sortSummary({ field: 'order', direction: 'ascending', order: 'number' }, fields),
  'Sort Order · Smallest to largest',
);
assert.equal(
  model.sortSummary({ field: 'date', direction: 'descending', order: 'date' }, fields),
  'Published On · Newest to oldest',
);
assert.equal(
  model.sortSummary({ field: 'featured', direction: 'ascending', order: 'boolean' }, fields),
  'Featured · Is Off First',
);
assert.equal(
  model.sortSummary({ field: 'featured', direction: 'descending', order: 'boolean' }, fields),
  'Featured · Is On First',
);

// Drafts become conditions only when complete and valid.
const draft = (operator, value, field = 'order') =>
  model.conditionOf(
    { field, operator, value },
    fields.find((entry) => entry.path === field)?.kind ?? 'text',
  );
assert.equal(draft('greater', ''), undefined);
assert.equal(draft('greater', '1e'), undefined);
assert.equal(draft('greater', 'Infinity'), undefined);
assert.deepEqual(draft('greater', '-2.5'), {
  kind: 'test',
  field: 'order',
  operator: 'greater',
  value: -2.5,
});
assert.equal(draft('before', '2024-13-40', 'date'), undefined);
assert.equal(draft('before', 'tomorrow', 'date'), undefined);
assert.deepEqual(draft('inPast', '', 'date'), { kind: 'test', field: 'date', operator: 'inPast' });
assert.equal(draft('contains', '   ', 'title'), undefined);
assert.equal(draft('is', 'x'.repeat(501), 'title'), undefined);
assert.deepEqual(draft('is', 'get-involved', 'category').value, {
  kind: 'reference',
  id: 'get-involved',
});
assert.deepEqual(
  draft('is', 'Get Involved', 'category').value,
  { kind: 'text', text: 'Get Involved' },
  'a choice that cannot be an id is text',
);
assert.equal(model.wholeNumberOf('12', { min: 1, max: 10 }), 10);
assert.equal(model.wholeNumberOf('0', { min: 1, max: 10 }), 1);
assert.equal(model.wholeNumberOf('2.5', { min: 1, max: 10 }), undefined);
assert.throws(() => model.wholeNumberOf('2', { min: 3, max: 1 }), /Bounds are ordered/);

// Source keys round-trip.
assert.deepEqual(model.parseSourceKey('astro:case-studies'), {
  kind: 'collection',
  source: { kind: 'astro', collection: 'case-studies' },
});
assert.deepEqual(model.parseSourceKey('value:Astro.props.items'), {
  kind: 'value',
  data: 'Astro.props.items',
});
assert.equal(model.parseSourceKey('other:x'), undefined);
assert.equal(model.readingKey({ kind: 'code' }, 'x'), 'custom');

// Schema fields as filter and sort fields.
const text = (name, extra = {}) => ({
  name,
  title: '',
  description: '',
  required: false,
  rules: [],
  type: { kind: 'string', options: [], ...extra },
});
const mapped = catalog.catalogFields(
  [
    text('title'),
    text('category', { options: [{ title: 'News', value: 'news' }] }),
    { ...text('slug'), type: { kind: 'slug', options: [] } },
    { ...text('author'), type: { kind: 'reference', to: ['person'] } },
    { ...text('tags'), type: { kind: 'array', of: [{ kind: 'string', options: [] }] } },
    { ...text('blocks'), type: { kind: 'array', of: [{ kind: 'object', name: 'b', fields: [] }] } },
    { ...text('photo'), type: { kind: 'image', fields: [] } },
  ],
  'sanity',
);
const byPath = Object.fromEntries(mapped.map((field) => [field.path, field.kind]));
assert.deepEqual(byPath, {
  title: 'text',
  category: 'text',
  'slug.current': 'text',
  author: 'reference',
  tags: 'list',
  blocks: 'other',
  photo: 'image',
  _createdAt: 'date',
  _updatedAt: 'date',
});
assert.equal(
  catalog.catalogFields(
    [text('category', { options: [{ title: 'News', value: 'news' }] })],
    'astro',
  )[0].kind,
  'reference',
  'an Astro choice may be a reference',
);
assert.equal(catalog.titled('case-studies'), 'Case Studies');
assert.equal(catalog.titled('sermonSpeaker'), 'Sermon Speaker');
assert.equal(
  catalog.hasDependency('{"dependencies":{"@sanity/astro":"^3"}}', '@sanity/astro'),
  true,
);
assert.equal(
  catalog.hasDependency('{"devDependencies":{"@sanity/astro":"^3"}}', '@sanity/astro'),
  true,
);
assert.equal(catalog.hasDependency('{"dependencies":{}}', '@sanity/astro'), false);
assert.equal(catalog.hasDependency('not json', '@sanity/astro'), false);

// Dragging a picked item: the drop slot is measured before the item is taken out.
const { moved } = load('src/features/props/LoopItems.tsx');
assert.deepEqual(moved(['a', 'b', 'c'], 0, 3), ['b', 'c', 'a'], 'to the end');
assert.deepEqual(moved(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'], 'to the start');
assert.deepEqual(moved(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c'], 'onto itself');
assert.throws(() => moved(['a'], 1, 0), /A moved item exists/);

// A list typed in place: only plain strings read as rows, and rows write back
// as code that reads the same. Anything else stays code, so editing rows never
// turns a number or an object into text.
const literal = load('src/editor/loopLiteral.ts');
assert.deepEqual(literal.literalItems('["item 1", "item 2"]'), ['item 1', 'item 2']);
assert.deepEqual(literal.literalItems("['a', 'b']"), ['a', 'b'], 'single quotes read too');
for (const code of ['[1, 2]', '[{ a: 1 }]', '[...posts]', 'posts', '["a", b]', '']) {
  assert.equal(literal.literalItems(code), undefined, `${code} stays code`);
}
assert.equal(
  literal.literalItems(`[${Array.from({ length: 201 }, () => '"x"').join(',')}]`),
  undefined,
  'a typed list is bounded',
);
assert.equal(literal.literalCode(['He said "hi"', 'x']), '["He said \\"hi\\"", "x"]');
assert.deepEqual(
  literal.literalItems(literal.literalCode(['He said "hi"', '\\'])),
  ['He said "hi"', '\\'],
  'escapes round-trip',
);
assert.throws(() => literal.literalCode(['x'.repeat(501)]), /A typed item is bounded/);
assert.deepEqual(model.parseSourceKey('list'), { kind: 'list' });

console.log('loopSettings: ok');
