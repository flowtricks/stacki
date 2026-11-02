// Goal: a content collection's settings edit its schema in the content config as text — only
// the spans a change touches, and within a field only the methods for the settings that
// changed, so a schema written by hand keeps everything else — and carry renames through its
// entries and the code that reads it, while a config the editor cannot read is refused.
// Method: the schema editor runs on configs written here (inline, by name, shorthand, and the
// one-line form a Webflow export writes); the settings service runs on a temporary project
// with its content config injected, so every write lands in a throwaway folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { editCollectionSchema, newFieldText, readCollectionSchema, settledFieldText } = require('#dist/electron/content/astroSchemaEdit.js');
const {
  changeCollectionSettings,
  namesCollection,
  renameCollectionIn,
  renameFieldIn,
  unlinkCollectionIn,
} = require('#dist/electron/content/astroCollectionSettings.js');
const { newFieldSettings, parseSettingsChange, parseCollectionRename } = require('#dist/shared/properties/collectionSettings.js');

const CONFIG = [
  "import { defineCollection, z } from 'astro:content';",
  "import { glob, file } from 'astro/loaders';",
  '',
  'const blog = defineCollection({',
  "  loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),",
  '  schema: z.object({',
  '    title: z.string().min(1),',
  '    email: z.string().email().optional(),',
  '    link: z.string().url().nullish(),',
  '    color: z.string().regex(/^#[0-9a-f]{6}$/),',
  "    tier: z.enum(['a', 'b']),",
  '    views: z.number().max(10).describe("Times read"),',
  '    live: z.boolean().default(false),',
  "    author: reference('people'),",
  "    team: z.array(reference('people')).optional(),",
  '    slug: z.string().transform((value) => value.trim()),',
  '  }),',
  '});',
  '',
  'export const collections = {',
  '  blog,',
  "  people: defineCollection({ loader: file('src/data/people.json'), " + 'schema: z.object({ name: z.string() }) }),',
  '};',
  '',
].join('\n');

test('every field is read with its kind and the settings its chain states', () => {
  const read = readCollectionSchema(CONFIG, 'blog');
  assert.equal(read.ok, true);
  assert.equal(read.value.source, 'src/content/blog');
  const byName = new Map(read.value.fields.map((field) => [field.name, field]));
  assert.deepEqual(
    read.value.fields.map((field) => [field.name, field.kind]),
    [
      ['title', 'text'],
      ['email', 'email'],
      ['link', 'link'],
      ['color', 'color'],
      ['tier', 'option'],
      ['views', 'number'],
      ['live', 'switch'],
      ['author', 'reference'],
      ['team', 'multiReference'],
      ['slug', 'text'],
    ],
  );
  assert.equal(byName.get('title').checks.min, 1);
  assert.equal(byName.get('title').required, true);
  assert.equal(byName.get('email').required, false);
  assert.equal(byName.get('live').required, false, 'a default makes a key optional');
  assert.equal(byName.get('views').description, 'Times read');
  assert.equal(byName.get('views').checks.max, 10);
  assert.equal(byName.get('slug').editable, true, 'a transform is kept as written around edits');
  assert.equal(readCollectionSchema(CONFIG, 'people').value.source, 'src/data/people.json');
  assert.equal(readCollectionSchema(CONFIG, 'nothing').ok, false);
  assert.equal(readCollectionSchema('export default {}', 'blog').ok, false);
});

