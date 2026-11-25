// Goal: Payload's values become the panel's and back without loss, and what cannot be written back exactly is
// never written: ids name a collection and a document, rich text is editable only when it is plain paragraphs,
// a localized field is one entry per locale, rows keep ids Payload issued and are not given made-up ones, a
// value past the panel's bounds is cut and flagged. Also: the schema read from the recorded GraphQL answer.
// Method: pure functions on recorded Payload shapes (test/fixtures/cms/payload/), each valid shape and each
// invalid one; no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../../helpers/fakePayload.js');
const values = require('#dist/electron/content/payloadValues.js');
const schema = require('#dist/electron/content/payloadSchema.js');
const cms = require('#dist/shared/properties/cmsRemoteSchema.js');

// eslint-disable-next-line stacki/no-null -- The tests state Payload's JSON null by name.
const CLEARED = null;
const context = (extra = {}) => ({ baseUrl: 'http://cms.test', locales: ['en', 'fr'], assets: new Map(), ...extra });
const paragraph = (text, format = 0) => ({
  type: 'paragraph',
  format: '',
  indent: 0,
  version: 1,
  direction: 'ltr',
  textFormat: 0,
  children: text === '' ? [] : [{ type: 'text', mode: 'normal', text, style: '', detail: 0, format, version: 1 }],
});
const lexical = (...paragraphs) => ({ root: { type: 'root', format: '', indent: 0, version: 1, direction: 'ltr', children: paragraphs } });

test('an id names its collection, and numbers stay numbers for Payload', () => {
  assert.equal(values.encodeId('posts', 7), 'posts.7');
  assert.deepEqual(values.decodeId('posts.7'), { slug: 'posts', id: 7 });
  assert.deepEqual(values.decodeId('posts.66aa2c5e8b1f4a0012345678'), { slug: 'posts', id: '66aa2c5e8b1f4a0012345678' });
  assert.deepEqual(values.decodeId('posts.9b2e0c1a-0000-4000-8000-000000000000'), { slug: 'posts', id: '9b2e0c1a-0000-4000-8000-000000000000' });
  for (const bad of ['', 'posts', '.7', 'posts.', 'nodot']) {
    assert.equal(values.decodeId(bad), undefined, bad);
  }
  assert.throws(() => values.encodeId('a.b', 1), /no dot/);
  assert.throws(() => values.encodeId('', 1), /named/);
});

test('plain paragraphs are editable text and come back as paragraphs; the root and paragraph attributes are kept', () => {
  const tree = lexical(paragraph('First'), paragraph(''), paragraph('Third'));
  assert.deepEqual(values.lexicalText(tree), { text: 'First\n\nThird', simple: true });
  const field = { name: 'body', required: false, localized: false, kind: 'richText' };
  const written = values.toPayloadValue(field, 'First\n\nThird edited', { rowIds: new Set(), previous: tree });
  assert.deepEqual(
    written.root.children.map((node) => node.children.map((child) => child.text)),
    [['First'], [], ['Third edited']],
  );
  assert.equal(values.lexicalText(written).text, 'First\n\nThird edited', 'it reads back as it was written');
  assert.equal(written.root.direction, 'ltr');
});

test('anything beyond plain paragraphs is shown but cannot be written over', () => {
  const field = { name: 'body', required: false, localized: false, kind: 'richText' };
  const cases = {
    bold: lexical(paragraph('x', 1)),
    heading: lexical({ type: 'heading', tag: 'h2', children: [{ type: 'text', text: 'Title', format: 0, mode: 'normal', style: '', detail: 0, version: 1 }] }),
    link: lexical({
      ...paragraph(''),
      children: [{ type: 'link', children: [{ type: 'text', text: 'a', format: 0, mode: 'normal', style: '', detail: 0, version: 1 }] }],
    }),
    upload: lexical({ type: 'upload', value: 3 }),
    linebreak: lexical({ ...paragraph(''), children: [{ type: 'linebreak' }] }),
  };
  for (const [name, tree] of Object.entries(cases)) {
    assert.equal(values.lexicalEditable(tree), false, name);
    assert.throws(() => values.toPayloadValue(field, 'replacement', { rowIds: new Set(), previous: tree }), /Edit it in Payload/, name);
  }
  assert.equal(values.lexicalText(cases.heading).text, 'Title', 'a heading still previews as text');
  assert.equal(values.lexicalEditable(undefined), true, 'an empty field can be written');
  assert.equal(values.lexicalText({ root: { type: 'paragraph' } }), undefined, 'not Lexical');
});

