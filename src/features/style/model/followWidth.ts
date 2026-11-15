// Which context the style panel edits while it follows the canvas width.
//
// As the canvas is resized, the query whose width condition holds at that width is the one the
// person is looking at, so it is the edit target (and the checked row of the context dropdown)
// until they pin the panel somewhere else (embed/contextFollow.ts).
//
// The rule, per width:
//   - only width conditions take part: a query about motion, print, hover or a container, or a
//     width the reader cannot measure (`em`, `or`, a list), is never auto-selected (it stays
//     selectable by hand), exactly as canvasWidthForQuery leaves the canvas alone for it;
//   - of the queries that hold, the most specific wins, the way the cascade resolves them: the
//     narrowest interval (a range inside a min-width), then the largest lower boundary
//     (mobile first: `>= 64rem` over `>= 48rem`), then the smallest upper boundary (desktop
//     first: `<= 767px` over `<= 991px`), then the first listed;
//   - none holding is Base.
// `rem` is the canvas page's root font size, as for every other reading of a query's width.

import { assert } from '../../../../shared/core/assert';
import { queryWidthMatch } from './queryWidth';

/** The most contexts weighed: a dropdown lists a handful; the bound keeps the loop honest. */
export const FOLLOW_CONTEXTS_MAX = 512;

/** A dropdown row as the follow rule reads it. */
export interface FollowContext {
  readonly key: string;
  readonly embedAtContext?: string | undefined;
}

/**
 * The key of the context that holds at `widthPx` ('' is Base). Never writes or moves anything:
 * it only names the row.
 */
export function followedContextKey(contexts: readonly FollowContext[], widthPx: number, rootFontSizePx: number): string {
  assert(contexts.length <= FOLLOW_CONTEXTS_MAX, 'followedContextKey: the context list is within its bound');
  assert(Number.isFinite(widthPx), 'followedContextKey: a canvas width is a number');
  let best: { readonly key: string; readonly lowerPx: number; readonly upperPx: number } | undefined;
  for (const context of contexts) {
    const atContext = context.embedAtContext ?? '';
    if (context.key === '' || atContext === '') {
      continue;
    }
    const match = queryWidthMatch(atContext, widthPx, rootFontSizePx);
    if (match.kind !== 'match') {
      continue;
    }
    if (best === undefined || moreSpecific(match, best)) {
      best = { key: context.key, lowerPx: match.lowerPx, upperPx: match.upperPx };
    }
  }
  return best === undefined ? '' : best.key;
}

// Strictly more specific, so a tie keeps the first listed.
function moreSpecific(candidate: { readonly lowerPx: number; readonly upperPx: number }, held: { readonly lowerPx: number; readonly upperPx: number }): boolean {
  const candidateSpan = candidate.upperPx - candidate.lowerPx;
  const heldSpan = held.upperPx - held.lowerPx;
  if (candidateSpan !== heldSpan) {
    return candidateSpan < heldSpan;
  }
  if (candidate.lowerPx !== held.lowerPx) {
    return candidate.lowerPx > held.lowerPx;
  }
  return candidate.upperPx < held.upperPx;
}
