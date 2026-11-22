// Which query the style panel keeps editing when the selection moves to another element.
//
// A query is offered per element: a component's own queries (`.grid` at `>= 64rem`) are listed for the
// elements inside that component and for nothing outside it. Moving the selection out of the component
// therefore leaves the query the person was in with no row to stand on. Keeping it anyway (an earlier
// version re-listed the old query on every element) left the panel editing `>= 64rem` on a Card that has
// no such query, with the canvas on Desktop, so the first style written there landed in a query the
// element does not own.
//
// The rule, one function, applied once the new element's queries are known:
//   - Base stays Base: it is on every element;
//   - a query that is among the new element's queries stays (same component, or a query both share);
//   - anything else (a query the element does not offer, a stale or removed key, an element with no
//     queries at all) falls back: to the row that holds at the canvas width while the panel follows
//     the canvas (so a mobile-first component entered at Desktop lands on its `>= 64rem` row, as
//     following does anywhere), otherwise to Base. The fallback is itself checked against the list, so a
//     follow answer that names a row the element lacks is Base too.
// Breakpoint switches are not this function's business: while following, the canvas width moves the
// target (model/followWidth.ts), and a held target stays put until the selection leaves its component.

import { assert } from '../../../../shared/core/assert';

/** The most queries weighed for one element, matching the dropdown's own bound. */
export const ACTIVE_QUERY_AVAILABLE_MAX = 512;

export interface ActiveQueryInput {
  /** The query key the panel was on (`''` is Base). */
  readonly previous: string;
  /** The keys of the queries the new element offers, Base included or not. */
  readonly available: readonly string[];
  /** The row that holds at the canvas width while the panel follows the canvas, or undefined when held or unknown. */
  readonly followedKey: string | undefined;
}

/** The query to edit on the new element: `previous` where the element offers it, else the followed row, else Base (`''`). */
export function resolveActiveQuery(input: ActiveQueryInput): string {
  assert(input.available.length <= ACTIVE_QUERY_AVAILABLE_MAX, 'resolveActiveQuery: the available list is within its bound');
  if (input.previous === '') {
    return '';
  }
  if (input.available.includes(input.previous)) {
    return input.previous;
  }
  const followed = input.followedKey;
  if (followed !== undefined && followed !== '' && input.available.includes(followed)) {
    return followed;
  }
  return '';
}
