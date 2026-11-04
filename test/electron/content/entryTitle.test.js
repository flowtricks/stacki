// Goal: an Astro entry is named in the CMS panel by a name field when it has one, else by
// its first short text field in schema order, else by its id, and only then "untitled";
// the name is bounded, and Sanity's list query reads the same name fields it always did.
// Method: entryTitleOf is called on records shaped like real collections (the pigeon
// project's stats cards among them) with schema field orders from titleFieldsOf, and on
// records with nothing usable; listEntries is run on a temporary glob collection to see the
// name reach the list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { entryTitleOf, titleFieldsOf, NO_TITLE_FIELDS, ENTRY_TITLE_CHARS_MAX } = require('#dist/shared/properties/entryTitle.js');
const { listEntries } = require('#dist/electron/content/contentEntries.js');
const { previewProjection } = require('#dist/electron/content/sanityPreview.js');

const STATS_SCHEMA = {
  type: 'object',
  properties: { Number: { type: 'string' }, Header: { type: 'string' }, Description: { type: 'string' } },
  required: ['Number', 'Header', 'Description'],
};

const title = (data, id, schema) => entryTitleOf(data, { id, fields: schema === undefined ? NO_TITLE_FIELDS : titleFieldsOf(schema) });

test('a name field names the entry, ahead of earlier fields', () => {
  assert.equal(title({ date: '2024-01-01', title: '  Launch notes ' }, 'launch'), 'Launch notes');
  assert.equal(title({ Number: '1', name: 'Ada' }, 'ada'), 'Ada');
  assert.equal(title({ heading: 'Plans', label: 'Ignored' }, 'plans'), 'Plans');
  assert.equal(title({ header: 'Header field' }, 'x'), 'Header field');
});

test('with no name field, the first text field in schema order names it (the stats card)', () => {
  assert.equal(title({ Number: '61.4%', Header: 'Uptime', Description: 'weather permitting' }, 'untitled', STATS_SCHEMA), '61.4%');
  assert.equal(title({ Number: '43%', Header: 'Messages that arrive dry' }, 'untitled-2', STATS_SCHEMA), '43%');
  // Schema order wins over the order the file wrote the keys in.
  assert.equal(title({ Description: 'later', Header: 'Uptime', Number: '61.4%' }, 'untitled', STATS_SCHEMA), '61.4%');
});

test('an empty, object, list, image or multi-line first field passes to the next text field', () => {
  const schema = {
    properties: {
      cover: { astroImage: true, type: 'string' },
      author: { anyOf: [{ astroReference: 'authors', type: 'string' }, { type: 'null' }] },
      blank: { type: 'string' },
      meta: { type: 'object' },
      tags: { type: 'array' },
      body: { type: 'string' },
      caption: { type: 'string' },
    },
  };
  const data = { cover: './cover.jpg', author: 'ada', blank: '   ', meta: { a: 1 }, tags: ['x'], body: 'line one\nline two', caption: 'Morning' };
  assert.equal(title(data, 'post', schema), 'Morning');
  // A picture's path is skipped without a schema to mark it, too.
  assert.equal(title({ photo: 'images/bird.webp', caption: 'Pigeon' }, 'p'), 'Pigeon');
});

test('a number names the entry as written', () => {
  assert.equal(title({ count: 42, label: '' }, 'n'), '42');
  assert.equal(title({ ratio: 0.5 }, 'n'), '0.5');
  assert.equal(title({ ratio: Number.NaN, word: 'ok' }, 'n'), 'ok');
});

test('with nothing usable, the id names it, and only then "untitled"', () => {
  assert.equal(title({ meta: {}, tags: [], blank: '' }, 'my-entry', STATS_SCHEMA), 'my-entry');
  assert.equal(title(undefined, 'loose'), 'loose');
  assert.equal(title({}, ''), 'untitled');
  assert.equal(title({ blank: ' ' }, '   '), 'untitled');
});

test('a name is cut to the display bound, and over-long text is not taken as a name', () => {
  const long = 'x'.repeat(ENTRY_TITLE_CHARS_MAX + 50);
  assert.equal(title({ title: long }, 'a').length, ENTRY_TITLE_CHARS_MAX);
  assert.equal(title({ essay: long, short: 'Short' }, 'a'), 'Short');
});

test('a schema with no properties reads as no declared fields', () => {
  assert.deepEqual(titleFieldsOf(undefined), { order: [], skipped: [] });
  assert.deepEqual(titleFieldsOf({ type: 'string' }), { order: [], skipped: [] });
  assert.deepEqual(titleFieldsOf(STATS_SCHEMA).order, ['Number', 'Header', 'Description']);
});

test('Sanity rows are still titled by title, name, heading, label, then slug', () => {
  assert.match(previewProjection(undefined), /"title": coalesce\(title, name, heading, label, slug\.current, _id\)/);
});

test('a glob collection lists its entries by the derived name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-entry-title-'));
  try {
    const base = path.join(root, 'src', 'content', 'stats');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'untitled.md'), '---\nNumber: 61.4%\nHeader: Uptime\nDescription: weather permitting\n---\n');
    fs.writeFileSync(path.join(base, 'untitled-2.md'), '---\nNumber: 43%\nHeader: Messages that arrive dry\n---\n');
    const collection = { name: 'stats', loader: { kind: 'glob', base: './src/content/stats', pattern: '**/*.{md,mdx}' }, schema: STATS_SCHEMA };
    const listed = listEntries(root, collection).entries.map((entry) => [entry.id, entry.title]);
    assert.deepEqual(listed, [
      ['untitled-2', '43%'],
      ['untitled', '61.4%'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
