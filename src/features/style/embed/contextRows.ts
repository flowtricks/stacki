// What each query of the context dropdown says about itself, and the order it is listed in.
//
// A width query is shown the way the preview bar names its devices: when its one boundary is a
// project breakpoint (`.stacki/breakpoints.json`) and bounds the width on that breakpoint's side,
// it reads `Laptop` with the muted condition `< 64rem`; otherwise it reads as the bare condition
// (`≥ 40rem`). The match is the breakpoint sync's own (classifyBound in
// shared/properties/mediaBreakpointSync.ts), so what the sync would rewrite when a breakpoint
// changes is exactly what is named here, and the rules are written once. Anything that says
// nothing measurable about width (motion, colour scheme, hover, print, a container) is `other`:
// the dropdown folds those into one collapsed row.
//
// Order follows the preview bar: the queries bounded from below (`>=`, the bar's wider-than-Desktop
// side) from the widest down, then those bounded from above (`<`, `<=`) from the widest down, each
// by its boundary in pixels with declaration order breaking a tie. Pure, so it is tested without React.

import { assert } from '../../../../shared/core/assert';
import { classifyBound, findWidthBounds, type WidthBound } from '../../../../shared/properties/mediaBreakpointSync';
import { boundaryPx, formatBreakpoint, type ResolvedBreakpoint } from '../../../../shared/properties/projectBreakpoints';
import { queryWidthSides } from '../model/queryWidth';

/** The most queries described at once: a dropdown lists a handful; the bound keeps the walk honest. */
export const CONTEXT_ROWS_MAX = 512;

const ROOT_FONT_SIZE_PX = 16;

export type ConditionKind =
  | {
      readonly kind: 'width';
      /** The condition as a short symbol and length: `≥ 64rem`, `< 48rem`, `≥ 30rem, < 48rem`. */
      readonly condition: string;
      /** Which side of the preview bar the query sits on: bounded from below (`up`) or from above (`down`). */
      readonly direction: 'up' | 'down';
      /** The boundary the query is ordered by, in pixels. */
      readonly boundaryPx: number;
      /** The project breakpoint it is named for, when its one boundary is that breakpoint's on its side. */
      readonly breakpoint: ResolvedBreakpoint | undefined;
    }
  | { readonly kind: 'other' };

/** How a context's at-rule chain reads, by its innermost link (the query the styles sit in). */
export function describeCondition(atContext: string, resolved: readonly ResolvedBreakpoint[]): ConditionKind {
  const sides = queryWidthSides(atContext, ROOT_FONT_SIZE_PX);
  if (sides.kind !== 'sides') {
    return { kind: 'other' };
  }
  const innermost = (atContext.split(' › ').pop() ?? '').trim();
  const bounds = findWidthBounds(innermost, { lineComments: false });
  if (bounds.length === 0) {
    return { kind: 'other' };
  }
  const direction = sides.upper ? 'down' : 'up';
  const single = bounds.length === 1 ? bounds[0] : undefined;
  const breakpoint = single === undefined ? undefined : breakpointOf(single, resolved);
  const condition =
    breakpoint === undefined
      ? lowerFirst(bounds).map(symbolic).join(', ')
      : `${breakpoint.direction === 'up' ? '≥' : '<'} ${formatBreakpoint(breakpoint.setting)}`;
  // A range is ordered by its upper boundary, as it ends where the next query takes over.
  const ordering = direction === 'down' ? bounds.filter((bound) => bound.side === 'upper') : bounds;
  const reference = ordering.map(pixelsOf).reduce((smallest, next) => Math.min(smallest, next), Number.POSITIVE_INFINITY);
  assert(Number.isFinite(reference), 'describeCondition: a width query has a boundary');
  return { kind: 'width', condition, direction, boundaryPx: reference, breakpoint };
}

// The breakpoint whose boundary this single bound is, on that breakpoint's side of the bar.
function breakpointOf(bound: WidthBound, resolved: readonly ResolvedBreakpoint[]): ResolvedBreakpoint | undefined {
  return resolved.find((breakpoint) => {
    const side = breakpoint.direction === 'up' ? 'lower' : 'upper';
    return bound.side === side && classifyBound(bound, breakpoint) !== undefined;
  });
}

// A range reads from its lower bound to its upper, whichever way it was written.
function lowerFirst(bounds: readonly WidthBound[]): WidthBound[] {
  return [...bounds].sort((left, right) => (left.side === right.side ? 0 : left.side === 'lower' ? -1 : 1));
}

function symbolic(bound: WidthBound): string {
  const symbol = bound.side === 'lower' ? (bound.inclusive ? '≥' : '>') : bound.inclusive ? '≤' : '<';
  return `${symbol} ${bound.value}${bound.unit}`;
}

function pixelsOf(bound: WidthBound): number {
  return boundaryPx({ value: bound.value, unit: bound.unit });
}

/** An item to be ordered: its position as written, and what its query says. */
export interface OrderedCondition {
  readonly index: number;
  readonly condition: ConditionKind;
}

/**
 * Width queries in the preview bar's order: those bounded from below from the widest down, then
 * those bounded from above from the widest down; a tie keeps declaration order. Items that are not
 * width queries are not part of this order and are dropped from the result.
 */
export function orderByBar<T extends OrderedCondition>(items: readonly T[]): T[] {
  assert(items.length <= CONTEXT_ROWS_MAX, 'orderByBar: a context list is bounded');
  const widths = items.filter((item) => item.condition.kind === 'width');
  const rank = (item: T): number => (item.condition.kind === 'width' && item.condition.direction === 'up' ? 0 : 1);
  const boundary = (item: T): number => (item.condition.kind === 'width' ? item.condition.boundaryPx : 0);
  return [...widths].sort((left, right) => rank(left) - rank(right) || boundary(right) - boundary(left) || left.index - right.index);
}
