// The canvas width where Base is the layer in effect.
//
// Choosing Base in the context dropdown is choosing to write the styles no width query
// overrides, so the canvas should show a width where none of the listed width queries
// applies. Which width that is follows the project's convention, read from the queries
// themselves:
//
//   every width query a lower bound (`width >= X`, `min-width`): mobile first, Base
//     holds below the smallest, so the canvas lands one whole pixel under that query's
//     boundary (`width >= 30rem` at 16px is 480, so 479);
//   every width query an upper bound (`width < X`, `max-width`): desktop first, Base
//     holds above the largest, so the canvas lands one pixel over its boundary;
//   no width query, or lower and upper bounds mixed, or a range: no single side is
//     Base's, and the canvas goes to the desktop preset, as the desktop device does.
//
// The boundary is canvasWidthForQuery's (queryWidth.ts), the width a pick of that query
// lands on, so Base and the query sit exactly one pixel apart and can never disagree.
// Queries that say nothing about width (`prefers-reduced-motion`, `@supports`, a container
// query) are not part of the convention and are ignored. A width query this reader cannot
// measure (an `em` width, an `or` list) could hold anywhere, so it sends Base to desktop.

import { assert } from '../../../../shared/core/assert';
import { canvasWidthForQuery, QUERY_WIDTH_LIMITS, queryWidthSides } from './queryWidth';

/** Where choosing Base puts the canvas. */
export type BaseCanvasTarget = { readonly kind: 'width'; readonly widthPx: number } | { readonly kind: 'desktop' } | { readonly kind: 'keep' };

/** The most queries weighed: a context list is a handful; a bound keeps the loop honest. */
export const BASE_WIDTH_QUERIES_MAX = 256;

/**
 * The canvas target for Base, given the at-rule chains of the contexts the dropdown lists
 * (`atContexts`; Base itself and contexts with no query are passed as '' and skipped).
 */
export function baseCanvasTarget(atContexts: readonly string[], rootFontSizePx: number): BaseCanvasTarget {
  assert(rootFontSizePx > 0, 'baseCanvasTarget: a root font size is positive');
  const lowerWidths: number[] = [];
  const upperWidths: number[] = [];
  for (const atContext of atContexts.slice(0, BASE_WIDTH_QUERIES_MAX)) {
    if (atContext === '') {
      continue;
    }
    const sides = queryWidthSides(atContext, rootFontSizePx);
    if (sides.kind === 'none') {
      if (sides.reason === 'not-media' || sides.reason === 'no-width') {
        continue;
      }
      return { kind: 'desktop' };
    }
    if (sides.lower && sides.upper) {
      return { kind: 'desktop' };
    }
    const boundary = canvasWidthForQuery(atContext, rootFontSizePx);
    if (boundary.kind === 'none') {
      return { kind: 'desktop' };
    }
    if (sides.lower) {
      lowerWidths.push(boundary.widthPx);
    } else {
      upperWidths.push(boundary.widthPx);
    }
  }
  if (lowerWidths.length > 0 && upperWidths.length > 0) {
    return { kind: 'desktop' };
  }
  if (lowerWidths.length > 0) {
    return insideCanvas(Math.min(...lowerWidths) - 1);
  }
  if (upperWidths.length > 0) {
    return insideCanvas(Math.max(...upperWidths) + 1);
  }
  return { kind: 'desktop' };
}

// A width the canvas cannot show (below its narrowest) leaves it where it is: there is no
// width Base holds at that the canvas can draw.
function insideCanvas(widthPx: number): BaseCanvasTarget {
  assert(Number.isSafeInteger(widthPx), 'baseCanvasTarget: a width is whole pixels');
  if (widthPx < QUERY_WIDTH_LIMITS.widthPxMin) {
    return { kind: 'keep' };
  }
  if (widthPx > QUERY_WIDTH_LIMITS.widthPxMax) {
    return { kind: 'keep' };
  }
  return { kind: 'width', widthPx };
}
