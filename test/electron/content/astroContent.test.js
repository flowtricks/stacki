// Goal: a project's Astro content collections are edited in the CMS panel as a connected
// CMS's are — their schema maps onto the remote field types, an entry reads and writes in
// place, new entries and collections are valid Astro, and what a file cannot hold is left
// out rather than mangled.
// Method: the schema mapper is fed zod-shaped JSON Schema directly; the config patcher is fed
// configs with and without an existing collections export; the service runs against a
// temporary project with its content config injected (the child process that reads a real
// config is covered by contentConfig.test.js), so every write lands in a throwaway folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { astroSchemaFields, labelize, referencedCollections } = require('#dist/electron/content/astroRemoteSchema.js');
const { addCollectionToConfig, createAstroCollection } = require('#dist/electron/content/astroCollectionConfig.js');
const { astroRemoteService, documentId } = require('#dist/electron/content/astroRemoteService.js');
const { parseRemoteDocument, parseRemoteDocumentList } = require('#dist/shared/properties/cmsRemote.js');

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['draft', 'live'] },
    email: { type: 'string', format: 'email' },
    link: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] },
    views: { type: 'integer', minimum: 0 },
    featured: { type: 'boolean', default: false },
    date: { type: 'string', astroDate: true },
    cover: { type: 'string', astroImage: true },
    author: { type: 'string', astroReference: 'people' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    seo: { type: 'object', properties: { description: { type: 'string' } }, required: [] },
    either: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
    lookup: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['title', 'status', 'link', 'featured'],
};

test('a zod schema maps onto the remote field types the panel draws', () => {
  const people = [{ title: 'Ada', value: 'ada' }];
  const fields = astroSchemaFields(SCHEMA, new Map([['people', people]]));
  const byName = new Map(fields.map((field) => [field.name, field]));
  assert.deepEqual(
    fields.map((field) => field.name),
    ['title', 'status', 'email', 'link', 'views', 'featured', 'date', 'cover', 'author', 'tags', 'seo'],
    'a union and a record are left out',
  );
  assert.equal(byName.get('title').required, true);
  assert.deepEqual(byName.get('title').rules, [
    { level: 'error', kind: 'required' },
    { level: 'error', kind: 'min', limit: 1 },
  ]);
  assert.deepEqual(byName.get('status').type.options, [
    { title: 'Draft', value: 'draft' },
    { title: 'Live', value: 'live' },
  ]);
  assert.equal(byName.get('email').type.kind, 'email');
  assert.equal(byName.get('link').type.kind, 'url');
  assert.equal(byName.get('link').required, false, 'a nullable field may be empty');
  assert.equal(byName.get('featured').required, false, 'a default fills an absent key');
  assert.ok(byName.get('views').rules.some((rule) => rule.kind === 'integer'));
  assert.equal(byName.get('date').type.kind, 'date');
  assert.deepEqual(byName.get('cover').type, { kind: 'string', options: [], asset: 'image' });
  assert.deepEqual(byName.get('author').type, { kind: 'string', options: people });
  assert.deepEqual(byName.get('tags').type, {
    kind: 'array',
    of: [{ kind: 'string', options: [] }],
  });
  assert.equal(byName.get('seo').type.kind, 'object');
  assert.equal(byName.get('seo').type.fields[0].type.kind, 'text', 'a description is long text');
});

test('the mapper finds every referenced collection and survives a schema with no fields', () => {
  assert.deepEqual(referencedCollections(SCHEMA), ['people']);
  assert.deepEqual(referencedCollections({ items: { astroReference: 'tags' } }), ['tags']);
  assert.deepEqual(astroSchemaFields(undefined, new Map()), []);
  assert.deepEqual(astroSchemaFields('nonsense', new Map()), []);
  assert.deepEqual(astroSchemaFields({ type: 'object' }, new Map()), []);
  assert.equal(labelize('publishDate'), 'Publish date');
  assert.equal(labelize('hero_image'), 'Hero image');
});

