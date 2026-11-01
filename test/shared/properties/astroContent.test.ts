// Goal: what the CMS panel asks of a project's content collections is parsed at the
// boundary — each read and edit names only what it may, and a typed collection name becomes
// an identifier Astro accepts, or is refused with a reason.
// Method: one known-good request per operation, then each known-bad operation, id, write and
// name; the name parser is fed typed labels, edge lengths and reserved words.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASTRO_CONTENT_ID,
  ASTRO_CONTENT_LIMITS,
  ASTRO_CONTENT_SOURCE,
  isAstroContent,
  parseAstroCollectionName,
  parseAstroRemoteEdit,
  parseAstroRemoteRead,
} from '#dist/shared/properties/astroContent.js';
import { parseConnectionId } from '#dist/shared/properties/cmsConnections.js';
import {
  parseRemoteColumns,
  parseRemoteDocument,
  remoteCell,
} from '#dist/shared/properties/cmsRemote.js';
import { parseRemoteType } from '#dist/shared/properties/cmsRemoteSchema.js';

test('the content source has an id every connection parser accepts', () => {
  assert.equal(parseConnectionId(ASTRO_CONTENT_ID), ASTRO_CONTENT_ID);
  assert.equal(isAstroContent(ASTRO_CONTENT_SOURCE), true);
  const sanity = {
    kind: 'sanity',
    id: '00000000-0000-4000-8000-000000000001',
    label: 'x',
    projectId: 'p',
    dataset: 'd',
  } as const;
  assert.equal(isAstroContent(sanity), false);
  assert.throws(
    () => isAstroContent({ ...sanity, id: ASTRO_CONTENT_ID }),
    /No saved connection takes/,
  );
});

test('reads name a collection or an entry, and nothing else', () => {
  assert.deepEqual(parseAstroRemoteRead({ operation: 'collections' }), {
    operation: 'collections',
  });
  assert.deepEqual(parseAstroRemoteRead({ operation: 'documents', collection: 'blog' }), {
    operation: 'documents',
    collection: 'blog',
    columns: [],
  });
  assert.deepEqual(
    parseAstroRemoteRead({ operation: 'documents', collection: 'blog', columns: ['author'] })
      .operation,
    'documents',
  );
  assert.throws(() =>
    parseAstroRemoteRead({ operation: 'documents', collection: 'blog', columns: ['_id'] }),
  );
  assert.deepEqual(parseAstroRemoteRead({ operation: 'document', id: 'blog.0123456789abcdef' }), {
    operation: 'document',
    id: 'blog.0123456789abcdef',
  });
  assert.throws(() => parseAstroRemoteRead({ operation: 'history', id: 'a' }), /Unknown/);
  assert.throws(() => parseAstroRemoteRead({ operation: 'documents', collection: '../x' }));
  assert.throws(() => parseAstroRemoteRead({ operation: 'document', id: 'drafts.a' }));
  assert.throws(() => parseAstroRemoteRead('collections'));
});

test('edits write one field, make or remove entries, or add a collection', () => {
  const write = { id: 'blog.0123456789abcdef', field: 'title', value: 'Hello' };
  assert.deepEqual(parseAstroRemoteEdit({ operation: 'write', write }), {
    operation: 'write',
    write,
  });
  assert.deepEqual(parseAstroRemoteEdit({ operation: 'create', collection: 'blog' }), {
    operation: 'create',
    collection: 'blog',
  });
  assert.deepEqual(parseAstroRemoteEdit({ operation: 'delete', ids: ['blog.a', 'blog.b'] }), {
    operation: 'delete',
    ids: ['blog.a', 'blog.b'],
  });
  assert.deepEqual(parseAstroRemoteEdit({ operation: 'createCollection', name: 'Blog posts' }), {
    operation: 'createCollection',
    name: 'blogPosts',
  });
  assert.throws(() => parseAstroRemoteEdit({ operation: 'publish', id: 'a' }), /Unknown/);
  assert.throws(() =>
    parseAstroRemoteEdit({ operation: 'write', write: { ...write, field: '_id' } }),
  );
  assert.throws(() => parseAstroRemoteEdit({ operation: 'delete', ids: [] }), /at least one/);
  assert.throws(() => parseAstroRemoteEdit({ operation: 'delete', ids: ['a', 'a'] }), /twice/);
});