test('updating a field rewrites only its chain, keeping its other validators', () => {
  const update = {
    name: 'email',
    description: 'Where to write',
    required: true,
    checks: { min: 5, max: 80 },
    options: undefined,
    defaultValue: undefined,
  };
  const edit = editCollectionSchema(CONFIG, 'blog', { kind: 'updateField', update });
  assert.equal(edit.ok, true);
  assert.match(edit.value.text, /email: z\.string\(\)\.email\(\)\.min\(5\)\.max\(80\)\.describe\("Where to write"\),/);
  assert.equal(edit.value.text.replace(/\n    email: .*\n/, '\n'), CONFIG.replace(/\n    email: .*\n/, '\n'));
  const optional = editCollectionSchema(CONFIG, 'blog', {
    kind: 'updateField',
    update: {
      name: 'title',
      description: undefined,
      required: false,
      checks: {},
      options: undefined,
      defaultValue: undefined,
    },
  });
  assert.match(optional.value.text, /title: z\.string\(\)\.optional\(\),/);
  const handWritten = editCollectionSchema(CONFIG, 'blog', {
    kind: 'updateField',
    update: { name: 'slug', description: 'x', required: true, checks: { max: 40 } },
  });
  assert.equal(handWritten.ok, true);
  assert.match(handWritten.value.text, /slug: z\.string\(\)\.max\(40\)\.transform\(\(value\) => value\.trim\(\)\)\.describe\("x"\),/);
});

