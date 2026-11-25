// Goal: an app's undo label (docs/apps.md, "Undo labels") names the history step
// its edit made in Studio, and only that step: undo and redo hand the label back
// for the editor to show, a step the edit folded into keeps its own name, and a
// step without a label stays unnamed.
// Method: the real EditorHistory over a Yjs undo manager, with recorded commands.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { EditorHistory } from '../src/features/collaboration/editorHistory';

test('a labelled step answers its label on undo and redo; others answer none', async () => {
  const doc = new Y.Doc();
  const undo = new Y.UndoManager(doc.getText('source'));
  const history = new EditorHistory(undo);
  try {
    history.record({ undo: () => {}, redo: () => {} });
    const before = history.newest();
    history.record({ undo: () => {}, redo: () => {} });
    history.labelNewest(before, 'Pin feedback');
    const unchanged = history.newest();
    history.labelNewest(unchanged, 'Not mine');
    assert.equal(await history.step('undo'), 'Pin feedback', 'the step the edit made carries the label');
    assert.equal(await history.step('redo'), 'Pin feedback', 'redo names it too');
    await history.step('undo');
    assert.equal(await history.step('undo'), undefined, 'an unnamed step has no label');
    assert.equal(await history.step('undo'), undefined, 'an empty history steps nowhere');
  } finally {
    undo.destroy();
    doc.destroy();
  }
});
