// The breakpoint a following panel shows when the canvas is narrower than the project's wider breakpoints,
// even though no rule is written for it yet.
//
// Following the canvas normally selects a query that already exists (model/followWidth.ts). In a
// desktop-first component, where the queries are `width < X`, the person narrows the canvas to Tablet to
// style Tablet, and no `< 48rem` block exists yet: the target would read Base and the first style would
// land on every size. So the panel shows the breakpoint that holds at the canvas width as the active,
// empty target, and writes nothing until the first style (embed/useEditorResolution.ts writes the
// `@media (width < 48rem)` block with that edit, the way a typed query does).
//
// Which direction a component uses is read, never guessed silently:
//   - its existing width queries vote (detectConvention, as the Add query form reads them): mostly
//     lower-bounded (`width >= X`) is mobile-first, and then this does nothing: Base is the smallest;
//   - no queries, or an even split, falls back to the project's breakpoint settings: only breakpoints
//     narrower than Desktop (direction `down`, `width < X`) take part, and a project with only wider
//     (`up`) breakpoints is mobile-first, so nothing happens either.
// The boundary is the breakpoint's own number and unit, written exactly as the Add query form writes it
// (`@media (width < 48rem)`), so the existing row for that query is the same one and is never duplicated.

import { assert } from '../../../../shared/core/assert';
import type { ResolvedBreakpoint } from '../../../../shared/properties/projectBreakpoints';
import { detectConvention, existingQueryKey, queryFor, ADD_QUERY_ENTRIES_MAX } from './addQueryModel';

/** A context as this rule reads it. */
export interface FollowBreakpointContext {
  readonly key: string;
  readonly embedAtContext?: string | undefined;
}

/** The breakpoint that holds at the canvas width, and the context that stands for it. */
export interface FollowBreakpoint {
  /** The breakpoint's own id (`tablet`). */
  readonly breakpointId: string;
  /** The query written for it: `@media (width < 48rem)`. */
  readonly query: string;
  /** The key of the existing row for that query, or undefined when no rule is written yet (the key is then `query`). */
  readonly existingKey: string | undefined;
}

/** Whether the component's queries (with the project's settings as the fallback) are desktop-first. */
export function desktopFirst(contexts: readonly FollowBreakpointContext[], breakpoints: readonly Pick<ResolvedBreakpoint, 'direction'>[]): boolean {
  assert(contexts.length <= ADD_QUERY_ENTRIES_MAX, 'desktopFirst: the context list is bounded');
  const convention = detectConvention(contexts.map((context) => context.embedAtContext ?? ''));
  if (convention === 'up') {
    return false;
  }
  if (convention === 'down') {
    return true;
  }
  // No majority: the project's breakpoint settings decide, and a project whose breakpoints are all wider than Desktop is mobile-first.
  return breakpoints.some((breakpoint) => breakpoint.direction === 'down');
}

/**
 * The breakpoint to follow at `widthPx`, or undefined: the component is mobile-first, or the width is
 * inside none of the narrower breakpoints (Desktop, which is Base). The narrowest breakpoint that still
 * contains the width wins, as the cascade resolves overlapping `width < X` queries.
 */
export function followBreakpoint(
  contexts: readonly FollowBreakpointContext[],
  widthPx: number,
  breakpoints: readonly ResolvedBreakpoint[],
): FollowBreakpoint | undefined {
  assert(Number.isFinite(widthPx), 'followBreakpoint: a canvas width is a number');
  assert(breakpoints.length <= ADD_QUERY_ENTRIES_MAX, 'followBreakpoint: the breakpoint list is bounded');
  if (!desktopFirst(contexts, breakpoints)) {
    return undefined;
  }
  let narrowest: ResolvedBreakpoint | undefined;
  for (const breakpoint of breakpoints) {
    if (breakpoint.direction !== 'down') {
      continue;
    }
    // The canvas width of a `down` breakpoint is its last whole pixel inside the query.
    if (widthPx > breakpoint.widthPx) {
      continue;
    }
    if (narrowest === undefined || breakpoint.widthPx < narrowest.widthPx) {
      narrowest = breakpoint;
    }
  }
  if (narrowest === undefined) {
    return undefined;
  }
  return {
    breakpointId: narrowest.id,
    query: queryFor(narrowest.setting, 'down'),
    existingKey: existingQueryKey(contexts, narrowest.setting, 'down'),
  };
}
