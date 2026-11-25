// Text at the ends of an editor that is shown for context and cannot be edited.

import { EditorState, type Extension, type Transaction } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { ExternalChange } from '@uiw/react-codemirror';
import { assert } from '../../shared/core/assert';

/** The text at each end of an editor that is context, not for editing. */
export type CodeEditorLockedEdges = { readonly prefixLength: number; readonly suffixLength: number };

const lockedEdgeMark = Decoration.mark({ class: 'code-editor_context' });

/**
 * Refuses edits to the chain around a nested rule and draws it quieter, so it
 * reads as the rule's address rather than as code to change. A value set from
 * outside is not an edit and passes: it is how the chain itself gets updated.
 */
export function lockedEdgeExtensions(edges: CodeEditorLockedEdges): readonly Extension[] {
  assert(edges.prefixLength >= 0, 'lockedEdgeExtensions: a length is never negative');
  assert(edges.suffixLength >= 0, 'lockedEdgeExtensions: a length is never negative');
  if (edges.prefixLength === 0 && edges.suffixLength === 0) {
    return [];
  }
  return [
    EditorState.changeFilter.of((transaction) => lockedEdgeFilter(transaction, edges)),
    EditorView.decorations.of((view) => {
      const length = view.state.doc.length;
      const ranges = [];
      if (edges.prefixLength > 0) {
        ranges.push(lockedEdgeMark.range(0, Math.min(edges.prefixLength, length)));
      }
      if (edges.suffixLength > 0) {
        ranges.push(lockedEdgeMark.range(Math.max(length - edges.suffixLength, 0), length));
      }
      return Decoration.set(ranges, true);
    }),
  ];
}

// The ranges changes are dropped from. CodeMirror keeps an insertion at the very
// start of a dropped range, so one at either end of the document is refused here:
// it would land outside the chain.
function lockedEdgeFilter(transaction: Transaction, edges: CodeEditorLockedEdges): boolean | readonly number[] {
  if (transaction.annotation(ExternalChange) === true) {
    return true;
  }
  const length = transaction.startState.doc.length;
  let outside = false;
  transaction.changes.iterChangedRanges((from, to) => {
    if (from === to) {
      if (from < edges.prefixLength) {
        outside = true;
      } else if (from > length - edges.suffixLength) {
        outside = true;
      }
    }
  });
  return outside ? false : [0, edges.prefixLength, length - edges.suffixLength, length];
}
