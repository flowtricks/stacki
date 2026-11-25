// Goal: an Astro entry's Slug field renames its id safely — a glob entry's file moves within
// its folder, keeping its extension; a data file's keyed or `id` record is renamed in place;
// every reference() field and getEntry() call that named the old id names the new one; a slug
// another entry holds is refused; and an id built by a loader's code is shown, not renamed.
// Method: the content service runs against a temporary project with its config injected (as
// astroContent.test.js does), each rename is made through the service, and the files on disk
// are read back. The code rewrite is also fed source text directly, quoted every way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { astroRemoteService, documentId } = require('#dist/electron/content/astroRemoteService.js');
const { renameEntryIn } = require('#dist/electron/content/astroCollectionSettings.js');
const { parseRemoteDocument } = require('#dist/shared/properties/cmsRemote.js');

const STATS = {
  name: 'stats',
  editable: true,
  loader: { kind: 'glob', base: './src/content/stats', pattern: '**/*.md' },
  schema: {
    type: 'object',
    properties: { Number: { type: 'string' }, Header: { type: 'string' }, Description: { type: 'string' } },
    required: ['Number', 'Header', 'Description'],
  },
};
const CARDS = {
  name: 'cards',
  editable: true,
  loader: { kind: 'glob', base: './src/content/cards', pattern: '**/*.md' },
  schema: {
    type: 'object',
    properties: { title: { type: 'string' }, stat: { type: 'string', astroReference: 'stats' } },
    required: ['title'],
  },
};
const PEOPLE = { name: 'people', editable: true, loader: { kind: 'file', file: 'src/data/people.json' } };
const TEAMS = { name: 'teams', editable: true, loader: { kind: 'file', file: 'src/data/teams.json' } };
const GENERATED = {
  name: 'generated',
  editable: true,
  loader: { kind: 'glob', base: './src/content/generated', pattern: '**/*.md', generateId: '[Function]' },
};

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-entry-rename-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function service(root, collections) {
  return astroRemoteService(root, { readConfig: async () => ({ collections }), trash: async (file) => fs.rmSync(file) });
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('a glob entry’s slug renames its file, its references and the code that fetches it', async () => {
  const root = project({
    'src/content/stats/untitled.md': '---\nNumber: 61.4%\nHeader: Uptime\nDescription: weather permitting\n---\n',
    'src/content/stats/untitled-2.md': '---\nNumber: 43%\nHeader: Dry\nDescription: mostly\n---\n',
    'src/content/cards/home.md': '---\ntitle: Home\nstat: untitled\n---\n',
    'src/pages/index.astro': '---\nconst stat = await getEntry(\'stats\', \'untitled\');\nconst other = await getEntry("stats", "untitled-2");\n---\n',
  });
  try {
    const content = service(root, [STATS, CARDS]);
    const before = parseRemoteDocument(await content.document(documentId('stats', 'untitled')));
    assert.deepEqual(before.slug, { folder: '', value: 'untitled', taken: ['untitled-2'], rename: { kind: 'editable' } });
    const after = parseRemoteDocument(await content.rename(documentId('stats', 'untitled'), '61-4'));
    assert.equal(after.id, documentId('stats', '61-4'));
    assert.equal(after.slug?.value, '61-4');
    assert.equal(fs.existsSync(path.join(root, 'src/content/stats/untitled.md')), false, 'the old file is gone');
    assert.match(read(root, 'src/content/stats/61-4.md'), /Number: 61\.4%/, 'the file moved whole, extension kept');
    assert.match(read(root, 'src/content/cards/home.md'), /stat: 61-4/, 'the reference names the new id');
    const page = read(root, 'src/pages/index.astro');
    assert.match(page, /getEntry\('stats', '61-4'\)/);
    assert.match(page, /getEntry\("stats", "untitled-2"\)/, 'another entry’s call is left alone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a slug another entry already holds is refused, and nothing moves', async () => {
  const root = project({
    'src/content/stats/untitled.md': '---\nNumber: 1\n---\n',
    'src/content/stats/untitled-2.md': '---\nNumber: 2\n---\n',
  });
  try {
    const content = service(root, [STATS]);
    await assert.rejects(content.rename(documentId('stats', 'untitled'), 'untitled-2'), /already has an entry/);
    assert.equal(read(root, 'src/content/stats/untitled.md'), '---\nNumber: 1\n---\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a nested entry keeps its folder; renaming to its own slug changes nothing', async () => {
  const root = project({ 'src/content/stats/2024/q1.md': '---\nNumber: 1\n---\n', 'src/content/stats/q2.md': '---\nNumber: 2\n---\n' });
  try {
    const content = service(root, [STATS]);
    const nested = parseRemoteDocument(await content.document(documentId('stats', '2024/q1')));
    assert.deepEqual(nested.slug, { folder: '2024/', value: 'q1', taken: [], rename: { kind: 'editable' } }, 'q2 is in another folder');
    const same = parseRemoteDocument(await content.rename(documentId('stats', '2024/q1'), 'q1'));
    assert.equal(same.id, documentId('stats', '2024/q1'));
    await content.rename(documentId('stats', '2024/q1'), 'q2');
    assert.ok(fs.existsSync(path.join(root, 'src/content/stats/2024/q2.md')), 'the file stays in its folder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a data file’s `id` record and keyed record are renamed in place', async () => {
  const root = project({
    'src/data/people.json': '[{"id":"ada","name":"Ada"},{"id":"alan","name":"Alan"}]\n',
    'src/data/teams.json': '{"core":{"name":"Core"},"web":{"name":"Web"}}\n',
  });
  try {
    const content = service(root, [PEOPLE, TEAMS]);
    const ada = parseRemoteDocument(await content.document(documentId('people', 'ada')));
    assert.deepEqual(ada.slug?.taken, ['alan']);
    await content.rename(documentId('people', 'ada'), 'ada-lovelace');
    assert.deepEqual(
      JSON.parse(read(root, 'src/data/people.json')).map((person) => person.id),
      ['ada-lovelace', 'alan'],
    );
    await content.rename(documentId('teams', 'core'), 'platform');
    assert.deepEqual(Object.keys(JSON.parse(read(root, 'src/data/teams.json'))), ['platform', 'web']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an id the loader builds in code is shown read-only, with why, and refused', async () => {
  const root = project({ 'src/content/generated/one.md': '---\ntitle: One\n---\n' });
  try {
    const content = service(root, [GENERATED]);
    const one = parseRemoteDocument(await content.document(documentId('generated', 'one')));
    assert.equal(one.slug?.rename.kind, 'locked');
    assert.match(one.slug?.rename.kind === 'locked' ? one.slug.rename.reason : '', /builds its ids in its loader/);
    const template = parseRemoteDocument(await content.template('generated'));
    assert.equal(template.slug?.rename.kind, 'locked', 'a new entry cannot be given one either');
    await assert.rejects(content.rename(documentId('generated', 'one'), 'two'), /builds its ids/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new entry’s template carries every root slug as taken', async () => {
  const root = project({ 'src/content/stats/untitled.md': '---\nNumber: 1\n---\n', 'src/content/stats/a/b.md': '---\nNumber: 2\n---\n' });
  try {
    const template = parseRemoteDocument(await service(root, [STATS]).template('stats'));
    assert.deepEqual(template.slug, { folder: '', value: '', taken: ['untitled'], rename: { kind: 'editable' } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('code naming the old id is rewritten whichever quotes and call it uses', () => {
  const rename = { collection: 'stats', from: 'untitled', to: '61-4' };
  const source = [
    "getEntry('stats', 'untitled')",
    'getEntry("stats","untitled")',
    'getEntry(`stats`, `untitled`)',
    "getEntry({ collection: 'stats', id: 'untitled' })",
    "getEntries([{ collection: 'stats', id: 'untitled' }])",
    "getEntry('other', 'untitled')",
    "getEntry('stats', 'untitled-2')",
  ].join('\n');
  assert.deepEqual(renameEntryIn(source, rename).split('\n'), [
    "getEntry('stats', '61-4')",
    'getEntry("stats","61-4")',
    'getEntry(`stats`, `61-4`)',
    "getEntry({ collection: 'stats', id: '61-4' })",
    "getEntries([{ collection: 'stats', id: '61-4' }])",
    "getEntry('other', 'untitled')",
    "getEntry('stats', 'untitled-2')",
  ]);
  assert.throws(() => renameEntryIn(source, { ...rename, to: '' }), /names the id it makes/);
});