test('fields are reordered, renamed, added and removed in the layout the config has', () => {
  const names = readCollectionSchema(CONFIG, 'blog').value.fields.map((field) => field.name);
  const reordered = editCollectionSchema(CONFIG, 'blog', {
    kind: 'reorder',
    order: [...names].reverse(),
  });
  assert.match(reordered.value.text, /schema: z\.object\(\{\n {4}slug: .*\n {4}team: /);
  assert.equal(editCollectionSchema(CONFIG, 'blog', { kind: 'reorder', order: ['title'] }).ok, false);
  const renamed = editCollectionSchema(CONFIG, 'blog', {
    kind: 'renameField',
    from: 'views',
    to: 'read-count',
  });
  assert.match(renamed.value.text, /"read-count": z\.number\(\)/);
  assert.equal(editCollectionSchema(CONFIG, 'blog', { kind: 'renameField', from: 'views', to: 'title' }).ok, false);
  const removed = editCollectionSchema(CONFIG, 'blog', { kind: 'removeField', name: 'tier' });
  assert.doesNotMatch(removed.value.text, /tier:/);
  const inline = editCollectionSchema(CONFIG, 'people', {
    kind: 'addField',
    name: 'bio',
    fieldKind: 'richText',
    target: undefined,
    settings: newFieldSettings('richText'),
  });
  assert.match(inline.value.text, /z\.object\(\{ name: z\.string\(\), bio: z\.string\(\)\.optional\(\) \}\)/);
});

test('a new image field gets `image` from the schema, and a reference its import', () => {
  const image = editCollectionSchema(CONFIG, 'blog', {
    kind: 'addField',
    name: 'cover',
    fieldKind: 'image',
    target: undefined,
    settings: newFieldSettings('image'),
  });
  assert.match(image.value.text, /schema: \(\{ image \}\) => z\.object\(\{/);
  assert.match(image.value.text, /cover: image\(\)\.optional\(\),/);
  const again = editCollectionSchema(image.value.text, 'blog', {
    kind: 'addField',
    name: 'photos',
    fieldKind: 'multiImage',
    target: undefined,
    settings: newFieldSettings('multiImage'),
  });
  assert.equal((again.value.text.match(/\(\{ image \}\)/g) ?? []).length, 1, 'image is added once');
  const reference = editCollectionSchema(CONFIG, 'people', {
    kind: 'addField',
    name: 'posts',
    fieldKind: 'multiReference',
    target: 'blog',
    settings: newFieldSettings('multiReference'),
  });
  assert.match(reference.value.text, /^import \{ defineCollection, z, reference \} from 'astro:content';/);
  assert.match(reference.value.text, /posts: z\.array\(reference\("blog"\)\)\.optional\(\)/);
  const nowhere = editCollectionSchema(CONFIG, 'people', {
    kind: 'addField',
    name: 'x',
    fieldKind: 'reference',
    target: 'missing',
    settings: newFieldSettings('reference'),
  });
  assert.equal(nowhere.ok, false);
  assert.equal(newFieldText('color', ''), 'z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()');
  assert.equal(newFieldText('option', ''), "z.enum(['Option 1', 'Option 2']).optional()");
});

test('a collection is renamed by its key, and a glob folder named for it moves', () => {
  const blog = editCollectionSchema(CONFIG, 'blog', { kind: 'renameCollection', to: 'posts' });
  assert.match(blog.value.text, /\n {2}posts: blog,\n/);
  assert.ok(blog.value.text.includes("base: './src/content/posts'"), 'the glob base follows');
  assert.deepEqual(blog.value.move, { from: 'src/content/blog', to: 'src/content/posts' });
  const people = editCollectionSchema(CONFIG, 'people', {
    kind: 'renameCollection',
    to: 'staff-members',
  });
  assert.match(people.value.text, /"staff-members": defineCollection/);
  assert.equal(people.value.move, undefined, 'a data file stays where it is');
  assert.equal(editCollectionSchema(CONFIG, 'blog', { kind: 'renameCollection', to: 'people' }).ok, false);
});

test('changes are parsed at the boundary, and a typed collection name is made a name', () => {
  assert.equal(parseCollectionRename('Staff members'), 'staff-members');
  assert.equal(parseCollectionRename('team'), 'team');
  assert.throws(() => parseCollectionRename('!!!'));
  assert.throws(() => parseSettingsChange({ kind: 'renameField', from: 'a', to: 'a' }), /already/);
  assert.throws(() => parseSettingsChange({ kind: 'addField', name: 'x', fieldKind: 'reference' }), /collection/);
  assert.throws(() => parseSettingsChange({ kind: 'addField', name: 'x', fieldKind: 'other' }), /kind/);
  assert.throws(
    () =>
      parseSettingsChange({
        kind: 'updateField',
        update: { name: 'x', required: true, checks: { min: 5, max: 1 } },
      }),
    /larger/,
  );
  assert.throws(() => parseSettingsChange({ kind: 'reorder', order: ['a', 'a'] }), /twice/);
});

test('code that names a collection follows its renames, and only its field reads change', () => {
  const page = [
    "const posts = await getCollection('blog');",
    'const one = await getEntry("blog", id);',
    "type P = CollectionEntry<'blog'>;",
    "reference('blog');",
  ].join('\n');
  assert.equal(
    renameCollectionIn(page, 'blog', 'posts'),
    [
      "const posts = await getCollection('posts');",
      'const one = await getEntry("posts", id);',
      "type P = CollectionEntry<'posts'>;",
      "reference('posts');",
    ].join('\n'),
  );
  assert.equal(renameCollectionIn("getCollection('blogs')", 'blog', 'posts'), "getCollection('blogs')");
  assert.equal(namesCollection(page, 'blog'), true);
  assert.equal(namesCollection("type T = CollectionEntry<'blog'>", 'blog'), true);
  assert.equal(namesCollection("getCollection('team')", 'blog'), false);
  assert.equal(
    renameFieldIn('post.data.views + post.data.viewsTotal + data["views"]', 'views', 'read-count'),
    'post.data["read-count"] + post.data.viewsTotal + data["read-count"]',
  );
});

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-settings-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('a renamed field follows into every entry and the code that reads it', async () => {
  const root = project({
    'package.json': '{}',
    'src/content.config.ts': CONFIG,
    'src/content/blog/one.md': '---\ntitle: One\nviews: 3\n---\nBody\n',
    'src/content/blog/two.md': '---\ntitle: Two\n---\n',
    'src/data/people.json': '[{"id":"ada","name":"Ada"}]',
    'src/pages/index.astro': "---\nconst posts = await getCollection('blog');\n---\n" + '{posts.map((post) => post.data.views)}\n',
    'src/pages/team.astro': "---\nconst people = await getCollection('people');\n---\n" + '{people.map((p) => p.data.views)}\n',
  });
  const blog = {
    name: 'blog',
    loader: { kind: 'glob', base: './src/content/blog', pattern: '**/*.md' },
  };
  const host = {
    readConfig: async () => ({ collections: [blog] }),
    trash: async (file) => fs.rmSync(file),
  };
  const settings = await changeCollectionSettings(root, host, {
    name: 'blog',
    change: { kind: 'renameField', from: 'views', to: 'reads' },
  });
  assert.ok(settings.fields.some((field) => field.name === 'reads'));
  assert.equal(fs.readFileSync(path.join(root, 'src/content/blog/one.md'), 'utf8'), '---\ntitle: One\nreads: 3\n---\nBody\n');
  assert.equal(fs.readFileSync(path.join(root, 'src/content/blog/two.md'), 'utf8'), '---\ntitle: Two\n---\n');
  assert.match(fs.readFileSync(path.join(root, 'src/pages/index.astro'), 'utf8'), /post\.data\.reads/);
  assert.match(fs.readFileSync(path.join(root, 'src/pages/team.astro'), 'utf8'), /p\.data\.views/, 'another collection’s read stays');
  const moved = await changeCollectionSettings(root, host, {
    name: 'blog',
    change: { kind: 'renameCollection', to: 'posts' },
  });
  assert.equal(moved.name, 'posts');
  assert.ok(fs.existsSync(path.join(root, 'src/content/posts/one.md')));
  assert.equal(fs.existsSync(path.join(root, 'src/content/blog/one.md')), false);
  assert.match(fs.readFileSync(path.join(root, 'src/pages/index.astro'), 'utf8'), /getCollection\('posts'\)/);
});

test('deleting a collection unlinks it everywhere the site uses it', async () => {
  const root = project({
    'package.json': '{}',
    'src/content.config.ts': CONFIG,
    'src/content/blog/one.md': '---\ntitle: One\nauthor: ada\n---\n',
    'src/data/people.json': '[{"id":"ada","name":"Ada"}]',
    'src/pages/team.astro': "---\nconst people = await getCollection('people');\n---\n",
  });
  const blog = {
    name: 'blog',
    loader: { kind: 'glob', base: './src/content/blog', pattern: '**/*.md' },
  };
  const people = { name: 'people', loader: { kind: 'file', file: 'src/data/people.json' } };
  const trashed = [];
  const host = {
    readConfig: async () => ({ collections: [blog, people] }),
    trash: async (file) => {
      // Project-relative, with forward slashes on every platform (Windows writes backslashes).
      trashed.push(path.relative(root, file).split(path.sep).join('/'));
      fs.rmSync(file);
    },
  };
  await changeCollectionSettings(root, host, {
    name: 'people',
    change: { kind: 'deleteCollection' },
  });
  const config = fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8');
  assert.doesNotMatch(config, /people/, 'the collection and every reference to it are gone');
  assert.match(config, /title: z\.string\(\)\.min\(1\),/, 'the rest of the config stays');
  assert.deepEqual(trashed, ['src/data/people.json']);
  assert.equal(fs.readFileSync(path.join(root, 'src/content/blog/one.md'), 'utf8'), '---\ntitle: One\n---\n', 'an entry no longer names the deleted record');
  assert.match(fs.readFileSync(path.join(root, 'src/pages/team.astro'), 'utf8'), /Promise\.resolve\(\[\]\)/);
});

test('deleting a collection removes its const though its name recurs in strings and keys', () => {
  const source = [
    "const test = defineCollection({ loader: glob({ base: './src/content/test', pattern: '**/*.md' }), schema: z.object({ title: z.string() }) });",
    "const team = defineCollection({ loader: glob({ base: './src/content/team', pattern: '**/*.md' }), schema: z.object({ title: z.string() }) });",
    'export const collections = { test, staff: team };',
    '',
  ].join('\n');
  const once = editCollectionSchema(source, 'test', { kind: 'deleteCollection' });
  assert.ok(once.ok);
  assert.doesNotMatch(once.value.text, /const test/, 'a name inside the loader path is no use of the const');
  const twice = editCollectionSchema(once.value.text, 'staff', { kind: 'deleteCollection' });
  assert.ok(twice.ok);
  assert.doesNotMatch(twice.value.text, /const team/, 'a const listed under another key goes too');
  assert.match(twice.value.text, /export const collections = \{\s*\};/);
});

test('deleting a collection keeps its const while other code still uses it', () => {
  const source = [
    "const team = defineCollection({ loader: glob({ base: './src/content/team', pattern: '**/*.md' }) });",
    'export const people = team;',
    'export const collections = { team };',
    '',
  ].join('\n');
  const edit = editCollectionSchema(source, 'team', { kind: 'deleteCollection' });
  assert.ok(edit.ok);
  assert.match(edit.value.text, /const team = defineCollection/);
});

test('code reading a deleted collection is given nothing to read', () => {
  const page = [
    "const a = await getCollection('blog');",
    "const b = await getEntry('blog', id);",
    "const c = await getEntries('blog');",
    "type T = CollectionEntry<'blog'>;",
    "const d = await getCollection('blogs');",
  ].join('\n');
  assert.equal(
    unlinkCollectionIn(page, 'blog'),
    [
      'const a = await Promise.resolve([]);',
      'const b = await Promise.resolve(undefined);',
      'const c = await Promise.resolve([]);',
      'type T = any;',
      "const d = await getCollection('blogs');",
    ].join('\n'),
  );
});

test('every check a field can state is written and read back the same', () => {
  const update = (name, checks, extra = {}) => ({
    kind: 'updateField',
    update: {
      name,
      description: undefined,
      required: false,
      checks,
      options: undefined,
      defaultValue: undefined,
      ...extra,
    },
  });
  const cases = [
    ['title', { min: 2, max: 80, length: 10, pattern: '^[a-z]+$', startsWith: 'a', endsWith: 'z' }],
    ['title', { includes: '@', trim: true, letterCase: 'lower', nullable: true }],
    ['views', { min: 0, max: 99, gt: -1, lt: 100, integer: true, sign: 'nonnegative', multipleOf: 5 }],
    ['team', { min: 1, max: 3 }],
  ];
  for (const [name, checks] of cases) {
    const edit = editCollectionSchema(CONFIG, 'blog', update(name, checks));
    assert.equal(edit.ok, true, JSON.stringify(checks));
    const field = readCollectionSchema(edit.value.text, 'blog').value.fields.find((each) => each.name === name);
    assert.deepEqual(field.checks, checks, name);
    assert.equal(field.editable, true);
  }
  const dated = CONFIG.replace('    live: z.boolean().default(false),', '    live: z.boolean().default(false),\n    when: z.coerce.date(),');
  const date = editCollectionSchema(dated, 'blog', update('when', { minDate: '2020-01-01', maxDate: '2030-12-31' }));
  assert.match(date.value.text, /when: z\.coerce\.date\(\)\.min\(new Date\("2020-01-01"\)\)\.max\(new Date\("2030-12-31"\)\)/);
  assert.deepEqual(readCollectionSchema(date.value.text, 'blog').value.fields.find((each) => each.name === 'when').checks, {
    minDate: '2020-01-01',
    maxDate: '2030-12-31',
  });
  const option = editCollectionSchema(CONFIG, 'blog', update('tier', {}, { options: ['gold', 'silver'], defaultValue: 'gold' }));
  assert.match(option.value.text, /tier: z\.enum\(\["gold", "silver"\]\)\.default\("gold"\),/);
  const tier = readCollectionSchema(option.value.text, 'blog').value.fields.find((each) => each.name === 'tier');
  assert.deepEqual([tier.options, tier.defaultValue], [['gold', 'silver'], 'gold']);
});

test('an image size range is the refine Astro documents, read back as checks', () => {
  const withImage = CONFIG.replace('  schema: z.object({', '  schema: ({ image }) => z.object({\n    cover: image(),');
  const sized = editCollectionSchema(withImage, 'blog', {
    kind: 'updateField',
    update: {
      name: 'cover',
      description: undefined,
      required: true,
      checks: { minWidth: 800, maxHeight: 1600 },
      options: undefined,
      defaultValue: undefined,
    },
  });
  assert.match(sized.value.text, /cover: image\(\)\.refine\(\(image\) => image\.width >= 800 && image\.height <= 1600/);
  const cover = readCollectionSchema(sized.value.text, 'blog').value.fields[0];
  assert.deepEqual(cover.checks, { minWidth: 800, maxHeight: 1600 });
  assert.equal(cover.editable, true);
  const handRefined = withImage.replace('cover: image(),', 'cover: image().refine((img) => img.format === "png"),');
  const kept = readCollectionSchema(handRefined, 'blog').value.fields[0];
  assert.equal(kept.editable, true);
  const resized = editCollectionSchema(handRefined, 'blog', {
    kind: 'updateField',
    update: { ...kept, checks: { maxWidth: 2400 } },
  });
  assert.match(
    resized.value.text,
    /cover: image\(\)\.refine\(\(image\) => image\.width <= 2400, [^)]*\)\.refine\(\(img\) => img\.format === "png"\),/,
    'the hand-written refine stays after the size range',
  );
});

test('the newer kinds are written as their zod types and read back as themselves', () => {
  for (const [fieldKind, written] of [
    ['list', 'z.array(z.string())'],
    ['group', 'z.object({ title: z.string().optional() })'],
    ['keyValue', 'z.record(z.string(), z.string())'],
    ['constant', "z.literal('value')"],
    ['any', 'z.unknown()'],
  ]) {
    const added = editCollectionSchema(CONFIG, 'people', {
      kind: 'addField',
      name: 'extra',
      fieldKind,
      target: undefined,
      settings: newFieldSettings(fieldKind),
    });
    assert.ok(added.value.text.includes(`extra: ${written}.optional()`), fieldKind);
    const field = readCollectionSchema(added.value.text, 'people').value.fields.at(-1);
    assert.equal(field.kind, fieldKind);
  }
});

const HAND_WRITTEN = [
  "import { defineCollection, z } from 'astro:content';",
  'const MAX = 140;',
  'const titleSchema = z.string();',
  'const heading = z.string();',
  'const notes = defineCollection({',
  '  schema: z.object({',
  '    title: titleSchema,',
  '    heading,',
  "    summary: z.string().max(MAX, 'Too long').optional(),",
  "    code: z.string().regex(/^[a-z]+$/i, 'Lowercase').min(2, 'Too short'),",
  '    published: z.coerce.date().default(() => new Date()),',
  "    slug: z.string().optional().transform((value) => value ?? 'x'),",
  '  }),',
  '});',
  'export const collections = { notes };',
  '',
].join('\n');

// The field as read, with `changes` made: what the form sends when only those are edited.
function edited(source, name, changes) {
  const field = readCollectionSchema(source, 'notes').value.fields.find((each) => each.name === name);
  assert.ok(field, name);
  const update = { ...field, ...changes };
  const edit = editCollectionSchema(source, 'notes', { kind: 'updateField', update });
  assert.equal(edit.ok, true, name);
  return edit.value.text;
}

test('a field written by hand is edited in place, keeping all the form does not change', () => {
  const fields = readCollectionSchema(HAND_WRITTEN, 'notes').value.fields;
  assert.ok(
    fields.every((field) => field.editable),
    'every hand-written field is editable',
  );
  assert.equal(fields.find((field) => field.name === 'title').kind, 'other');
  for (const field of fields) {
    assert.equal(edited(HAND_WRITTEN, field.name, {}), HAND_WRITTEN, `${field.name} unchanged`);
  }
  assert.match(edited(HAND_WRITTEN, 'summary', { description: 'Short' }), /summary: z\.string\(\)\.max\(MAX, 'Too long'\)\.describe\("Short"\)\.optional\(\),/);
  const code = readCollectionSchema(HAND_WRITTEN, 'notes').value.fields.find((field) => field.name === 'code');
  assert.match(
    edited(HAND_WRITTEN, 'code', { checks: { ...code.checks, min: 3, pattern: '^[a-z0-9]+$' } }),
    /code: z\.string\(\)\.regex\(\/\^\[a-z0-9\]\+\$\/i, 'Lowercase'\)\.min\(3, 'Too short'\),/,
    'a message and the pattern’s flags stay with their checks',
  );
  assert.match(
    edited(HAND_WRITTEN, 'published', { description: 'When' }),
    /published: z\.coerce\.date\(\)\.describe\("When"\)\.default\(\(\) => new Date\(\)\),/,
    'a default the form cannot read is kept',
  );
  assert.match(
    edited(HAND_WRITTEN, 'slug', { required: true, checks: { max: 10 } }),
    /slug: z\.string\(\)\.max\(10\)\.transform\(\(value\) => value \?\? 'x'\),/,
    'a check goes in before the transform',
  );
  assert.match(edited(HAND_WRITTEN, 'title', { description: 'Heading', required: false }), /title: titleSchema\.describe\("Heading"\)\.optional\(\),/);
  assert.match(edited(HAND_WRITTEN, 'heading', { required: false }), /\n {4}heading: heading\.optional\(\),/);
  const renamed = editCollectionSchema(HAND_WRITTEN, 'notes', {
    kind: 'renameField',
    from: 'heading',
    to: 'headline',
  });
  assert.match(renamed.value.text, /\n {4}headline: heading,/, 'a shorthand keeps its constant');
});

test('a field written as a method is listed but not rewritten', () => {
  const source = HAND_WRITTEN.replace('    title: titleSchema,', '    get title() { return titleSchema; },');
  const title = readCollectionSchema(source, 'notes').value.fields.find((field) => field.name === 'title');
  assert.equal(title.editable, false);
  const refused = editCollectionSchema(source, 'notes', {
    kind: 'updateField',
    update: { ...title, required: true },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /written as a method/);
});

test('a new field is written with its settings in one change', () => {
  const added = editCollectionSchema(CONFIG, 'people', {
    kind: 'addField',
    name: 'body',
    fieldKind: 'richText',
    target: undefined,
    settings: {
      description: 'The post',
      required: true,
      checks: { max: 5000 },
      options: undefined,
      defaultValue: undefined,
    },
  });
  assert.equal(added.ok, true);
  assert.match(added.value.text, /body: z\.string\(\)\.max\(5000\)\.describe\("The post"\) \}/);
  const body = readCollectionSchema(added.value.text, 'people').value.fields.at(-1);
  assert.deepEqual([body.required, body.checks, body.description], [true, { max: 5000 }, 'The post']);
  const option = settledFieldText('option', '', {
    ...newFieldSettings('option'),
    options: ['Draft', 'Live'],
    defaultValue: 'Draft',
  });
  assert.equal(option, 'z.enum(["Draft", "Live"]).default("Draft")');
  assert.throws(() => parseSettingsChange({ kind: 'addField', name: 'x', fieldKind: 'text' }), /Expected object/, 'a new field says its settings');
});

test('every new kind’s plain schema reads back as the settings its form starts from', () => {
  const kinds = ['text', 'richText', 'image', 'multiImage', 'videoLink', 'link', 'email'];
  kinds.push('phone', 'number', 'date', 'switch', 'color', 'option', 'file', 'reference');
  kinds.push('multiReference', 'list', 'group', 'keyValue', 'constant', 'any');
  for (const kind of kinds) {
    assert.equal(settledFieldText(kind, 'team', newFieldSettings(kind)), newFieldText(kind, 'team'), kind);
  }
});
