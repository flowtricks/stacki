// Two independent replicas edit the same source concurrently, then merge in opposite
// orders. Persist and reopen the result to verify convergence and durable recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { Room } from '../src/features/collaboration/rooms';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('concurrent typing converges without losing either insertion', () => {
  const base = new Y.Doc();
  base.getText('source').insert(0, '<h1>Hello</h1>');
  const first = new Y.Doc();
  const second = new Y.Doc();
  const initial = Y.encodeStateAsUpdate(base);
  Y.applyUpdate(first, initial);
  Y.applyUpdate(second, initial);
  first.getText('source').insert(4, 'First ');
  second.getText('source').insert(9, ' Second');
  const a = Y.encodeStateAsUpdate(first);
  const b = Y.encodeStateAsUpdate(second);
  Y.applyUpdate(first, b);
  Y.applyUpdate(second, a);
  assert.equal(first.getText('source').toString(), '<h1>First Hello Second</h1>');
  assert.equal(first.getText('source').toString(), second.getText('source').toString());
  for (const doc of [base, first, second]) {
    doc.destroy();
  }
});
test('a room persists source plus CRDT history and incorporates external disk changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'astro-studio-'));
  try {
    await mkdir(path.join(root, 'src/pages'), { recursive: true });
    await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Hello</h1>');
    const room = new Room(root, 'src/pages/index.astro');
    await room.initialize();
    const fresh = new Room(root, 'src/pages/index.astro');
    await fresh.initialize();
    Y.applyUpdate(fresh.document, Y.encodeStateAsUpdate(room.document));
    assert.equal(fresh.text.toString(), '<h1>Hello</h1>', 'Restart before the first edit retains CRDT identity');
    fresh.document.destroy();
    room.text.insert(4, 'Shared ');
    await room.persist();
    assert.equal(await readFile(path.join(root, 'src/pages/index.astro'), 'utf8'), '<h1>Shared Hello</h1>');
    const restored = new Room(root, 'src/pages/index.astro');
    await restored.initialize();
    assert.equal(restored.text.toString(), room.text.toString());
    await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>External</h1>');
    await restored.diskChanged();
    assert.equal(restored.text.toString(), '<h1>External</h1>');
    room.document.destroy();
    restored.document.destroy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