test('a typed collection name becomes a camel-case identifier', () => {
  assert.equal(parseAstroCollectionName('Blog posts'), 'blogPosts');
  assert.equal(parseAstroCollectionName('  team '), 'team');
  assert.equal(parseAstroCollectionName('FAQ — answers!'), 'fAQAnswers');
  assert.equal(parseAstroCollectionName('sermon-speakers_2'), 'sermonSpeakers2');
  assert.equal(
    parseAstroCollectionName('a'.repeat(ASTRO_CONTENT_LIMITS.collectionNameCharsMax)).length,
    64,
  );
});

test('a collection name that leaves nothing usable is refused with its reason', () => {
  assert.throws(() => parseAstroCollectionName(''), /Name the collection/);
  assert.throws(() => parseAstroCollectionName('   '), /Name the collection/);
  assert.throws(() => parseAstroCollectionName('!!!'), /starts with a letter/);
  assert.throws(() => parseAstroCollectionName('2024 posts'), /starts with a letter/);
  assert.throws(() => parseAstroCollectionName('a'.repeat(65)), /at most 64/);
  assert.throws(() => parseAstroCollectionName('b'.repeat(81)), /at most 80/);
  assert.throws(() => parseAstroCollectionName('class'), /reserved/);
  assert.throws(() => parseAstroCollectionName('Collections'), /reserved/);
  assert.throws(() => parseAstroCollectionName(42), /Expected string/);
});

test('an image path is a string field marked as one, and a document may name its file', () => {
  assert.deepEqual(parseRemoteType({ kind: 'string', options: [], asset: 'image' }), {
    kind: 'string',
    options: [],
    asset: 'image',
  });
  assert.throws(() => parseRemoteType({ kind: 'number', options: [], asset: 'image' }), /asset/);
  assert.throws(() => parseRemoteType({ kind: 'string', options: [], asset: 'video' }), /asset/);
  const document = {
    id: 'blog.0123456789abcdef',
    type: 'blog',
    status: 'published',
    fields: [],
    assets: [],
  };
  assert.equal(parseRemoteDocument(document).file, undefined);
  assert.equal(
    parseRemoteDocument({ ...document, file: 'src/content/a.md' }).file,
    'src/content/a.md',
  );
  for (const file of ['', '/etc/passwd', '../outside.md', 'src//a.md', 'src\\a.md']) {
    assert.throws(() => parseRemoteDocument({ ...document, file }), /document file/, file);
  }
});

test('a write may name an exported field that starts with a digit or holds dashes', () => {
  const write = { id: 'logos.0123456789abcdef', field: '1-logo-svg', value: '../a.svg' };
  assert.deepEqual(parseAstroRemoteEdit({ operation: 'write', write }).operation, 'write');
  const system = { ...write, field: '_id' };
  assert.throws(() => parseAstroRemoteEdit({ operation: 'write', write: system }), /field name/);
});

test('a list asks for a few named columns, and each comes back as a short cell', () => {
  assert.deepEqual(parseRemoteColumns(['author', 'sort-order']), ['author', 'sort-order']);
  assert.throws(() => parseRemoteColumns(['a', 'a']), /twice/);
  assert.throws(() => parseRemoteColumns(['_id']), /field name/);
  assert.throws(
    () => parseRemoteColumns(Array.from({ length: 13 }, (_, i) => `f${i}`)),
    /Too many/,
  );
  assert.equal(remoteCell('Ada'), 'Ada');
  assert.equal(remoteCell(3), 3);
  assert.equal(remoteCell(false), false);
  assert.equal(remoteCell({ _type: 'slug', current: 'ada' }), 'ada');
  assert.equal(remoteCell(['Main', { title: 'North' }]), 'Main, North');
  assert.equal(remoteCell({ asset: { _ref: 'image-1' } }), undefined, 'an image has no line');
  assert.equal(remoteCell(Number.NaN), undefined);
  assert.equal(String(remoteCell('x'.repeat(500))).length, 200, 'a long text is cut');
});
