// What a selector row does after its lock is clicked, as a pure state machine.
// Locking or unlocking moves the row to another tab, so in a filtered view it
// would vanish at once. Instead the row is held: first the lock swings and the
// tinted names change colour (`changing`), then, if it no longer belongs in the
// tab, its height closes to nothing (`collapsing`) and the rows below slide up.
// A row with no record here is `steady`: drawn exactly as the report says.
//
// `changing` has two steps. `saving` lasts until the keep list is written and
// the report re-read, so the new colour comes from the real verdict rather than
// a guess; `showing` then gives the colour its time before the collapse.
//
// A row can also leave without its own lock being clicked: a stylesheet's or
// folder's lock, or a name lock shared with other rows, changes many verdicts
// at once. Such a row is kept listed while its new colour shows (the caller
// times that), then `left` starts it straight at `collapsing`.
import { assert } from '../../../shared/core/assert';
import type { SelectorVerdictKind } from '../../../shared/properties/selectorUsage';

export type RowTransition =
  | {
      readonly phase: 'changing';
      readonly step: 'saving';
      /** The verdict when the lock was clicked, so the icon can show the state it is moving to. */
      readonly from: SelectorVerdictKind;
      /** The "Can't tell" reason the row was listed under, so a held row keeps its group. */
      readonly reason: string | undefined;
    }
  | { readonly phase: 'changing'; readonly step: 'showing'; readonly reason: string | undefined }
  | { readonly phase: 'collapsing'; readonly reason: string | undefined };

export type RowPhase = 'steady' | RowTransition['phase'];

export type RowEvent =
  | { readonly kind: 'toggle'; readonly from: SelectorVerdictKind; readonly reason: string | undefined }
  /** Another lock moved the row out of the open tab and its colour has shown; `reason` is the "Can't tell" group it was listed under. */
  | { readonly kind: 'left'; readonly reason: string | undefined }
  /** The keep list was written (or failed to be) and the report re-read. */
  | { readonly kind: 'settled' }
  /** The colour has had its time; `belongs` says whether the row's new verdict is in the open tab. */
  | { readonly kind: 'shown'; readonly belongs: boolean }
  /** The collapse finished: its transition ended, or the fallback timer fired. */
  | { readonly kind: 'collapsed' };

export type RowTransitions = ReadonlyMap<string, RowTransition>;

export const ROW_TRANSITION_TIMINGS = {
  /** The lock's swing and the names' colour change. */
  changeMs: 200,
  /** The row's height and opacity closing. */
  collapseMs: 200,
  /** How long past the collapse to wait for a `transitionend` that may never come. */
  collapseFallbackMs: 320,
  /** A row arriving in the open tab opening to its height (CSS `@starting-style`). */
  enterMs: 200,
} as const satisfies Record<string, number>;

/**
 * Rows animating at once. One stylesheet or folder lock can move every row on
 * screen, which is two list pages at most in practice; past this, rows change
 * without animation.
 */
export const ROW_TRANSITIONS_MAX = 512;

export const NO_ROW_TRANSITIONS: RowTransitions = new Map();

/** A row's next transition, or undefined once it is steady again. Events a phase does not expect leave it as it is. */
export function stepRow(current: RowTransition | undefined, event: RowEvent): RowTransition | undefined {
  if (current === undefined) {
    // Only a click or a move starts a transition; a stale timer for a finished row does nothing.
    if (event.kind === 'toggle') {
      assertLockable(event.from);
      return { phase: 'changing', step: 'saving', from: event.from, reason: event.reason };
    }
    if (event.kind === 'left') {
      return { phase: 'collapsing', reason: event.reason };
    }
    return undefined;
  }
  switch (current.phase) {
    case 'changing':
      return stepChanging(current, event);
    case 'collapsing':
      // The row is on its way out: a second click on it is ignored.
      return event.kind === 'collapsed' ? undefined : current;
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

/** Applies one event to one row, within the bound on rows animating at once. */
export function stepTransitions(rows: RowTransitions, id: string, event: RowEvent): RowTransitions {
  return stepTransitionsMany(rows, [id], event);
}

/**
 * Applies one event to each named row, copying the table once rather than per
 * row. A row past the bound on rows animating at once is left steady: it
 * changes without animation.
 */
export function stepTransitionsMany(rows: RowTransitions, ids: readonly string[], event: RowEvent): RowTransitions {
  assert(rows.size <= ROW_TRANSITIONS_MAX, 'stepTransitions: the rows animating stay within their bound');
  assert(ids.length <= ROW_TRANSITIONS_MAX, 'stepTransitions: one step names no more rows than can animate');
  let out: Map<string, RowTransition> | undefined;
  for (const id of ids) {
    assert(id.length > 0, 'stepTransitions: a row is named');
    const table: RowTransitions = out ?? rows;
    const current = table.get(id);
    if (current === undefined) {
      if (table.size < ROW_TRANSITIONS_MAX) {
        // Room for another: fall through to the step below.
      } else {
        continue;
      }
    }
    const next = stepRow(current, event);
    if (next === current) {
      continue;
    }
    out ??= new Map(rows);
    if (next === undefined) {
      out.delete(id);
    } else {
      out.set(id, next);
    }
  }
  assert((out ?? rows).size <= ROW_TRANSITIONS_MAX, 'stepTransitions: a step never passes the bound');
  return out ?? rows;
}

export function rowPhase(rows: RowTransitions, id: string): RowPhase {
  return rows.get(id)?.phase ?? 'steady';
}

/** The "Can't tell" reason of each held row, so the reason list keeps it in its group while it leaves. */
export function heldReasons(rows: RowTransitions): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [id, row] of rows) {
    if (row.reason !== undefined) {
      out.set(id, row.reason);
    }
  }
  assert(out.size <= rows.size, 'heldReasons: one reason per held row at most');
  return out;
}

/** Whether the lock draws closed: while saving it shows where the click is going, after that the verdict itself. */
export function lockShownClosed(row: RowTransition | undefined, kind: SelectorVerdictKind): boolean {
  if (row !== undefined) {
    if (row.phase === 'changing') {
      if (row.step === 'saving') {
        return row.from !== 'kept';
      }
    }
  }
  return kind === 'kept';
}

function stepChanging(current: Extract<RowTransition, { readonly phase: 'changing' }>, event: RowEvent): RowTransition | undefined {
  if (current.step === 'saving') {
    assertLockable(current.from);
  }
  switch (event.kind) {
    case 'toggle':
    case 'left':
      // A second click or move while the first is still showing is ignored, so one click is one change.
      return current;
    case 'settled':
      return current.step === 'saving' ? { phase: 'changing', step: 'showing', reason: current.reason } : current;
    case 'shown':
      if (current.step === 'showing') {
        return event.belongs ? undefined : { phase: 'collapsing', reason: current.reason };
      }
      return current;
    case 'collapsed':
      return current;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

// The lock is drawn only on rows whose verdict names something to keep.
function assertLockable(kind: SelectorVerdictKind): void {
  assert(kind !== 'untracked', 'rowTransitions: a row with no names has no lock');
  assert(kind !== 'checking', 'rowTransitions: a row still being checked has no lock');
  assert(kind !== 'used', 'rowTransitions: a used row has no lock');
}