test('a localized top-level field is one entry per locale; one nested inside a group is shown as JSON and locked', () => {
  const field = { name: 'title', required: true, localized: true, kind: 'scalar', scalar: 'string' };
  const schemaField = values.remoteSchemaField(field, ['en', 'fr']);
  assert.equal(schemaField.type.kind, 'object');
  assert.deepEqual(
    schemaField.type.fields.map((entry) => entry.name),
    ['en', 'fr'],
  );
  assert.equal(schemaField.required, false, 'one locale may be empty');
  assert.deepEqual(values.toRemoteValue(field, { en: 'Hello', fr: 'Bonjour' }, context()), { en: 'Hello', fr: 'Bonjour' });
  assert.equal(values.toRemoteValue(field, { en: CLEARED }, context()), undefined);
  const group = { name: 'meta', required: false, localized: false, kind: 'group', fields: [field] };
  const nested = values.remoteSchemaField(group, ['en', 'fr']);
  assert.equal(nested.readOnly, 'always');
  assert.match(values.toRemoteValue(group, { title: { en: 'a' } }, context()), /"en": "a"/);
  const unlocalized = values.remoteSchemaField(field, []);
  assert.equal(unlocalized.type.kind, 'string', 'without locales a field is plain');
});

test('rows keep the ids Payload gave them, and a made-up key is not sent as an id', () => {
  const field = {
    name: 'links',
    required: false,
    localized: false,
    kind: 'array',
    fields: [{ name: 'label', required: false, localized: false, kind: 'scalar', scalar: 'string' }],
  };
  const read = values.toRemoteValue(field, [{ id: '66aa2c5e8b1f4a0012345678', label: 'A' }, { label: 'no id' }], context());
  assert.deepEqual(read, [
    { label: 'A', _key: '66aa2c5e8b1f4a0012345678', _type: 'links' },
    { label: 'no id', _key: 'row1', _type: 'links' },
  ]);
  const written = values.toPayloadValue(field, [...read, { _key: 'zz', _type: 'links', label: 'New' }], {
    rowIds: new Set(['66aa2c5e8b1f4a0012345678']),
    previous: undefined,
  });
  assert.deepEqual(written, [{ label: 'A', id: '66aa2c5e8b1f4a0012345678' }, { label: 'no id' }, { label: 'New' }]);
});

test('blocks carry their type both ways, and an unknown block is left out rather than guessed', () => {
  const field = {
    name: 'layout',
    required: false,
    localized: false,
    kind: 'blocks',
    blocks: [{ slug: 'hero', fields: [{ name: 'heading', required: false, localized: false, kind: 'scalar', scalar: 'string' }] }],
  };
  const read = values.toRemoteValue(
    field,
    [
      { id: 'a1', blockType: 'hero', heading: 'Hi' },
      { id: 'a2', blockType: 'mystery', x: 1 },
    ],
    context(),
  );
  assert.deepEqual(read, [{ heading: 'Hi', _key: 'a1', _type: 'hero' }]);
  const written = values.toPayloadValue(field, read, { rowIds: new Set(['a1']), previous: undefined });
  assert.deepEqual(written, [{ heading: 'Hi', id: 'a1', blockType: 'hero' }]);
  assert.equal(values.remoteSchemaField(field, []).type.of[0].name, 'hero');
});

test('relationships read from an id, a populated document or a polymorphic pair, and write back as ids', () => {
  const one = { name: 'author', required: false, localized: false, kind: 'relation', to: ['users'], many: false, upload: false };
  assert.deepEqual(values.toRemoteValue(one, 4, context()), { _key: 'r0-4', _type: 'reference', _ref: 'users.4' });
  assert.equal(values.toRemoteValue(one, { id: 4, email: 'private@example.test' }, context())._ref, 'users.4', 'a populated user shows only its id');
  assert.equal(values.toPayloadValue(one, { _type: 'reference', _ref: 'users.4' }, { rowIds: new Set(), previous: undefined }), 4);
  assert.equal(values.toPayloadValue(one, undefined, { rowIds: new Set(), previous: undefined }), CLEARED, 'clearing a relationship sends null');
  const poly = { name: 'target', required: false, localized: false, kind: 'relation', to: ['posts', 'pages'], many: false, upload: false };
  assert.equal(values.toRemoteValue(poly, { relationTo: 'pages', value: 2 }, context())._ref, 'pages.2');
  assert.deepEqual(values.toPayloadValue(poly, { _type: 'reference', _ref: 'pages.2' }, { rowIds: new Set(), previous: undefined }), {
    relationTo: 'pages',
    value: 2,
  });
  const many = { ...one, many: true };
  assert.deepEqual(
    values.toRemoteValue(many, [1, 2], context()).map((item) => item._ref),
    ['users.1', 'users.2'],
  );
});

