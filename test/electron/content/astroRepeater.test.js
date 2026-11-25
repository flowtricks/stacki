// Goal: a repeater (a list whose items are groups of fields, such as team members each with a
// name and a photo) is made in the collection settings, written to the content config as
// `z.array(z.object({ … }))`, read back as the same repeater, and its items are edited in
// entries of every kind of file without the list editor's bookkeeping reaching them.
// Method: the schema editor runs on configs written here and every result is read back; the
// entry service runs on a temporary project with its content config injected, writing a
// repeater into a Markdown entry and into a JSON data collection, and reading the files raw.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { editCollectionSchema, readCollectionSchema } = require('#dist/electron/content/astroSchemaEdit.js');
const { astroSchemaFields } = require('#dist/electron/content/astroRemoteSchema.js');
const { astroRemoteService, documentId } = require('#dist/electron/content/astroRemoteService.js');
const { newFieldSettings, parseSettingsChange } = require('#dist/shared/properties/collectionSettings.js');

const CONFIG = [
  "import { defineCollection, z } from 'astro:content';",
  '',
  'const about = defineCollection({',
  '  schema: z.object({',
  '    title: z.string(),',
  '  }),',
  '});',
  '',
  'export const collections = { about };',
  '',
].join('\n');

const member = (name, kind, required = false, from = undefined) => ({ name, kind, required, from, editable: true });

function edit(source, change) {
  const result = editCollectionSchema(source, 'about', parseSettingsChange(change));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value.text;
}

function fieldNamed(source, name) {
  const read = readCollectionSchema(source, 'about');
  assert.equal(read.ok, true);
  return read.value.fields.find((field) => field.name === name);
}

const ADD_TEAM = {
  kind: 'addField',
  name: 'team',
  fieldKind: 'repeater',
  settings: newFieldSettings('repeater'),
  members: [member('name', 'text', true), member('photo', 'image'), member('bio', 'richText')],
};

test('a repeater is added with its fields, and reads back as the same repeater', () => {
  const text = edit(CONFIG, ADD_TEAM);
  assert.match(
    text,
    /team: z\.array\(z\.object\(\{ name: z\.string\(\), photo: image\(\)\.optional\(\), bio: z\.string\(\)\.optional\(\) \}\)\)\.optional\(\)/,
  );
  assert.match(text, /\(\{ image \}\) =>/, 'a photo field brings the schema `image` function');
  const team = fieldNamed(text, 'team');
  assert.equal(team.kind, 'repeater');
  assert.deepEqual(
    team.members.map((each) => [each.name, each.kind, each.required, each.from]),
    [
      ['name', 'text', true, 'name'],
      ['photo', 'image', false, 'photo'],
      ['bio', 'text', false, 'bio'],
    ],
  );
});

test('a new repeater with no fields given starts with a title', () => {
  const text = edit(CONFIG, { kind: 'addField', name: 'faq', fieldKind: 'repeater', settings: newFieldSettings('repeater') });
  assert.match(text, /faq: z\.array\(z\.object\(\{ title: z\.string\(\)\.optional\(\) \}\)\)\.optional\(\)/);
  assert.equal(fieldNamed(text, 'faq').kind, 'repeater');
});

test('a list given groups as its items becomes a repeater and back, and a list of text stays one', () => {
  const withTags = edit(CONFIG, { kind: 'addField', name: 'tags', fieldKind: 'list', settings: newFieldSettings('list') });
  assert.equal(fieldNamed(withTags, 'tags').kind, 'list');
  assert.equal(fieldNamed(withTags, 'tags').itemKind, 'text');
  const numbers = edit(CONFIG, { kind: 'addField', name: 'scores', fieldKind: 'list', itemKind: 'number', settings: newFieldSettings('list') });
  assert.match(numbers, /scores: z\.array\(z\.number\(\)\)\.optional\(\)/);
  assert.equal(fieldNamed(numbers, 'scores').itemKind, 'number');
  const grouped = edit(withTags, {
    kind: 'updateField',
    update: { name: 'tags', ...newFieldSettings('list'), itemKind: 'group', members: [member('label', 'text', true)] },
  });
  assert.match(grouped, /tags: z\.array\(z\.object\(\{ label: z\.string\(\) \}\)\)\.optional\(\)/);
  assert.equal(fieldNamed(grouped, 'tags').kind, 'repeater');
  const back = edit(grouped, { kind: 'updateField', update: { name: 'tags', ...newFieldSettings('list'), itemKind: 'text' } });
  assert.match(back, /tags: z\.array\(z\.string\(\)\)\.optional\(\)/);
  assert.equal(fieldNamed(back, 'tags').kind, 'list');
});

