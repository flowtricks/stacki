import { assert } from '../../../shared/core/assert';

// One variable in the field, as TokenField draws it (its Chip type).
interface SnapshotChip {
  readonly text: string;
  readonly name: string;
  readonly type: string;
}

// Undo and redo for the token field.
//
// The field is a contentEditable the app redraws: every keystroke in a code
// field is re-coloured by replacing the markup, bracket pairing and arrow
// stepping write the text themselves, and a picked variable rebuilds the field
// from the new value. The browser's own undo stack records DOM changes, and a
// redraw leaves it pointing at nodes that no longer exist, so ⌘Z did nothing,
// or worse. So the field keeps its own history of what it showed: the text with
// each chip as one mark, the chips themselves, and where the caret was.
//
// A run of typing is one step, the way an editor groups it: characters typed
// within TYPING_RUN_MS of each other, of the same kind, undo together.

export interface FieldSnapshot {
  readonly text: string;
  readonly chips: readonly SnapshotChip[];
  readonly caret: number;
}

export interface FieldHistory {
  readonly past: readonly FieldSnapshot[];
  readonly future: readonly FieldSnapshot[];
  /** The kind of the last recorded edit and when, to group a run of typing. */
  readonly run: { readonly kind: string; readonly atMs: number } | undefined;
}

// Steps kept. A field's value is a line of CSS; a hundred steps is far past
// what anybody walks back through, and the bound keeps the stack from growing
// for as long as a field stays open.
export const FIELD_HISTORY_STEPS_MAX = 100;
// The longest pause inside one run of typing.
export const TYPING_RUN_MS = 1000;

export const EMPTY_FIELD_HISTORY: FieldHistory = { past: [], future: [], run: undefined };

/**
 * `history` with `before` (the field as it was before an edit of `kind`) as a
 * new step. A grouped edit (typing that continues a run) adds nothing, since
 * the run's first step already holds the state to return to. Any edit clears
 * what could be redone.
 */
export function recordEdit(
  history: FieldHistory,
  before: FieldSnapshot,
  edit: { readonly kind: string; readonly atMs: number; readonly grouped: boolean },
): FieldHistory {
  assert(Number.isFinite(edit.atMs), 'recordEdit: an edit has a time');
  const continues = edit.grouped && history.run !== undefined && history.run.kind === edit.kind && edit.atMs - history.run.atMs <= TYPING_RUN_MS;
  const last = history.past.at(-1);
  if (continues || (last !== undefined && sameSnapshot(last, before))) {
    return { past: history.past, future: [], run: { kind: edit.kind, atMs: edit.atMs } };
  }
  const past = [...history.past, before].slice(-FIELD_HISTORY_STEPS_MAX);
  assert(past.length <= FIELD_HISTORY_STEPS_MAX, 'recordEdit: the history is bounded');
  return { past, future: [], run: { kind: edit.kind, atMs: edit.atMs } };
}

/** One step back from `current`: the state to show and the history after it, or undefined with nothing to undo. */
export function undoStep(history: FieldHistory, current: FieldSnapshot): { readonly show: FieldSnapshot; readonly history: FieldHistory } | undefined {
  const show = history.past.at(-1);
  if (show === undefined) {
    return undefined;
  }
  const future = [...history.future, current].slice(-FIELD_HISTORY_STEPS_MAX);
  return { show, history: { past: history.past.slice(0, -1), future, run: undefined } };
}

/** One step forward from `current`, or undefined with nothing to redo. */
export function redoStep(history: FieldHistory, current: FieldSnapshot): { readonly show: FieldSnapshot; readonly history: FieldHistory } | undefined {
  const show = history.future.at(-1);
  if (show === undefined) {
    return undefined;
  }
  const past = [...history.past, current].slice(-FIELD_HISTORY_STEPS_MAX);
  return { show, history: { past, future: history.future.slice(0, -1), run: undefined } };
}

function sameSnapshot(left: FieldSnapshot, right: FieldSnapshot): boolean {
  if (left.text !== right.text) {
    return false;
  }
  return left.chips.map((chip) => chip.text).join('\u0001') === right.chips.map((chip) => chip.text).join('\u0001');
}