test('an upload becomes an image or a file with an asset the panel can show, and refuses a file from another collection', () => {
  const field = { name: 'cover', required: false, localized: false, kind: 'relation', to: ['media'], many: false, upload: true };
  const state = context();
  const read = values.toRemoteValue(field, { id: 3, url: '/api/media/file/a.png', filename: 'a.png', mimeType: 'image/png' }, state);
  assert.equal(read.asset._ref, 'image-media-3');
  assert.deepEqual(state.assets.get('image-media-3'), { id: 'image-media-3', url: 'http://cms.test/api/media/file/a.png', filename: 'a.png' });
  assert.equal(values.remoteSchemaField(field, []).type.kind, 'image');
  const documents = { ...field, to: ['documents'] };
  assert.equal(values.remoteSchemaField(documents, []).type.kind, 'file');
  assert.equal(values.toPayloadValue(field, read, { rowIds: new Set(), previous: undefined }), 3);
  assert.throws(
    () => values.toPayloadValue(field, { _type: 'image', asset: { _type: 'reference', _ref: 'image-other-3' } }, { rowIds: new Set(), previous: undefined }),
    /not in media/,
  );
});

test('scalars, selects, points and JSON round-trip, and a value of the wrong type reads as absent, not as a guess', () => {
  const scalar = (name, scalarKind) => ({ name, required: false, localized: false, kind: 'scalar', scalar: scalarKind });
  const none = { rowIds: new Set(), previous: undefined };
  assert.equal(values.toRemoteValue(scalar('views', 'number'), 5, context()), 5);
  assert.equal(values.toRemoteValue(scalar('views', 'number'), '5', context()), undefined);
  assert.equal(values.toPayloadValue(scalar('views', 'number'), 'x', none), CLEARED);
  assert.equal(values.toRemoteValue(scalar('on', 'boolean'), false, context()), false);
  const point = { name: 'where', required: false, localized: false, kind: 'point' };
  assert.deepEqual(values.toRemoteValue(point, [10.5, 20.5], context()), { _type: 'geopoint', lat: 20.5, lng: 10.5 });
  assert.equal(values.toRemoteValue(point, [1], context()), undefined);
  assert.deepEqual(values.toPayloadValue(point, { _type: 'geopoint', lat: 20.5, lng: 10.5 }, none), [10.5, 20.5]);
  const json = { name: 'extra', required: false, localized: false, kind: 'json' };
  assert.deepEqual(JSON.parse(values.toRemoteValue(json, { k: [1, 2] }, context())), { k: [1, 2] });
  assert.deepEqual(values.toPayloadValue(json, '{"a":[1]}', none), { a: [1] });
  assert.equal(values.toPayloadValue(json, '   ', none), CLEARED);
  assert.throws(() => values.toPayloadValue(json, '{oops', none), /not valid JSON/);
  const select = { name: 'tags', required: false, localized: false, kind: 'select', options: ['x', 'y'], many: true };
  assert.deepEqual(values.toRemoteValue(select, ['x', 3, 'y'], context()), ['x', 'y']);
});

test('a value past the panel’s bounds is cut and flagged; one inside them is untouched', () => {
  assert.deepEqual(values.boundValue('short'), { value: 'short', cut: false });
  const long = values.boundValue('x'.repeat(200_000));
  assert.equal(long.cut, true);
  assert.ok(long.value.length < cms.REMOTE_SCHEMA_LIMITS.valueCharsMax);
  const wide = values.boundValue(Array.from({ length: 30_000 }, (_, index) => ({ n: index })));
  assert.equal(wide.cut, true);
  assert.doesNotThrow(() => cms.parseRemoteValue(wide.value), 'what is kept passes the panel’s own parser');
  assert.doesNotThrow(() => cms.parseRemoteValue(long.value));
  assert.equal(values.boundValue(undefined).cut, false);
});

test('the schema read from the recorded GraphQL answer has exact types, options, relations and uploads', () => {
  const graph = schema.parseIntrospection(fixture('graphql-introspection'), ['posts', 'pages', 'media', 'categories', 'users']);
  assert.ok(graph);
  assert.deepEqual(graph.locales, ['en', 'fr']);
  assert.equal(graph.typeNames.get('posts'), 'Post');
  assert.equal(graph.typeNames.get('media'), 'Media');
  assert.equal(graph.slugsByType.get('Category'), 'categories');
  assert.equal(schema.parseIntrospection({ data: {} }, []), undefined, 'not Payload');
  assert.equal(schema.parseIntrospection(undefined, []), undefined);
});

test('names read as titles', () => {
  assert.equal(values.titleOf('publishedAt'), 'Published At');
  assert.equal(values.titleOf('meta_description'), 'Meta description');
  assert.equal(values.titleOf('og-image'), 'Og image');
  assert.equal(values.assetKind('media'), 'image');
  assert.equal(values.assetKind('documents'), 'file');
  assert.equal(values.assetKind(undefined), 'file');
});
