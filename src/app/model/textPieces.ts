// A text node of the page connected to data, or back to words: the node
// restated as the pieces the Settings Text field asks for (TextConnectField.tsx).
// Connecting the whole of `Text` writes `{label}` in its place; connecting at
// the caret in `Some text` writes `Some {label} text`.
//
// Only the node itself is restated, never its parent: the nodes beside it — a
// <slot />, a <span> — keep their bytes. Several pieces are written as one
// expression node whose source is the words (encoded as the printer encodes
// text, so a brace in them stays a character) with the chip between them.
// Written as separate nodes they would be printed one to a line, and the line
// breaks would render as spaces inside the words. The page read back from the
// file holds them as the words and the expression they are.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { encodeText } from '../../../shared/page/htmlText';
import type { EditGesture } from '../../editor/pageEdits';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import { nodeGesture } from '../../editor/editGestures';
import { findEditorNodeById } from '../../editor/pageState';
import type { TextPiece } from '../../features/props/textConnect';

// Words, a chip, words: the most a connection at the caret makes of one node.
const TEXT_PIECES_MAX = 3;

/** The node `nodeId` (a text or an expression) restated as `pieces`, in one undo step. */
export function textPiecesGesture(model: EditorModel, nodeId: string, pieces: readonly TextPiece[]): EditGesture | undefined {
  assert(pieces.length > 0, 'textPiecesGesture: a node is restated as at least one piece');
  assert(pieces.length <= TEXT_PIECES_MAX, 'textPiecesGesture: a connection makes at most three pieces');
  const node = findEditorNodeById(model.nodes, nodeId);
  if (node === undefined) {
    return undefined;
  }
  if (node.kind !== 'text' && node.kind !== 'expr') {
    return undefined;
  }
  const next = restatedNode(node.id, pieces);
  assert(next.id === node.id, 'textPiecesGesture: the node keeps its id');
  return nodeGesture(node.id, next, { coalesceKey: undefined, urgency: true });
}

function restatedNode(id: EditorNode['id'], pieces: readonly TextPiece[]): EditorNode {
  const [only] = pieces;
  if (pieces.length === 1 && only !== undefined && only.kind === 'text') {
    assert(only.value.length > 0, 'textPiecesGesture: words have words');
    assert(only.value.length <= LIMITS.nodeValueCharsMax, 'textPiecesGesture: words are inside the node value bound');
    return { id, kind: 'text', value: only.value };
  }
  const value = pieces.map(pieceSource).join('');
  assert(pieces.filter((piece) => piece.kind === 'expr').length === 1, 'textPiecesGesture: a connection is one chip');
  assert(value.length <= LIMITS.nodeValueCharsMax, 'textPiecesGesture: the source is inside the node value bound');
  return { id, kind: 'expr', value };
}

function pieceSource(piece: TextPiece): string {
  switch (piece.kind) {
    case 'text':
      assert(piece.value.length > 0, 'textPiecesGesture: a text piece has words');
      return encodeText(piece.value);
    case 'expr':
      assert(/^\{[^{}]+\}$/.test(piece.value), 'textPiecesGesture: an expression piece is written with its braces');
      return piece.value;
    default: {
      const exhaustive: never = piece;
      return exhaustive;
    }
  }
}
