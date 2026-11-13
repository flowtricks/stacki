// Validate project schemas before form construction, then pin the distinctions
// between missing, nullable, defaulted and union fields. CMS operations must keep
// wrapper keys and expression metadata while editing nested item collections.
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');
const schema = loadRenderer('src/features/content/contentSchema.ts');
const { ENGLISH_TRANSLATE } = loadRenderer('shared/properties/i18n/englishTranslator.ts');
const cms = loadRenderer('src/features/cms/cmsSchema.ts');
const { parseContentSchema } = loadRenderer('src/features/content/contentSchemaBoundary.ts');
const fixture = {
  type: 'object',
  required: ['title', 'choice'],
  properties: {
    title: { type: 'string', minLength: 1, default: 'Untitled' },
    choice: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    count: { type: 'integer', exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    image: { type: 'string', astroImage: true },
    items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
    author: { type: 'string', astroReference: 'authors' },
    when: { astroDate: true, astroCoerced: true },
  },
};
assert.deepEqual(parseContentSchema(fixture), fixture);
const fields = schema.collectionFields(fixture).fields;
assert.equal(fields[0].required, true);
assert.equal(fields[0].default, 'Untitled');
assert.equal(fields[1].nullable, true);
assert.equal(schema.fieldIssue(fields[0], '', ENGLISH_TRANSLATE), 'Required');
assert.equal(schema.fieldIssue(fields[1], PLATFORM_NULL, ENGLISH_TRANSLATE), undefined);
assert.equal(schema.fieldIssue(fields[2], 0, ENGLISH_TRANSLATE), 'At least 1');
assert.equal('max' in fields[2].constraints, false);
assert.equal(fields[3].control, 'image');
assert.equal(fields[4].item.fields[0].key, 'name');
assert.equal(fields[5].target, 'authors');
assert.equal(fields[6].coerced, true);
const union = schema.collectionFields({
  oneOf: [
    { type: 'object', properties: { kind: { const: 'text' }, body: { type: 'string' } } },
    { type: 'object', properties: { kind: { const: 'image' }, src: { astroImage: true } } },
  ],
}).union;
assert.equal(union.discriminator, 'kind');
assert.equal(schema.memberFor(union, { kind: 'image' }).value, 'image');
assert.deepEqual(schema.editsBetween({ a: 1, b: PLATFORM_NULL }, { b: PLATFORM_NULL, c: 2 }), [
  { path: ['a'], value: undefined },
  { path: ['c'], value: 2 },
]);
for (const value of [
  PLATFORM_NULL,
  [],
  42,
  { type: 42 },
  { required: [42] },
  { properties: [] },
  { items: 42 },
  { oneOf: [PLATFORM_NULL] },
  { $defs: { a: 42 } },
  { minLength: -1 },
  { minItems: 0.5 },
  { maximum: Infinity },
  { minimum: '3' },
  { astroImage: 'yes' },
  { astroReference: 42 },
  { default: Symbol('bad') },
]) {
  assert.throws(() => parseContentSchema(value));
}
const typeOverLimit = 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1);
assert.throws(() => parseContentSchema({ type: typeOverLimit }), /limit/);
assert.throws(() => parseContentSchema({ required: Array(100001).fill('a') }), /limit/);
let deep = { type: 'string' };
for (let index = 0; index < 130; index++) {
  deep = { items: deep };
}
assert.throws(() => parseContentSchema(deep), /depth limit/);

const raw = {
  metadata: 'keep',
  rows: [{ title: 'One', image: { __expr: 'photo', __asset: 'a.png' } }],
};
const collection = cms.collectionOf({ rel: 'data.json', name: 'data.json', dir: '', data: raw });
assert.equal(collection.raw, raw);
assert.equal(collection.items, raw.rows);
assert.equal(cms.inferType(raw.rows[0].image), 'image');
// Colours are found written as hex or as CSS colour functions; a word that only
// names a colour, or a broken function, stays text.
for (const color of [
  '#337ffe',
  'hsla(0, 0.00%, 100.00%, 1.00)',
  'hsl(210 50% 40%)',
  'rgb(10, 20, 30)',
  'rgba(0, 0, 0, 0.5)',
  'oklch(70% 0.1 200)',
  'color(display-p3 1 0 0)',
]) {
  assert.equal(cms.inferType(color), 'color', color);
}
for (const text of ['red', 'rgb(1, 2', 'hsl(1) and more', '#12345']) {
  assert.notEqual(cms.inferType(text), 'color', text);
}
assert.deepEqual(cms.reassemble(collection, [{ title: 'Two' }]), {
  metadata: 'keep',
  rows: [{ title: 'Two' }],
});
assert.deepEqual(cms.applyToItems([{ group: [{ name: 'One' }] }], ['group'], cms.renameKey('name', 'title')), [{ group: [{ title: 'One' }] }]);
assert.deepEqual(cms.duplicateItem({ id: 'one', name: 'One', image: raw.rows[0].image }), {
  id: 'one-copy',
  name: 'One copy',
  image: raw.rows[0].image,
});
assert.deepEqual(cms.blankItem([1, 2]), 0);
assert.deepEqual(
  cms.fieldsOf([PLATFORM_NULL, 'plain', { title: 'A', count: 1 }]).map((field) => field.type),
  ['text', 'number'],
);
assert.throws(() => cms.applyToItems([], Array(129).fill('x'), cms.dropKey('a')), /depth limit/);
assert.throws(() => schema.describeField({}, 'test', { depth: -1 }), /nonnegative/);
console.log('renderer-schema: schema boundaries, field contracts and CMS preservation passed');