test('a recursive schema stops at the depth bound instead of looping', () => {
  const recursive = {
    type: 'object',
    properties: { node: { $ref: '#/$defs/Node' } },
    $defs: {
      Node: {
        type: 'object',
        properties: { name: { type: 'string' }, child: { $ref: '#/$defs/Node' } },
      },
    },
  };
  const [node] = astroSchemaFields(recursive, new Map());
  let depth = 0;
  for (let at = node?.type; at?.kind === 'object'; at = at.fields.find((field) => field.name === 'child')?.type) {
    depth += 1;
  }
  assert.ok(depth > 0 && depth <= 8, `nested ${depth} levels`);
});

test('a new project gets a content config with one glob collection', () => {
  const patch = addCollectionToConfig(undefined, 'blogPosts');
  assert.equal(patch.ok, true);
  assert.equal(patch.value.folder, 'src/content/blog-posts');
  assert.match(patch.value.text, /import \{ defineCollection \} from 'astro:content';/);
  assert.match(patch.value.text, /import \{ z \} from 'astro\/zod';/);
  const loader = "glob({ base: './src/content/blog-posts', pattern: '**/*.{md,mdx}' })";
  assert.ok(patch.value.text.includes(loader), 'a glob over the collection folder');
  assert.match(patch.value.text, /export const collections = \{ blogPosts \};/);
});

test('an existing config gains the collection beside the others, and its missing imports', () => {
  const source = [
    "import { defineCollection, z } from 'astro:content';",
    "import { file } from 'astro/loaders';",
    '',
    "const team = defineCollection({ loader: file('src/data/team.json') });",
    '',
    'export const collections = {',
    '  team,',
    "  'faq': defineCollection({ loader: file('src/data/faq.json') }),",
    '};',
    '',
  ].join('\n');
  const patch = addCollectionToConfig(source, 'news');
  assert.equal(patch.ok, true);
  const { text } = patch.value;
  assert.match(text, /^import \{ glob \} from 'astro\/loaders';\n/, 'only glob is missing');
  assert.doesNotMatch(text, /astro\/zod/, 'z is already imported');
  assert.match(text, /const news = defineCollection\(\{/);
  assert.match(text, /\n  'faq': defineCollection\(\{ loader: file\('src\/data\/faq\.json'\) \}\),\n  news,\n\};/);
  assert.ok(text.indexOf('const news') < text.indexOf('export const collections'));
  const oneLine = addCollectionToConfig('export const collections = { team };\n', 'news');
  assert.match(oneLine.value.text, /export const collections = \{ team, news \};/);
  const empty = addCollectionToConfig('export const collections = {};\n', 'news');
  assert.match(empty.value.text, /export const collections = \{ news \};/);
});

test('a config that cannot take the collection is refused with the reason', () => {
  const taken = addCollectionToConfig('export const collections = { news };\n', 'news');
  assert.deepEqual(taken, { ok: false, error: 'A collection named “news” already exists.' });
  const keyed = addCollectionToConfig("export const collections = { 'news': x };\n", 'news');
  assert.equal(keyed.ok, false);
  const missing = addCollectionToConfig('export default {};\n', 'news');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /could not find/);
  const open = addCollectionToConfig('export const collections = { a: "}", b: {', 'news');
  assert.equal(open.ok, false);
  assert.match(open.error, /not closed/);
  const shadowed = addCollectionToConfig("import news from './news';\nexport const collections = { team };\n", 'news');
  assert.equal(shadowed.ok, true);
  assert.match(shadowed.value.text, /const newsCollection = defineCollection/);
  assert.match(shadowed.value.text, /\{ team, news: newsCollection \}/);
  assert.throws(() => addCollectionToConfig(undefined, 'Not valid'), /identifier/);
});

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-astro-content-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const BLOG = {
  name: 'blog',
  loader: { kind: 'glob', base: './src/content/blog', pattern: '**/*.md' },
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      date: { type: 'string', astroDate: true },
      author: { type: 'string', astroReference: 'people' },
      odd: { type: 'object', additionalProperties: true },
    },
    required: ['title'],
  },
};
const PEOPLE = { name: 'people', loader: { kind: 'file', file: 'src/data/people.json' } };
const LIVE = { name: 'live', loader: { kind: 'custom' } };

function service(root, collections, trashed = []) {
  return astroRemoteService(root, {
    readConfig: async () => ({ collections }),
    trash: async (file) => {
      trashed.push(file);
      fs.rmSync(file);
    },
  });
}

