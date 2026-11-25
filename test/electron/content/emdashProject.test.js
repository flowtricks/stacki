// Goal: Stacki finds out that a project uses EmDash, and reads its content types and entries from EmDash itself,
// without ever changing the project or its database. Detection follows what EmDash documents (the `emdash`
// package, `emdash()` from `emdash/astro` in the Astro config, the `_emdash` live collection); the content types
// come from the local database when there is one, else EmDash's own schema export, else a seed file.
// Method: a copy of test/fixtures/emdash/site (laid out as the Astro and EmDash docs show) in a temporary folder;
// a real SQLite file with EmDash's registry tables and an `ec_posts` content table is created there with Node's
// own sqlite, then read through the same functions the IPC handlers call. Each valid shape and each broken one:
// a missing integration, static output, an unignored database, a database that is not SQLite, a config path that
// climbs out of the project. The database's bytes are hashed before and after every read to prove it is read-only.
const test = require('node:test');
const { repoPath } = require('../../helpers/sources.js');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { detectEmDash, emDashEntries } = require('#dist/electron/content/emdashProject.js');
const { emDashPageEntries, emDashCollectionOfPage, emDashRouteParam } = require('#dist/electron/content/emdashPaths.js');

const FIXTURE = repoPath('test/fixtures/emdash/site');

function copyFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-emdash-')));
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

// The tables EmDash's migrations create (003 schema registry, 020 url pattern) and a content table in its layout.
function createDatabase(root, file = 'data.db') {
  const database = new DatabaseSync(path.join(root, file));
  database.exec(`
    CREATE TABLE _emdash_collections (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL, label_singular TEXT, description TEXT, icon TEXT, supports TEXT, source TEXT, url_pattern TEXT);
    CREATE TABLE _emdash_fields (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, slug TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL, column_type TEXT NOT NULL, required INTEGER DEFAULT 0, validation TEXT, sort_order INTEGER DEFAULT 0);
    CREATE TABLE ec_posts (id TEXT PRIMARY KEY, slug TEXT, status TEXT, created_at TEXT, deleted_at TEXT, title TEXT);
    INSERT INTO _emdash_collections (id, slug, label, label_singular, url_pattern) VALUES ('c1', 'posts', 'Posts', 'Post', '/posts/{slug}');
    INSERT INTO _emdash_fields (id, collection_id, slug, label, type, column_type, required, validation, sort_order) VALUES
      ('f1', 'c1', 'title', 'Title', 'string', 'TEXT', 1, NULL, 0),
      ('f2', 'c1', 'body', 'Body', 'portableText', 'JSON', 0, NULL, 1),
      ('f3', 'c1', 'tone', 'Tone', 'select', 'TEXT', 0, '{"options":["plain","bold"]}', 2);
    INSERT INTO ec_posts VALUES
      ('p1', 'first-post', 'published', '2026-01-01', NULL, 'First post'),
      ('p2', 'newest-post', 'published', '2026-03-01', NULL, 'Newest post'),
      ('p3', 'a-draft', 'draft', '2026-04-01', NULL, 'A draft'),
      ('p4', 'gone', 'published', '2026-05-01', '2026-05-02', 'Deleted'),
      ('p5', 'untitled', 'published', '2026-02-01', NULL, NULL);
  `);
  database.close();
}

const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('a project without EmDash is absent, whatever else it uses', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-plain-')));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { astro: '^6.0.0', '@sanity/client': '^7.0.0' } }));
  fs.writeFileSync(path.join(root, 'astro.config.mjs'), "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n");
  assert.deepEqual(await detectEmDash(root), { kind: 'absent' });
});

test('the documented setup is detected, with its content types read from EmDash’s schema export', async () => {
  const project = await detectEmDash(copyFixture());
  assert.equal(project.kind, 'present');
  assert.equal(project.configFile, 'astro.config.mjs');
  assert.equal(project.output, 'server');
  assert.equal(project.schemaSource, 'schema-json');
  assert.deepEqual(project.problems, ['noDatabase'], 'only the missing local database is worth saying');
  assert.deepEqual(
    project.collections.map((collection) => collection.slug),
    ['posts', 'case_studies'],
  );
  const posts = project.collections[0];
  assert.equal(posts.labelSingular, 'Post');
  const byslug = Object.fromEntries(posts.fields.map((field) => [field.slug, field]));
  assert.equal(byslug.title.binding, 'text');
  assert.equal(byslug.title.required, true);
  assert.equal(byslug.featured_image.binding, 'image');
  assert.equal(byslug.content.binding, 'richText');
  assert.equal(byslug.source_url.binding, 'link');
  assert.equal(byslug.reading_minutes.binding, 'number');
  assert.equal(byslug.published_on.binding, 'date');
  assert.equal(byslug.gallery.binding, 'list');
  assert.deepEqual(byslug.category.options, ['news', 'guide']);
  assert.equal(byslug.layout_hint.type, 'unsupported', 'a type this version does not know is listed, not bound');
  assert.equal(byslug.layout_hint.binding, 'data');
  assert.equal(project.collections[1].urlPattern, '/work/{slug}');
});

test('content types are read from the local database when there is one, and the database is never changed', async () => {
  const root = copyFixture();
  createDatabase(root);
  const file = path.join(root, 'data.db');
  const before = hashOf(file);
  const project = await detectEmDash(root);
  assert.equal(project.schemaSource, 'database');
  assert.equal(project.databaseFile, 'data.db');
  assert.deepEqual(project.problems, []);
  assert.deepEqual(
    project.collections.map((collection) => collection.slug),
    ['posts'],
    'the database, not the exported schema, says what the site has',
  );
  assert.deepEqual(
    project.collections[0].fields.map((field) => [field.slug, field.binding]),
    [
      ['title', 'text'],
      ['body', 'richText'],
      ['tone', 'text'],
    ],
  );
  assert.deepEqual(project.collections[0].fields[2].options, ['plain', 'bold']);
  assert.equal(project.collections[0].urlPattern, '/posts/{slug}');
  await emDashEntries(root, 'posts');
  assert.equal(hashOf(file), before, 'reading left the database byte for byte as it was');
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.endsWith('-wal') || name.endsWith('-journal')),
    [],
    'no journal file was created',
  );
});