test('editing a repeater’s fields renames, requires, adds and removes, and keeps what it cannot read', () => {
  const written = [
    CONFIG.replace(
      '    title: z.string(),',
      [
        '    title: z.string(),',
        '    team: z.array(z.object({',
        '      name: z.string().min(2).describe("Full name"),',
        '      role: z.string().optional(),',
        '      ...shared,',
        '      "odd.key": z.string(),',
        '      age: z.number().transform((value) => value + 1).optional(),',
        '    })).optional(),',
      ].join('\n'),
    ),
  ][0];
  const read = fieldNamed(written, 'team');
  assert.equal(read.kind, 'repeater', 'a hand-written list of groups is a repeater');
  assert.deepEqual(
    read.members.map((each) => each.name),
    ['name', 'role', 'age'],
    'a spread and an odd key are not listed',
  );
  const update = {
    name: 'team',
    ...newFieldSettings('repeater'),
    itemKind: 'group',
    members: [{ ...read.members[0], name: 'fullName' }, { ...read.members[1], required: true }, member('photo', 'image')],
  };
  const text = edit(written, { kind: 'updateField', update });
  assert.match(text, /fullName: z\.string\(\)\.min\(2\)\.describe\("Full name"\)/, 'a renamed field keeps its checks');
  assert.match(text, /role: z\.string\(\)(?!\.optional)/, 'required drops the optional');
  assert.match(text, /photo: image\(\)\.optional\(\)/);
  assert.match(text, /\.\.\.shared/, 'a spread stays');
  assert.match(text, /"odd\.key": z\.string\(\)/, 'a key the form cannot name stays');
  assert.doesNotMatch(text, /age:/, 'a field taken off the list is removed');
  const again = fieldNamed(text, 'team');
  assert.deepEqual(
    again.members.map((each) => [each.name, each.required]),
    [
      ['fullName', true],
      ['role', true],
      ['photo', false],
    ],
  );
  // Saving the fields as read changes nothing at all.
  const same = edit(written, { kind: 'updateField', update: { name: 'team', ...newFieldSettings('repeater'), itemKind: 'group', members: read.members } });
  assert.equal(same, written);
});

test('changes that would break a repeater are refused at the boundary', () => {
  assert.throws(() => parseSettingsChange({ ...ADD_TEAM, members: [member('a', 'text'), member('a', 'number')] }), /different names/);
  assert.throws(() => parseSettingsChange({ ...ADD_TEAM, members: [member('bad name', 'text')] }), /name/i);
  assert.throws(() => parseSettingsChange({ ...ADD_TEAM, members: [member('ref', 'reference')] }), /kind a group can hold/);
  assert.throws(() => parseSettingsChange({ ...ADD_TEAM, members: Array.from({ length: 51 }, (_, index) => member(`f${index}`, 'text')) }), /fields/);
  assert.throws(() => parseSettingsChange({ ...ADD_TEAM, itemKind: 'nonsense', fieldKind: 'list' }), /item kind/);
});

const TEAM_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    team: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, photo: { type: 'string', astroImage: true } }, required: ['name'] },
    },
  },
};

test('an array of objects is an editable list of groups in the entry form', () => {
  const [, team] = astroSchemaFields(TEAM_SCHEMA, new Map());
  assert.equal(team.type.kind, 'array');
  assert.equal(team.type.of[0].kind, 'object');
  assert.deepEqual(
    team.type.of[0].fields.map((field) => field.name),
    ['name', 'photo'],
  );
});

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-astro-repeater-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function service(root, collections) {
  return astroRemoteService(root, { readConfig: async () => ({ collections }), trash: async () => {} });
}

// What the list editor sends: each item carries the keys it tells items apart by.
const EDITED = [
  { _type: 'team', _key: 'a1', name: 'Ada', photo: 'ada.jpg' },
  { _type: 'team', _key: 'b2', name: 'Alan' },
];
const PLAIN = [{ name: 'Ada', photo: 'ada.jpg' }, { name: 'Alan' }];

test('a repeater written to a Markdown entry holds the items alone, in order, and survives a reread', async () => {
  const root = project({ 'src/content/about/page.md': '---\ntitle: About\n---\nHi\n' });
  const collection = {
    name: 'about',
    loader: { kind: 'glob', base: './src/content/about', pattern: '**/*.md' },
    schema: TEAM_SCHEMA,
  };
  const content = service(root, [collection]);
  const id = documentId('about', 'page');
  await content.write({ id, field: 'team', value: EDITED });
  const file = fs.readFileSync(path.join(root, 'src/content/about/page.md'), 'utf8');
  assert.doesNotMatch(file, /_key|_type/, 'no bookkeeping in the file');
  const document = await content.document(id);
  assert.deepEqual(document.fields.find((field) => field.name === 'team').value, PLAIN);
  // Reorder and remove: the whole list is written each time.
  await content.write({ id, field: 'team', value: [EDITED[1]] });
  assert.deepEqual((await content.document(id)).fields.find((field) => field.name === 'team').value, [{ name: 'Alan' }]);
  await content.write({ id, field: 'team', value: undefined });
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/content/about/page.md'), 'utf8'), /team/);
});

test('a repeater written to a JSON data collection holds the items alone', async () => {
  const root = project({ 'src/data/about.json': '[{"id":"main","title":"About"}]' });
  const collection = { name: 'about', loader: { kind: 'file', file: 'src/data/about.json' }, schema: TEAM_SCHEMA };
  const content = service(root, [collection]);
  const [summary] = (await content.documents('about')).documents;
  await content.write({ id: summary.id, field: 'team', value: EDITED });
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'src/data/about.json'), 'utf8'));
  assert.deepEqual(stored[0].team, PLAIN);
  assert.equal(stored[0].title, 'About');
});
