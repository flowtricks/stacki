// Tells the canvas to draw a stand-in for a node the editor has just committed, before the
// page is written and rendered again (shared/page/canvasInsert.ts says why and what).
// View only: the message goes to the frame and nothing is written.

import { planCanvasInsert } from '../../shared/page/canvasInsert';
import { tellCanvas } from './canvasQuery';
import type { InsertTarget } from './insertTarget';
import type { EditorModel, EditorNode } from './pageView';

/**
 * Plans the stand-in against the tree as it stood before the edit (`before`), then draws it.
 * Nothing is drawn when the place or the node is one the canvas cannot predict.
 */
export function showInsertOnCanvas(
  before: EditorModel,
  target: InsertTarget | undefined,
  node: EditorNode,
  pathOf: (id: string) => string | undefined,
): boolean {
  const place = { parentId: target?.parentId, index: target?.index ?? before.nodes.length };
  const insert = planCanvasInsert(before.nodes, place, node, pathOf);
  if (insert === undefined) {
    return false;
  }
  return tellCanvas({ type: 'avb:optimistic-insert', insert });
}