test('entries are the published ones, newest first, named by the title field, never drafts or deleted ones', async () => {
  const root = copyFixture();
  createDatabase(root);
  assert.deepEqual(await emDashEntries(root, 'posts'), [
    { slug: 'newest-post', title: 'Newest post' },
    { slug: 'untitled', title: 'untitled' },
    { slug: 'first-post', title: 'First post' },
  ]);
});

test('a collection the schema does not list reads nothing, and a name that is not a slug is refused before any SQL', async () => {
  const root = copyFixture();
  createDatabase(root);
  assert.deepEqual(await emDashEntries(root, 'case_studies'), [], 'listed in the export but absent from the database that now wins');
  await assert.rejects(() => emDashEntries(root, 'posts; DROP TABLE ec_posts'), /collection slug/);
  await assert.rejects(() => emDashEntries(root, "x' OR '1'='1"), /collection slug/);
});

test('a file that is not an EmDash database is passed over for the schema export', async () => {
  const root = copyFixture();
  fs.writeFileSync(path.join(root, 'data.db'), 'this is not sqlite');
  const project = await detectEmDash(root);
  assert.equal(project.schemaSource, 'schema-json');
  assert.ok(project.problems.includes('noDatabase'));
});

test('a database path in the config that climbs out of the project is not opened', async () => {
  const root = copyFixture();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-outside-')));
  createDatabase(outside);
  const config = path.join(root, 'astro.config.mjs');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('file:./data.db', `file:../${path.basename(outside)}/data.db`));
  const project = await detectEmDash(root);
  assert.equal(project.databaseFile, undefined);
  assert.equal(project.schemaSource, 'schema-json');
});

test('a half-finished setup says what is missing', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-half-')));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { astro: '^6.0.0', emdash: '^1.5.0' } }));
  fs.writeFileSync(path.join(root, 'astro.config.mjs'), "import { defineConfig } from 'astro/config';\nexport default defineConfig({ output: 'static' });\n");
  const project = await detectEmDash(root);
  assert.equal(project.kind, 'present');
  assert.equal(project.output, 'static');
  assert.deepEqual(project.problems, ['noIntegration', 'noLiveCollection', 'staticOutput', 'noDatabase', 'noSchema']);
  assert.deepEqual(project.collections, []);
});

test('a database or uploads folder that git would track is flagged, so a deploy cannot carry it', async () => {
  const root = copyFixture();
  createDatabase(root);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  const project = await detectEmDash(root);
  assert.deepEqual(project.problems, ['databaseTracked', 'uploadsTracked']);
  fs.writeFileSync(path.join(root, '.gitignore'), '*.db\n/uploads\n');
  assert.deepEqual((await detectEmDash(root)).problems, []);
});

test('a broken schema file is reported rather than read as an empty site', async () => {
  const root = copyFixture();
  fs.writeFileSync(path.join(root, '.emdash', 'schema.json'), JSON.stringify({ unrelated: true }));
  fs.rmSync(path.join(root, 'package.json'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { emdash: '^1.5.0' } }));
  const project = await detectEmDash(root);
  assert.deepEqual(project.collections, []);
  assert.ok(project.problems.includes('schemaUnreadable'));
});

test('a seed file declares content types when nothing richer exists', async () => {
  const root = copyFixture();
  fs.rmSync(path.join(root, '.emdash', 'schema.json'));
  fs.mkdirSync(path.join(root, 'seed'));
  fs.writeFileSync(
    path.join(root, 'seed', 'seed.json'),
    JSON.stringify({ version: '1', collections: [{ slug: 'pages', label: 'Pages', fields: [{ slug: 'title', label: 'Title', type: 'string' }] }] }),
  );
  const project = await detectEmDash(root);
  assert.equal(project.schemaSource, 'seed');
  assert.deepEqual(
    project.collections.map((collection) => collection.slug),
    ['pages'],
  );
});

test('a dynamic EmDash route previews the entries EmDash holds', async () => {
  const root = copyFixture();
  createDatabase(root);
  const page = path.join(root, 'src', 'pages', 'posts', '[slug].astro');
  assert.equal(emDashRouteParam('/posts/[slug]'), 'slug');
  assert.equal(emDashRouteParam('/docs/[...slug]'), 'slug');
  assert.equal(emDashRouteParam('/[a]/[b]'), undefined, 'two placeholders have no single entry field');
  assert.equal(emDashRouteParam('/about'), undefined);
  assert.equal(emDashCollectionOfPage(fs.readFileSync(page, 'utf8')), 'posts');
  assert.equal(emDashCollectionOfPage("const x = await getCollection('blog');"), undefined);
  const entries = await emDashPageEntries(root, page, '/posts/[slug]');
  assert.deepEqual(entries[0], { params: { slug: 'newest-post' }, label: 'Newest post' });
  assert.equal(entries.length, 3);
  assert.deepEqual(await emDashPageEntries(root, path.join(root, 'src', 'pages', 'blog.astro'), '/blog'), [], 'a page with no placeholder has no entries');
  assert.deepEqual(await emDashPageEntries(root, path.join(root, 'missing.astro'), '/x/[slug]'), []);
});