test('collections in files are listed with their counts; one built by code is not', async () => {
  const root = project({
    'src/content/blog/first.md': '---\ntitle: First\n---\nHello\n',
    'src/content/blog/2024/second.md': '---\ntitle: Second\n---\n',
    'src/data/people.json': '[{"id":"ada","name":"Ada"},{"id":"alan","name":"Alan"}]',
  });
  const collections = await service(root, [BLOG, PEOPLE, LIVE]).collections();
  assert.deepEqual(collections, [
    { name: 'blog', count: 2, icon: undefined },
    { name: 'people', count: 2, icon: undefined },
  ]);
});

test('an entry reads as a remote document and writes one field or its body in place', async () => {
  const root = project({
    'src/content/blog/2024/post one.md': '---\ntitle: First # kept\ndate: 2024-03-01\n---\nHello\n',
    'src/data/people.json': '[{"id":"ada","name":"Ada"}]',
  });
  const content = service(root, [BLOG, PEOPLE]);
  const list = parseRemoteDocumentList(await content.documents('blog'));
  const [summary] = list.documents;
  assert.equal(summary.id, documentId('blog', '2024/post one'));
  assert.equal(summary.title, 'First');
  assert.equal(summary.subtitle, '2024/post one');
  assert.equal(list.orderable, false);
  const document = parseRemoteDocument(await content.document(summary.id));
  assert.deepEqual(
    document.fields.map((field) => [field.name, field.value]),
    [
      ['title', 'First'],
      ['date', '2024-03-01'],
      ['author', undefined],
      ['body', 'Hello\n'],
    ],
  );
  assert.equal(document.file, 'src/content/blog/2024/post one.md', 'image paths resolve here');
  const author = document.fields.find((field) => field.name === 'author');
  assert.deepEqual(author.type.options, [{ title: 'Ada', value: 'ada' }]);
  await content.write({ id: summary.id, field: 'author', value: 'ada' });
  await content.write({ id: summary.id, field: 'body', value: 'Changed\n' });
  const written = await content.write({ id: summary.id, field: 'date', value: undefined });
  const file = fs.readFileSync(path.join(root, 'src/content/blog/2024/post one.md'), 'utf8');
  assert.equal(file, '---\ntitle: First # kept\nauthor: ada\n---\nChanged\n');
  assert.equal(written.fields.find((field) => field.name === 'author').value, 'ada');
});

test('new entries are files the glob matches, and deletes trash them', async () => {
  const root = project({
    'src/content/blog/untitled.md': '---\ntitle: Taken\n---\n',
    'src/data/people.json': '[{"id":"ada","name":"Ada"}]',
  });
  const trashed = [];
  const content = service(root, [BLOG, PEOPLE], trashed);
  const made = await content.create('blog');
  assert.equal(made.title, 'Untitled');
  const madeFile = path.join(root, 'src/content/blog/untitled-2.md');
  assert.equal(fs.readFileSync(madeFile, 'utf8'), '---\ntitle: Untitled\n---\n');
  assert.equal(await content.remove([made.id]), 1);
  assert.deepEqual(trashed, [madeFile]);
  await assert.rejects(() => content.document('blog.0000000000000000'), /no longer/);
  await assert.rejects(() => content.document('nothing'), /not a content collection entry/);
  await assert.rejects(() => content.documents('live'), /not a content collection/);
});

