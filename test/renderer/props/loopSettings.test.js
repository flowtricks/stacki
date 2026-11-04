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
  { path: 'category', title: 'Category', kind: 'reference', options: [{ title: 'Get Involved', value: 'get-involved' }], references: [] },
  { path: 'order', title: 'Sort Order', kind: 'number', options: [], references: [] },
  { path: 'date', title: 'Published On', kind: 'date', options: [], references: [] },
  { path: 'featured', title: 'Featured', kind: 'boolean', options: [], references: [] },
];

// Summaries.
assert.equal(
  model.conditionSummary({ kind: 'test', field: 'category', operator: 'is', value: { kind: 'reference', id: 'get-involved' } }, fields, []),
  'Category = Get Involved',
);
assert.equal(model.conditionSummary({ kind: 'test', field: 'featured', operator: 'isTrue' }, fields, []), 'Featured is on');
assert.equal(model.conditionSummary({ kind: 'test', field: 'order', operator: 'atMost', value: 3 }, fields, []), 'Sort Order ≤ 3');
assert.match(model.conditionSummary({ kind: 'test', field: 'date', operator: 'before', value: '2024-01-05' }, fields, []), /^Published On is before .*2024/);
assert.equal(model.conditionSummary({ kind: 'custom', code: 'a  &&\n b' }, fields, []), 'Custom: a && b');
assert.equal(
  model.conditionSummary({ kind: 'test', field: 'campus-name', operator: 'isSet' }, undefined, []),
  'Campus Name is set',
  'unloaded fields read by name',
);
assert.equal(model.sortSummary({ field: 'order', direction: 'ascending', order: 'number' }, fields), 'Sort Order · Smallest to largest');
assert.equal(model.sortSummary({ field: 'date', direction: 'descending', order: 'date' }, fields), 'Published On · Newest to oldest');
assert.equal(model.sortSummary({ field: 'featured', direction: 'ascending', order: 'boolean' }, fields), 'Featured · Is Off First');
assert.equal(model.sortSummary({ field: 'featured', direction: 'descending', order: 'boolean' }, fields), 'Featured · Is On First');

// Drafts become conditions only when complete and valid.
const draft = (operator, value, field = 'order') => model.conditionOf({ field, operator, value }, fields.find((entry) => entry.path === field)?.kind ?? 'text');
assert.equal(draft('greater', ''), undefined);
assert.equal(draft('greater', '1e'), undefined);
assert.equal(draft('greater', 'Infinity'), undefined);
assert.deepEqual(draft('greater', '-2.5'), { kind: 'test', field: 'order', operator: 'greater', value: -2.5 });
assert.equal(draft('before', '2024-13-40', 'date'), undefined);
assert.equal(draft('before', 'tomorrow', 'date'), undefined);
assert.deepEqual(draft('inPast', '', 'date'), { kind: 'test', field: 'date', operator: 'inPast' });
assert.equal(draft('contains', '   ', 'title'), undefined);
assert.equal(draft('is', 'x'.repeat(501), 'title'), undefined);
assert.deepEqual(draft('is', 'get-involved', 'category').value, { kind: 'reference', id: 'get-involved' });
assert.deepEqual(draft('is', 'Get Involved', 'category').value, { kind: 'text', text: 'Get Involved' }, 'a choice that cannot be an id is text');
assert.equal(model.wholeNumberOf('12', { min: 1, max: 10 }), 10);
assert.equal(model.wholeNumberOf('0', { min: 1, max: 10 }), 1);
assert.equal(model.wholeNumberOf('2.5', { min: 1, max: 10 }), undefined);
assert.throws(() => model.wholeNumberOf('2', { min: 3, max: 1 }), /Bounds are ordered/);

// Source keys round-trip.
assert.deepEqual(model.parseSourceKey('astro:case-studies'), { kind: 'collection', source: { kind: 'astro', collection: 'case-studies' } });
assert.deepEqual(model.parseSourceKey('value:Astro.props.items'), { kind: 'value', data: 'Astro.props.items' });
assert.equal(model.parseSourceKey('other:x'), undefined);
assert.equal(model.readingKey({ kind: 'code' }, 'x'), 'custom');

