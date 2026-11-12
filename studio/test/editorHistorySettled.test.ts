// Goal: an undo pressed while a structural action is still unanswered waits for the answer, then
// undoes the action itself, not the step before it (the 1.2.0 Studio browser failure: undo right
// after a navigator drag took the earlier text edit and tangled the two).
// Method: the real EditorHistory over a Yjs undo manager, with a `settled` promise the test holds
// open like the server's answer, while the action's step is only recorded when the answer lands.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { EditorHistory } from '../src/features/collaboration/editorHistory';

test('undo waits for an unanswered action and then undoes that action', async () => {
  const doc = new Y.Doc();
  const undo = new Y.UndoManager(doc.getText('source'));
  let answer: () => void = () => {};
  let answered = false;
  const settled = () => (answered ? Promise.resolve() : new Promise<void>((resolve) => (answer = resolve)));
  const history = new EditorHistory(undo, settled);
  const undone: string[] = [];
  const note = (name: string) => {
    undone.push(name);
  };
  try {
    history.record({ undo: () => note('edit'), redo: () => {} });
    const pressed = history.step('undo');
    await Promise.resolve();
    assert.equal(undone.length, 0, 'Nothing is undone while the action is unanswered');
    // The server's answer: the action's step exists from this moment.
    history.record({ undo: () => note('action'), redo: () => {} });
    answered = true;
    answer();
    await pressed;
    assert.deepEqual(undone, ['action'], 'The action is undone first; the earlier edit stays');
    assert.equal(await history.step('undo'), undefined);
    assert.deepEqual(undone, ['action', 'edit'], 'The next undo takes the earlier edit');
  } finally {
    undo.destroy();
    doc.destroy();
  }
});

test('without a pending action, undo does not wait', async () => {
  const doc = new Y.Doc();
  const undo = new Y.UndoManager(doc.getText('source'));
  const history = new EditorHistory(undo);
  const undone: string[] = [];
  const note = (name: string) => {
    undone.push(name);
  };
  try {
    history.record({ undo: () => note('edit'), redo: () => {} });
    await history.step('undo');
    assert.deepEqual(undone, ['edit']);
  } finally {
    undo.destroy();
    doc.destroy();
  }
});