test('a glob collection lists its entries newest first, not by file name', async () => {
  // `untitled-2.md` sorts before `untitled.md` by name; created later, it and
  // `untitled-3.md` must come first. Creation time is real file-system time,
  // so each entry is made a moment after the last.
  const root = project({ 'src/content/blog/untitled.md': '---\ntitle: First\n---\n' });
  const content = service(root, [BLOG]);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  await pause();
  const second = await content.create('blog');
  await pause();
  const third = await content.create('blog');
  const listed = (await content.documents('blog')).documents.map((document) => document.id);
  assert.deepEqual(listed, [third.id, second.id, documentId('blog', 'untitled')]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a broken config is said, not hidden behind an empty list', async () => {
  const content = astroRemoteService(project({}), {
    readConfig: async () => ({ collections: [], error: 'z is not defined' }),
    trash: async () => {},
  });
  await assert.rejects(() => content.collections(), /could not be read — z is not defined/);
});

test('creating a collection writes the config and its folder, once', async () => {
  const root = project({ 'package.json': '{}' });
  const made = createAstroCollection(root, 'sermons');
  assert.equal(made.folder, 'src/content/sermons');
  assert.ok(fs.statSync(path.join(root, 'src/content/sermons')).isDirectory());
  const config = fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8');
  assert.match(config, /export const collections = \{ sermons \};/);
  createAstroCollection(root, 'events');
  const twice = fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8');
  assert.match(twice, /export const collections = \{ sermons, events \};/);
  assert.throws(() => createAstroCollection(root, 'events'), /already exists/);
  const content = service(root, [{ ...BLOG, name: 'sermons' }]);
  await assert.rejects(() => content.createCollection('sermons'), /already exists/);
});

test('an entry image path resolves to the project file Astro reads, or to none', () => {
  const { projectImage } = require('#dist/electron/content/astroRemoteService.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-image-'));
  fs.mkdirSync(path.join(root, 'public/images'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/assets/images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/images/hero.webp'), '');
  fs.writeFileSync(path.join(root, 'public/images/both.webp'), '');
  fs.mkdirSync(path.join(root, 'images'));
  fs.writeFileSync(path.join(root, 'images/both.webp'), '');
  fs.writeFileSync(path.join(root, 'src/assets/images/staff.webp'), '');
  const entry = 'src/content/team/ada.md';
  assert.equal(projectImage(root, entry, './ada.jpg'), 'src/content/team/ada.jpg');
  assert.equal(projectImage(root, entry, '../../assets/a b.png?v=2'), 'src/assets/a b.png');
  assert.equal(projectImage(root, entry, '/images/hero.webp'), 'public/images/hero.webp');
  // Vite reads a root path from public/ first, then from the project root.
  assert.equal(projectImage(root, entry, '/images/both.webp'), 'public/images/both.webp');
  assert.equal(projectImage(root, entry, '/src/assets/images/staff.webp'), 'src/assets/images/staff.webp');
  // A root path found in neither place keeps the public/ reading.
  assert.equal(projectImage(root, entry, '/images/missing.webp'), 'public/images/missing.webp');
  assert.equal(projectImage(root, 'src/data/team.json', 'photo.png'), 'src/data/photo.png');
  for (const outside of ['', 'https://cdn.example.com/a.png', '@/assets/a.png', '../../../../x.png']) {
    assert.equal(projectImage(root, entry, outside), undefined, outside);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('a plain string of another collection’s record ids becomes a choice of its titles', () => {
  const { withInferredReferences } = require('#dist/electron/content/astroRecordReferences.js');
  const record = (id, title, data) => ({
    id,
    title,
    data,
    file: 'x.json',
    format: 'json',
    locator: [],
  });
  const campus = {
    name: 'campus',
    entries: [record('main', 'Main', { _id: 'w1' }), record('north', 'North', { _id: 'w2' })],
  };
  const team = {
    name: 'team',
    entries: [record('ada', 'Ada', { campus: 'w1', campuses: ['w1', 'w2'], role: 'Lead' }), record('alan', 'Alan', { campus: 'w2', campuses: [], role: 'w1' })],
  };
  const text = { kind: 'string', options: [] };
  const field = (name, type) => ({
    name,
    title: name,
    description: '',
    required: false,
    rules: [],
    type,
  });
  const fields = [
    field('campus', text),
    field('campuses', { kind: 'array', of: [text] }),
    field('role', text),
    field('photo', { kind: 'string', options: [], asset: 'image' }),
  ];
  const [campusField, campusesField, roleField, photoField] = withInferredReferences(fields, team, [campus, team]);
  const options = [
    { title: 'Main', value: 'w1' },
    { title: 'North', value: 'w2' },
  ];
  assert.deepEqual(campusField.type, { kind: 'string', options });
  assert.deepEqual(campusesField.type, { kind: 'array', of: [{ kind: 'string', options }] });
  assert.deepEqual(roleField.type, text, '“Lead” names no record, so role stays free text');
  assert.equal(photoField.type.asset, 'image', 'an image path is never a reference');
  const byEntryId = withInferredReferences(
    [field('home', text)],
    {
      name: 'people',
      entries: [record('p', 'P', { home: 'north' })],
    },
    [campus],
  );
  assert.deepEqual(
    byEntryId[0].type.options.map((option) => option.value),
    ['main', 'north'],
  );
});

test('a data file gains records beside its others and loses them in place', async () => {
  const root = project({
    'src/data/people.json': ['[', '  { "id": "ada", "name": "Ada", "staff": true },', '  { "id": "alan", "name": "Alan", "staff": false }', ']', ''].join('\n'),
    'src/data/teams.yaml': 'red:\n  title: Red # kept\nblue:\n  title: Blue\n',
  });
  const people = {
    name: 'people',
    loader: { kind: 'file', file: 'src/data/people.json' },
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, staff: { type: 'boolean' }, bio: { type: 'string' } },
      required: ['name', 'staff'],
    },
  };
  const teams = { name: 'teams', loader: { kind: 'file', file: './src/data/teams.yaml' } };
  const content = service(root, [people, teams]);
  const made = await content.create('people');
  assert.equal(made.title, 'Untitled');
  const json = () => JSON.parse(fs.readFileSync(path.join(root, 'src/data/people.json'), 'utf8'));
  assert.deepEqual(json()[2], { id: 'untitled', name: 'Untitled', staff: false });
  const [ada] = (await content.documents('people')).documents;
  assert.equal(await content.remove([ada.id, made.id]), 2);
  assert.deepEqual(json(), [{ id: 'alan', name: 'Alan', staff: false }]);
  await content.create('teams');
  const yaml = fs.readFileSync(path.join(root, 'src/data/teams.yaml'), 'utf8');
  assert.match(yaml, /^red:\n  title: Red # kept\nblue:\n  title: Blue\nuntitled:\n  title: Untitled\n$/);
});

test('an empty data file takes its first record, and other formats are refused', async () => {
  const root = project({
    'src/data/sermons.json': '[]\n',
    'src/data/notes.toml': '[a]\ntitle = "A"\n',
  });
  const sermons = { name: 'sermons', loader: { kind: 'file', file: 'src/data/sermons.json' } };
  const notes = { name: 'notes', loader: { kind: 'file', file: 'src/data/notes.toml' } };
  const content = service(root, [sermons, notes]);
  const made = await content.create('sermons');
  const written = JSON.parse(fs.readFileSync(path.join(root, 'src/data/sermons.json'), 'utf8'));
  assert.deepEqual(written, [{ id: 'untitled', title: 'Untitled' }]);
  assert.equal((await content.documents('sermons')).documents[0].id, made.id);
  await assert.rejects(() => content.create('notes'), /JSON and YAML files, not toml/);
});

test('exported keys that start with a digit or hold dashes are fields like any other', () => {
  const schema = {
    type: 'object',
    properties: {
      '1-logo-svg': { type: 'string', astroImage: true },
      'campus-description': { type: ['string', 'null'] },
      _id: { type: 'string' },
    },
  };
  const fields = astroSchemaFields(schema, new Map());
  assert.deepEqual(
    fields.map((field) => [field.name, field.title, field.type.kind, field.required]),
    [
      ['1-logo-svg', '1 logo svg', 'string', false],
      ['campus-description', 'Campus description', 'string', false],
    ],
    'a system `_` key is still left out',
  );
  assert.equal(fields[0].type.asset, 'image');
});

test('a list read with columns carries each entry’s values, references by name', async () => {
  const root = project({
    'src/data/campus.json': '[{"id":"main","name":"Main","_id":"w1"},{"id":"north","name":"North","_id":"w2"}]',
    'src/data/team.json': '[{"id":"ada","name":"Ada","campus":"w2","staff":true,"order":2}]',
  });
  const campus = { name: 'campus', loader: { kind: 'file', file: 'src/data/campus.json' } };
  const team = {
    name: 'team',
    loader: { kind: 'file', file: 'src/data/team.json' },
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        campus: { type: 'string' },
        staff: { type: 'boolean' },
        order: { type: 'number' },
      },
    },
  };
  const content = service(root, [campus, team]);
  const plain = await content.documents('team');
  assert.equal(plain.documents[0].cells, undefined, 'no columns, no cells');
  const listed = await content.documents('team', ['campus', 'staff', 'order', 'name']);
  assert.deepEqual(listed.documents[0].cells, {
    campus: 'North',
    staff: true,
    order: 2,
    name: 'Ada',
  });
});
