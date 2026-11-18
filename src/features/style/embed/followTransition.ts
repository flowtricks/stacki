// What the Follow canvas size toggle (the link on the breakpoint trigger), the "0" key and a row
// picked from the breakpoint list do to the style panel's edit target and to the canvas, as one
// pure table (docs/style-follow-canvas.md has it in prose).
//
// Following ties the edit target to the canvas: the row that holds at the canvas width is the
// target. So the two ways out of that tie say which side moves:
//   - the toggle (or "0") lets go of the canvas: following turns off and the target becomes Base,
//     with the canvas exactly where it is, so the person edits Base while looking at the small
//     canvas. Turning it back on retargets to the row that holds at the canvas, and the canvas does
//     not move either;
//   - a row picked while following moves both together: the target is that row and the canvas goes
//     to the width of that row's breakpoint, the toolbar device button's width, so following stays
//     on. A row that names no breakpoint (`prefers-reduced-motion`, a hand-typed width) has no
//     canvas width to go to: the target is held there and the canvas stays.
// Picking while held stays held and leaves the canvas alone, except the row that holds at the
// canvas, which is following again.

import { assert } from '../../../../shared/core/assert';
import type { ResolvedBreakpoint } from '../../../../shared/properties/projectBreakpoints';
import { baseCanvasTarget } from '../model/baseWidth';
import { FOLLOW_CONTEXTS_MAX, type FollowContext } from '../model/followWidth';
import { canvasWidthForQuery } from '../model/queryWidth';
import { describeCondition } from './contextRows';

/** The follow toggle and the edit target, as the transition reads them. */
export interface FollowState {
  readonly following: boolean;
  /** The edit target is Base (the key ''). */
  readonly targetIsBase: boolean;
}

/** Where a picked row puts the canvas: a width, the Desktop device, or nowhere (the row names no breakpoint). */
export type RowPlacement = { readonly kind: 'width'; readonly widthPx: number } | { readonly kind: 'desktop' } | { readonly kind: 'none' };

/** What the person did. `toggle` is the link on the trigger and the "0" key, one action. */
export type FollowAction =
  | { readonly kind: 'toggle' }
  | {
      readonly kind: 'pick';
      /** The picked row holds at the canvas width now (it is the row following would pick). */
      readonly holdsAtCanvas: boolean;
      readonly placement: RowPlacement;
    };

/** The result: the follow mode, which target, and whether the canvas moves (to the pick's placement). */
export interface FollowOutcome {
  readonly following: boolean;
  /** `keep` the target, make it `base`, the picked `row`, or the row that holds at the canvas (`matched`). */
  readonly target: 'keep' | 'base' | 'row' | 'matched';
  readonly canvas: 'keep' | 'move';
}

/** The one table. Every combination of state and action has its row here, and nothing else decides it. */
export function followTransition(state: FollowState, action: FollowAction): FollowOutcome {
  switch (action.kind) {
    case 'toggle':
      if (state.following) {
        // Let go of the canvas: edit Base, with the canvas where it is.
        return { following: false, target: state.targetIsBase ? 'keep' : 'base', canvas: 'keep' };
      }
      // Follow again: the target is the row that holds at the canvas, which does not move.
      return { following: true, target: 'matched', canvas: 'keep' };
    case 'pick':
      return pickOutcome(state, action);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function pickOutcome(state: FollowState, action: Extract<FollowAction, { readonly kind: 'pick' }>): FollowOutcome {
  if (action.holdsAtCanvas) {
    // The canvas already shows this row: nothing moves, and the target and the canvas agree again.
    return { following: true, target: 'row', canvas: 'keep' };
  }
  if (state.following) {
    if (action.placement.kind === 'none') {
      // No canvas width to go to: held at the row, the canvas stays.
      return { following: false, target: 'row', canvas: 'keep' };
    }
    return { following: true, target: 'row', canvas: 'move' };
  }
  // Held: the pick is the style target only; the canvas stays where the person put it.
  return { following: false, target: 'row', canvas: 'keep' };
}

/**
 * Where picking `row` puts the canvas so that following lands on it. `followKeyAt` is the row following
 * picks at a width (the panel's own rule, unwritten desktop-first breakpoints included), so a move never
 * makes following snap to another row. Base goes where Base is the layer in effect (model/baseWidth.ts),
 * or to the Desktop device when following would not land on Base there (a desktop-first component whose
 * project breakpoints are wider than its own queries). A query row named for a project breakpoint goes to
 * that breakpoint's device width (the toolbar button's), or, when following there lands elsewhere (a
 * `>= 30rem` row named for a `< 30rem` Phone), to the query's own boundary width. Anything else is `none`.
 */
export function rowPlacement(
  row: FollowContext,
  rows: readonly FollowContext[],
  breakpoints: readonly ResolvedBreakpoint[],
  rootFontSizePx: number,
  followKeyAt: (widthPx: number) => string,
): RowPlacement {
  assert(rows.length <= FOLLOW_CONTEXTS_MAX, 'rowPlacement: the row list is within its bound');
  assert(rootFontSizePx > 0, 'rowPlacement: a root font size is positive');
  const atContext = row.embedAtContext ?? '';
  if (row.key === '') {
    const base = baseCanvasTarget(
      rows.map((entry) => entry.embedAtContext ?? ''),
      rootFontSizePx,
    );
    switch (base.kind) {
      case 'width':
        return followKeyAt(base.widthPx) === '' ? base : { kind: 'desktop' };
      case 'desktop':
        return base;
      case 'keep':
        return { kind: 'none' };
      default: {
        const exhaustive: never = base;
        return exhaustive;
      }
    }
  }
  if (atContext === '') {
    return { kind: 'none' };
  }
  const condition = describeCondition(atContext, breakpoints);
  if (condition.kind !== 'width') {
    return { kind: 'none' };
  }
  if (condition.breakpoint === undefined) {
    return { kind: 'none' };
  }
  const own = canvasWidthForQuery(atContext, rootFontSizePx);
  const candidates = own.kind === 'width' ? [condition.breakpoint.widthPx, own.widthPx] : [condition.breakpoint.widthPx];
  for (const widthPx of candidates) {
    if (followKeyAt(widthPx) === row.key) {
      assert(Number.isSafeInteger(widthPx), 'rowPlacement: a canvas width is whole pixels');
      return { kind: 'width', widthPx };
    }
  }
  return { kind: 'none' };
}
