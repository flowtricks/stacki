import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { captureSelectionPositions } from '../src/features/collaboration/selectionPositions';
import { structuralEdits } from '../src/features/source/sourceOperations';
import {} from '../src/features/source/source';
import type { Peer } from '../src/features/collaboration/presence';

test('undoing a move preserves the other editor’s selected element and ownership', () => {
  const document = new Y.Doc();
  const text = document.getText('source');
  const original = '<main><h1>Heading</h1><p>Paragraph</p></main>';
  text.insert(0, original);
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set(['structure']) });
  try {
    const edits = structuralEdits(original, {
      kind: 'move',
      node: 'n0.0',
      target: 'n0.1',
      placement: 'after',
    });
    document.transact(() => {
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        text.delete(edit.start, edit.end - edit.start);
        text.insert(edit.start, edit.text);
      }
    }, 'structure');
    const peers = new Map<string, Peer>([
      [
        'other',
        {
          id: 'other',
          selection: 'n0.0',
          editing: true,
          name: 'Other editor',
          file: 'src/pages/index.astro',
          page: 'src/pages/index.astro',
          occurrence: 0,
          updatedAt: 0,
        },
      ],
    ]);
    const restore = captureSelectionPositions(document, peers.values());
    undo.undo();
    restore(peers);
    assert.equal(text.toString(), original);
    assert.equal(peers.get('other')?.selection, 'n0.1');
    assert.equal(peers.get('other')?.editing, true);
    const restoreRedo = captureSelectionPositions(document, peers.values());
    undo.redo();
    restoreRedo(peers);
    assert.equal(peers.get('other')?.selection, 'n0.0');
  } finally {
    undo.destroy();
    document.destroy();
  }
});

test('undoing Convert to puts the selection back on the bare run', () => {
  for (const [original, node, selected] of [
    ['<code>one<br />two</code>', 'n0.2', 'n0.2'],
    ['<section><b>x</b>\n  words\n  <i>y</i></section>', 'n0.1', 'n0.2'],
  ] as const) {
    const document = new Y.Doc();
    const text = document.getText('source');
    text.insert(0, original);
    const undo = new Y.UndoManager(text, { trackedOrigins: new Set(['structure']) });
    try {
      const edits = structuralEdits(original, { kind: 'wrap-text', node, name: 'span' });
      document.transact(() => {
        for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
          text.delete(edit.start, edit.end - edit.start);
          text.insert(edit.start, edit.text);
        }
      }, 'structure');
      const peer: Peer = {
        id: 'self',
        selection: selected,
        editing: false,
        name: 'Editor',
        file: 'src/pages/index.astro',
        page: 'src/pages/index.astro',
        occurrence: 0,
        updatedAt: 0,
      };
      const peers = new Map<string, Peer>([['self', peer]]);
      const restore = captureSelectionPositions(document, peers.values());
      undo.undo();
      restore(peers);
      assert.equal(text.toString(), original);
      assert.equal(peers.get('self')?.selection, node);
    } finally {
      undo.destroy();
      document.destroy();
    }
  }
});
test('an element undone away with no words at its place leaves nothing selected', () => {
  const document = new Y.Doc();
  const text = document.getText('source');
  const original = '<main><p>x</p></main>';
  text.insert(0, original);
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set(['structure']) });
  try {
    document.transact(() => text.insert(14, '<br />'), 'structure');
    const peers = new Map<string, Peer>([
      [
        'self',
        {
          id: 'self',
          selection: 'n0.1',
          editing: false,
          name: 'Editor',
          file: 'src/pages/index.astro',
          page: 'src/pages/index.astro',
          occurrence: 0,
          updatedAt: 0,
        },
      ],
    ]);
    const restore = captureSelectionPositions(document, peers.values());
    undo.undo();
    restore(peers);
    assert.equal(peers.get('self')?.selection, '');
  } finally {
    undo.destroy();
    document.destroy();
  }
});
