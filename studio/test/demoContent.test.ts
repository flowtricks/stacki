// Goal: the demo's Collections panel reads what Studio's handlers answered at bake time,
// an edit is written through the same format modules the server uses, reads back at
// once, and lands on the page only where the field shows as written. What needs the
// project's own code (renames, new entries, zod validation) answers plainly.
// Method: a small snapshot shaped like a real bake's, in-memory files standing in for
// the rooms, and the operations the panel sends, positive and negative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SnapshotContent } from '../src/features/bake/bakeSnapshot';
import { CONTENT_ROUTE_REASONS, contentOperation, type ContentFiles } from '../demo/contentRoutes';
import { contentChanges } from '../demo/contentPatch';

const FILE = 'src/content/notes/first.md';
const BAKED = '---\ntitle: First note\nsummary: A short summary # kept\n---\nThe body.\n';
const ID = 'notes.0123456789abcdef';

const CONTENT: SnapshotContent = {
  collections: { collections: [{ name: 'notes', count: 1 }] },
  entries: {
    notes: {
      collection: { name: 'notes', schema: { type: 'object', properties: { title: { type: 'string' } } } },
      entries: [{ id: 'first', file: FILE, locator: [], data: { title: 'First note', summary: 'A short summary' }, title: 'First note' }],
    },
  },
  fields: [
    { file: FILE, locator: [], field: 'title', pages: ['src/pages/index.astro'] },
    { file: FILE, locator: [], field: 'summary', pages: [] },
  ],
  remote: {
    collections: { ok: true, value: [{ name: 'notes', count: 1 }] },
    documents: { notes: { ok: true, value: { documents: [{ id: ID, title: 'First note', subtitle: 'first' }] } } },
    templates: { notes: { ok: true, value: { id: 'new-item', fields: [] } } },
    settings: { notes: { ok: true, value: { name: 'notes' } } },
    document: {
      [ID]: {
        ok: true,
        value: {
          id: ID,
          fields: [
            { name: 'title', value: 'First note' },
            { name: 'summary', value: 'A short summary' },
            { name: 'body', value: 'The body.\n' },
          ],
        },
      },
    },
    files: { [ID]: { file: FILE, locator: [], collection: 'notes' } },
  },
};

function files(): ContentFiles & { readonly texts: Map<string, string> } {
  const texts = new Map([[FILE, BAKED]]);
  return { texts, read: (file) => texts.get(file), baked: (file) => (file === FILE ? BAKED : undefined), write: (file, text) => texts.set(file, text) };
}

function value(result: unknown): Readonly<Record<string, unknown>> {
  assert.ok(typeof result === 'object' && result !== null && 'ok' in result && result.ok === true && 'value' in result);
  const inner = result.value;
  assert.ok(typeof inner === 'object' && inner !== null);
  return Object.fromEntries(Object.entries(inner));
}

test('the panel reads the collections, a list and a document as the bake answered', () => {
  const store = files();
  assert.deepEqual(contentOperation(CONTENT, 'content:remoteRead', { request: { operation: 'collections' } }, store), {
    ok: true,
    value: [{ name: 'notes', count: 1 }],
  });
  assert.deepEqual(value(contentOperation(CONTENT, 'content:remoteRead', { request: { operation: 'documents', collection: 'notes' } }, store))['documents'], [
    { id: ID, title: 'First note', subtitle: 'first' },
  ]);
  assert.deepEqual(contentOperation(CONTENT, 'content:validate', {}, store), { issues: [], unchecked: true }, 'Validation says it did not run the schema');
});

test('a field write edits the file in place and reads back at once', () => {
  const store = files();
  const written = value(
    contentOperation(CONTENT, 'content:remoteEdit', { request: { operation: 'write', write: { id: ID, field: 'title', value: 'Edited note' } } }, store),
  );
  assert.equal(store.texts.get(FILE), BAKED.replace('First note', 'Edited note'), 'Only the title changed; the comment and the body are kept');
  assert.deepEqual(written['fields'], [
    { name: 'title', value: 'Edited note' },
    { name: 'summary', value: 'A short summary' },
    { name: 'body', value: 'The body.\n' },
  ]);
  const list = value(contentOperation(CONTENT, 'content:remoteRead', { request: { operation: 'documents', collection: 'notes' } }, store));
  assert.equal((list['documents'] as readonly { readonly title: string }[])[0]?.title, 'Edited note', 'The list shows the new title');
  value(contentOperation(CONTENT, 'content:remoteEdit', { request: { operation: 'write', write: { id: ID, field: 'body', value: 'New body.\n' } } }, store));
  assert.match(store.texts.get(FILE) ?? '', /---\nNew body\.\n$/, 'The body is written below the frontmatter');
});

test('negative space: renames, new entries, unknown documents and other operations refuse', () => {
  const store = files();
  const edit = (request: unknown) => contentOperation(CONTENT, 'content:remoteEdit', { request }, store);
  assert.deepEqual(edit({ operation: 'rename', id: ID, slug: 'x' }), { ok: false, message: CONTENT_ROUTE_REASONS.rename });
  assert.deepEqual(edit({ operation: 'create', collection: 'notes' }), { ok: false, message: CONTENT_ROUTE_REASONS.create });
  assert.deepEqual(edit({ operation: 'write', write: { id: 'notes.ffffffffffffffff', field: 'title', value: 'x' } }), {
    ok: false,
    message: 'This entry is not part of the demo.',
  });
  assert.throws(() => contentOperation(CONTENT, 'cms:delete', {}, store), /full Stacki app/);
  assert.deepEqual(contentOperation(undefined, 'content:remoteRead', { request: { operation: 'collections' } }, store), {
    ok: false,
    message: 'This site has no content collections the demo could read.',
  });
  assert.equal(store.texts.get(FILE), BAKED, 'Nothing was written');
});

test('a page patch is planned only for fields shown as written', () => {
  const store = files();
  contentOperation(CONTENT, 'content:remoteEdit', { request: { operation: 'write', write: { id: ID, field: 'title', value: 'Edited note' } } }, store);
  const titled = contentChanges(CONTENT, new Map(store.texts), (file) => (file === FILE ? BAKED : undefined));
  assert.deepEqual(titled, { fields: [{ before: 'First note', after: 'Edited note', pages: ['src/pages/index.astro'] }], unshown: false });
  contentOperation(CONTENT, 'content:remoteEdit', { request: { operation: 'write', write: { id: ID, field: 'summary', value: 'Changed' } } }, store);
  assert.equal(
    contentChanges(CONTENT, new Map(store.texts), (file) => (file === FILE ? BAKED : undefined)).unshown,
    true,
    'A field no page shows as written gets the note',
  );
});
