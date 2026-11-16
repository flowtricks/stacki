// Tells the canvas what a change to the page model does to it, in the frame the change is made in
// (shared/page/canvasEdit.ts says what is predicted, electron/preload/framePendingEdit.ts shows it).
// View only: the messages go to the frame and nothing is written.

import { planModelEdits, singleStructuralChange } from '../../shared/page/canvasEdit';
import { showInsertOnCanvas } from './canvasInsertShow';
import { tellCanvas } from './canvasQuery';
import { findEditorNodeById } from './pageState';
import type { EditorModel } from './pageView';

/** Whether an added or removed node is shown here (an undo or redo) or by the action that made it (an insert, a delete). */
export interface CanvasChangeOptions {
  readonly structure: 'show' | 'leave';
}

/**
 * Shows the change from `before` to `after`: attributes, words, a renamed tag, an element marked as
 * updating; and, when asked, the one node an undo or redo added or removed. Returns how many messages it sent.
 */
export function showModelChangeOnCanvas(
  before: EditorModel,
  after: EditorModel,
  options: CanvasChangeOptions,
  pathOf: (id: string) => string | undefined,
): number {
  if (before === after) {
    return 0;
  }
  let sent = 0;
  const planned = planModelEdits(before.nodes, after.nodes, pathOf);
  if (planned.edits.length > 0 && tellCanvas({ type: 'avb:optimistic-edit', edits: planned.edits })) {
    sent += 1;
  }
  if (planned.structural && options.structure === 'show') {
    const change = singleStructuralChange(before.nodes, after.nodes);
    if (change?.kind === 'removed') {
      const path = pathOf(change.id);
      if (path !== undefined && tellCanvas({ type: 'avb:hide-pending', path })) {
        sent += 1;
      }
    } else if (change?.kind === 'added') {
      const node = findEditorNodeById(after.nodes, change.id);
      if (node !== undefined && showInsertOnCanvas(before, { parentId: change.parentId, index: change.index }, node, pathOf)) {
        sent += 1;
      }
    }
  }
  return sent;
}