// Schema fields as filter and sort fields.
const text = (name, extra = {}) => ({ name, title: '', description: '', required: false, rules: [], type: { kind: 'string', options: [], ...extra } });
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
  catalog.catalogFields([text('category', { options: [{ title: 'News', value: 'news' }] })], 'astro')[0].kind,
  'reference',
  'an Astro choice may be a reference',
);
assert.equal(catalog.titled('case-studies'), 'Case Studies');
assert.equal(catalog.titled('sermonSpeaker'), 'Sermon Speaker');
assert.equal(catalog.hasDependency('{"dependencies":{"@sanity/astro":"^3"}}', '@sanity/astro'), true);
assert.equal(catalog.hasDependency('{"devDependencies":{"@sanity/astro":"^3"}}', '@sanity/astro'), true);
assert.equal(catalog.hasDependency('{"dependencies":{}}', '@sanity/astro'), false);
assert.equal(catalog.hasDependency('not json', '@sanity/astro'), false);

// Dragging a picked item: the drop slot is measured before the item is taken out.
const { moved } = load('src/features/props/LoopItems.tsx');
assert.deepEqual(moved(['a', 'b', 'c'], 0, 3), ['b', 'c', 'a'], 'to the end');
assert.deepEqual(moved(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'], 'to the start');
assert.deepEqual(moved(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c'], 'onto itself');
assert.throws(() => moved(['a'], 1, 0), /A moved item exists/);
// A drop back in its own place (its own slot, or the one just after it)
// changes nothing; writing it anyway was refused as an editor error.
const { staysPut } = load('src/features/props/LoopItems.tsx');
assert.equal(staysPut(1, 1), true);
assert.equal(staysPut(1, 2), true);
assert.equal(staysPut(1, 0), false);
assert.equal(staysPut(1, 3), false);
assert.deepEqual(moved([{ field: 'name' }, { field: 'email' }], 1, 0), [{ field: 'email' }, { field: 'name' }], 'sorts move like ids');

// A list typed in place: only plain strings read as rows, and rows write back
// as code that reads the same. Anything else stays code, so editing rows never
// turns a number or an object into text.
const literal = load('src/editor/loopLiteral.ts');
assert.deepEqual(literal.literalItems('["item 1", "item 2"]'), ['item 1', 'item 2']);
assert.deepEqual(literal.literalItems("['a', 'b']"), ['a', 'b'], 'single quotes read too');
for (const code of ['[1, 2]', '[{ a: 1 }]', '[...posts]', 'posts', '["a", b]', '']) {
  assert.equal(literal.literalItems(code), undefined, `${code} stays code`);
}
assert.equal(literal.literalItems(`[${Array.from({ length: 201 }, () => '"x"').join(',')}]`), undefined, 'a typed list is bounded');
assert.equal(literal.literalCode(['He said "hi"', 'x']), '["He said \\"hi\\"", "x"]');
assert.deepEqual(literal.literalItems(literal.literalCode(['He said "hi"', '\\'])), ['He said "hi"', '\\'], 'escapes round-trip');
assert.throws(() => literal.literalCode(['x'.repeat(501)]), /A typed item is bounded/);

// What a row of the Source picker means: a collection, a list inside its
// items, or a list on the page. A list inside one particular item is not
// offered as a loop over every item's.
const picker = load('src/features/props/LoopSourcePicker.tsx');
assert.deepEqual(picker.pickOf('astro:campus'), { kind: 'collection', source: { kind: 'astro', collection: 'campus' } });
assert.deepEqual(picker.pickOf('sanity:pastor'), { kind: 'collection', source: { kind: 'sanity', collection: 'pastor' } });
assert.deepEqual(picker.pickOf('astro:campus.pastors'), {
  kind: 'field',
  list: { source: { kind: 'astro', collection: 'campus' }, path: ['pastors'], follow: 'values' },
});
assert.deepEqual(picker.pickOf('astro:campus.team.members').list.path, ['team', 'members']);
assert.deepEqual(picker.pickOf('sanity:campus.pastors').list.source, { kind: 'sanity', collection: 'campus' });
assert.equal(picker.pickOf('sanity:campus.a-b c'), undefined, 'a Sanity field GROQ cannot name is not offered');
assert.equal(picker.pickOf('astro:campus.pastors[0].tags'), undefined);
assert.deepEqual(picker.pickOf('items1'), { kind: 'value', data: 'items1' });
assert.equal(picker.fieldListPath({ source: { kind: 'sanity', collection: 'campus' }, path: ['pastors'], follow: 'values' }), 'sanity:campus.pastors');

// A prop a component's loop reads its filters from is a Filter, whatever its
// declared type says: opening it in the Properties panel offers that type,
// ready to save. A prop with a real type of its own keeps it.
const { withListSettingType } = load('src/features/componentProperties/PropertyEditor.tsx');
const { SETTING_PROP_TYPES } = load('src/editor/optionsBinding.ts');
const { listPropsOf } = load('src/editor/listProps.ts');
const exportFrontmatter = [
  "import { getCollection } from 'astro:content';",
  'const { filters: propFilters = {"filterFor": "ALL", "fields": []} } = Astro.props;',
  'const items1 = queryItems((await getCollection("campus")) || [], ({"filter": propFilters}), {});',
].join('\n');
const property = (name, type) => ({ name, type, required: false, readonly: false, defaultValue: '', description: '' });
assert.equal(withListSettingType(property('filters', 'unknown'), listPropsOf(exportFrontmatter)).type, SETTING_PROP_TYPES.filter);
assert.equal(withListSettingType(property('filters', 'string'), listPropsOf(exportFrontmatter)).type, 'string', 'a real type is kept');
assert.equal(withListSettingType(property('title', 'unknown'), listPropsOf(exportFrontmatter)).type, 'unknown', 'a prop no loop reads is left alone');

console.log('loopSettings: ok');

// The Items switch writes code either way, so Undo after picking Selected puts
// Dynamic back: Selected starts with nothing picked, and Dynamic drops the picks.
{
  const loopQuery = load('src/editor/loopQuery.ts');
  const dynamic = { ...loopQuery.emptyQuery({ kind: 'astro', collection: 'team' }), sorts: [{ field: 'title', direction: 'ascending', order: 'text' }] };
  const selected = model.itemsModeQuery(dynamic, 'selected');
  assert.deepEqual(selected?.selection, [], 'Selected starts with no items');
  assert.deepEqual(selected?.sorts, [], "Dynamic's sort does not carry into a picked list");
  assert.equal(model.itemsModeQuery(dynamic, 'dynamic'), undefined, 'already dynamic: nothing to write');
  assert.equal(model.itemsModeQuery({ ...dynamic, sorts: [], selection: ['a'] }, 'selected'), undefined, 'already selected: nothing to write');
  assert.equal(model.itemsModeQuery({ ...dynamic, sorts: [], selection: ['a'] }, 'dynamic')?.selection, undefined);
}

// Custom code is written only once it parses: one JavaScript expression for an
// Astro filter, a GROQ condition for a Sanity one, and a two-item comparator
// for a sort. Anything else stays in the box with the reason beside it.
{
  assert.equal(model.customFilterProblem('data.title.startsWith("S")', 'astro'), undefined);
  assert.equal(model.customFilterProblem('entry.data.tags?.length > 2 && entry.id !== "x"', 'astro'), undefined);
  assert.equal(model.customFilterProblem('data.title.startsWith(', 'astro'), 'This is not one JavaScript expression.');
  assert.equal(model.customFilterProblem('a; b', 'astro'), 'This is not one JavaScript expression.');
  assert.equal(model.customFilterProblem('   ', 'astro'), 'Type a condition.');
  assert.equal(model.customFilterProblem('x'.repeat(2001), 'astro'), 'This condition is too long.');
  assert.equal(model.customFilterProblem('count(serviceTimes) > 1', 'sanity'), undefined);
  assert.equal(model.customFilterProblem('count(serviceTimes > 1', 'sanity'), 'This is not a GROQ condition.');
  assert.equal(model.customFilterProblem('name == "a"] | order(x', 'sanity'), 'This is not a GROQ condition.');
  assert.equal(model.customSortProblem('(a, b) => a.data.order - b.data.order'), undefined);
  assert.equal(model.customSortProblem('function (a, b) { return a.id.localeCompare(b.id); }'), undefined);
  assert.equal(model.customSortProblem('(a) => a.data.order'), 'A sort compares two items: write (a, b) => …');
  assert.equal(model.customSortProblem('byRank'), 'A sort compares two items: write (a, b) => …');
  assert.equal(model.customSortProblem('(a, b) =>'), 'This is not one JavaScript expression.');
  console.log('custom code checks: ok');
}

// Inside an object or a map position, its fields are fields too, by dotted
// path, so anything an item holds can be filtered and sorted by; a list's
// items are not reached into, and nesting stops at its bound.
{
  const field = (name, type, title = '') => ({ name, title, description: '', required: false, rules: [], type });
  const string = { kind: 'string', options: [] };
  // Objects nested `depth` levels around a string, built from the inside out.
  const deep = (depth) => {
    let type = string;
    for (let level = 1; level <= depth; level++) {
      type = { kind: 'object', name: `o${level}`, fields: [field('inner', type)] };
    }
    return type;
  };
  const nested = catalog.catalogFields(
    [
      field('name', string),
      field('location', { kind: 'geopoint' }, 'Map position'),
      field('hero', {
        kind: 'object',
        name: 'hero',
        fields: [field('cta', { kind: 'object', name: 'cta', fields: [field('label', string)] }), field('slug', { kind: 'slug', options: [] })],
      }),
      field('serviceTimes', { kind: 'array', of: [{ kind: 'object', name: 'time', fields: [field('day', string)] }] }),
      field('deep', deep(6)),
    ],
    'sanity',
  );
  const kinds = Object.fromEntries(nested.map((entry) => [entry.path, entry.kind]));
  assert.equal(kinds['location.lat'], 'number');
  assert.equal(kinds['location.lng'], 'number');
  assert.equal(kinds.location, 'other', 'the object itself can still be asked whether it is set');
  assert.equal(kinds['hero.cta.label'], 'text');
  assert.equal(kinds['hero.slug.current'], 'text');
  assert.equal(kinds['serviceTimes.day'], undefined, "a list's items are not one value");
  assert.equal(kinds['deep.inner.inner.inner'], 'other');
  assert.equal(kinds['deep.inner.inner.inner.inner'], undefined, 'nesting stops at its bound');
  assert.equal(nested.find((entry) => entry.path === 'location.lat').title, 'Map position › Latitude');
  // Top-level fields come first, whatever an object holds.
  assert.deepEqual(
    nested.slice(0, 5).map((entry) => entry.path),
    ['name', 'location', 'hero', 'serviceTimes', 'deep'],
  );

  // The Field picker's tree: a field under the one its path continues, a bare
  // row for a parent that is not a field (`slug` of `slug.current`), values
  // from a sampled item, and only usable fields chosen.
  const { fieldTree } = load('src/features/props/LoopFieldPicker.tsx');
  const sample = { name: 'St. Amant', location: { lat: 30.26, lng: -90.85 }, hero: { slug: { current: 'sta' } } };
  const tree = fieldTree(nested, sample, (entry) => entry.kind === 'text' || entry.kind === 'number');
  const location = tree.find((node) => node.path === 'location');
  assert.equal(location.pickable, false);
  assert.deepEqual(
    location.children.map((node) => [node.path, node.key, node.preview, node.pickable]),
    [
      ['location.lat', 'Latitude', '30.26', true],
      ['location.lng', 'Longitude', '-90.85', true],
    ],
  );
  const slug = tree.find((node) => node.path === 'hero').children.find((node) => node.path === 'hero.slug');
  assert.equal(slug.kind, 'object', 'a bare parent row');
  assert.equal(slug.children[0].path, 'hero.slug.current');
  assert.equal(slug.children[0].preview, '"sta"', 'text previews as the data picker shows it');
  assert.equal(tree.find((node) => node.path === 'name').preview, '"St. Amant"');
  console.log('nested fields: ok');
}
