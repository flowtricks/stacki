import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { assert } from '../../../../shared/core/assert';
import { codeTypedVariableAt, type CodeTypedVariable, type CodeVariableScope } from '../model/codeVariableScope';

// The CodeMirror half of a code editor's variables (CodeVariables.tsx holds
// the React half: the chooser and the bind dot).
//
// It reports the reference being typed as the text changes, hands the
// chooser the keys it answers while it follows the typing, and lets the
// React half reach the view to write a pick. It owns no state of its own: the
// handlers live behind a ref so the extension is built once per editor and
// never reconfigures the view as the chooser opens and closes.

/** Why the typed reference is being reported. */
export type CodeVariableCause = 'input' | 'selection';

/** The keys the chooser takes from the editor while it follows typing. */
export type CodeVariableKey = 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Tab' | 'Escape';
const CHOOSER_KEYS: ReadonlyArray<CodeVariableKey> = ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'];

export interface CodeVariableHandlers {
  /** What the editor's text is, read on every change so a new scope needs no new extension. */
  readonly scope: () => CodeVariableScope;
  /** The view as it mounts, and undefined as it goes. */
  readonly onView: (view: EditorView | undefined) => void;
  /** The reference at the caret after an edit (`input`) or a caret move (`selection`). */
  readonly onTyped: (typed: CodeTypedVariable | undefined, cause: CodeVariableCause) => void;
  /** A chooser key pressed in the editor; true when the chooser took it. */
  readonly onKey: (key: CodeVariableKey) => boolean;
}

/** The extension that reports typed references to the handlers behind `handlersRef`. */
export function codeVariableExtension(handlersRef: { readonly current: CodeVariableHandlers }): Extension {
  const viewTracker = ViewPlugin.define((view) => {
    handlersRef.current.onView(view);
    return {
      destroy: () => handlersRef.current.onView(undefined),
    };
  });
  const typingListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet) {
      return;
    }
    const typedByHand = update.transactions.some((transaction) => transaction.isUserEvent('input') || transaction.isUserEvent('delete'));
    const cause: CodeVariableCause = update.docChanged && typedByHand ? 'input' : 'selection';
    const handlers = handlersRef.current;
    handlers.onTyped(typedAtCaret(update.state.doc.toString(), update.state.selection.main, handlers.scope()), cause);
  });
  // Ahead of every keymap, and stopped here: Enter would otherwise break the
  // line, an arrow move the caret, and Escape reach the popover around the
  // editor and close it.
  const chooserKeys = Prec.highest(
    EditorView.domEventHandlers({
      keydown: (event) => {
        const key = CHOOSER_KEYS.find((candidate) => candidate === event.key);
        if (key === undefined) {
          return false;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) {
          return false;
        }
        if (!handlersRef.current.onKey(key)) {
          return false;
        }
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
    }),
  );
  return [viewTracker, typingListener, chooserKeys];
}

/** The reference typed at a collapsed caret; a selection is not typing. */
export function typedAtCaret(text: string, selection: { readonly from: number; readonly to: number }, scope: CodeVariableScope): CodeTypedVariable | undefined {
  assert(selection.from <= selection.to, 'typedAtCaret: a selection does not end before it starts');
  assert(selection.to <= text.length, 'typedAtCaret: the selection lies inside the text');
  if (selection.from === selection.to) {
    return codeTypedVariableAt(text, selection.to, scope);
  }
  return undefined;
}

/** The transaction that writes `binding` over the typed fragment and puts the caret after it. */
export function completeInView(view: EditorView, typed: CodeTypedVariable, binding: string): void {
  const length = view.state.doc.length;
  assert(typed.typed.end <= length, 'completeInView: the fragment lies inside the document');
  assert(binding.length > 0, 'completeInView: a pick is never empty');
  view.dispatch({
    changes: { from: typed.typed.start, to: typed.typed.end, insert: binding },
    selection: { anchor: typed.typed.start + binding.length },
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  view.focus();
}

/** The transaction that makes `binding` the whole value: the bind dot's pick. */
export function bindInView(view: EditorView, binding: string): void {
  assert(binding.length > 0, 'bindInView: a pick is never empty');
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: binding },
    selection: { anchor: binding.length },
    userEvent: 'input.complete',
  });
  assert(view.state.doc.toString() === binding, 'bindInView: the value is the binding');
  view.focus();
}
