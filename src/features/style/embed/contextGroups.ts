// The context dropdown's rows, sectioned by where each query is written.
//
// Listed flat, every query repeated its stylesheet chip and the selector it is nested in
// (`Grid .grid @media (width >= 30rem)`, three times over), so the eye had to read each
// row whole to tell them apart. The rows are grouped instead: Base on its own at the top,
// then one group per stylesheet and wrapper selector, named once in the group's header,
// with its queries under it, width queries from the narrowest boundary up and the rest
// after them in the order they were written. Queries that name no stylesheet (typed, not
// yet written) follow ungrouped. Pure, so the order is tested without React.

import { assert } from '../../../../shared/core/assert';
import type { ResolvedBreakpoint } from '../../../../shared/properties/projectBreakpoints';
import type { StyleContext } from '../model/resolved';
import { describeCondition, orderByBar } from './contextRows';

/** The most contexts grouped: a query list is a handful; the bound keeps the walk honest. */
export const CONTEXT_GROUP_ENTRIES_MAX = 512;

/** Where a query is written: the stylesheet key and the selector it nests in. */
export interface ContextGroupKey {
  readonly source: string | undefined;
  readonly wrapper: string | undefined;
}

export type ContextGroup<T> =
  // Base, pinned above every group.
  | { readonly kind: 'base'; readonly item: T }
  // Queries written in one stylesheet, inside one wrapper selector (or none).
  | { readonly kind: 'group'; readonly key: ContextGroupKey; readonly items: readonly T[] }
  // A query that names no stylesheet yet.
  | { readonly kind: 'loose'; readonly item: T }
  // Every query that says nothing measurable about width, from every group, folded into one row at the end.
  | { readonly kind: 'other'; readonly items: readonly T[] };

/**
 * Sections `items` (each carrying its StyleContext and its wrapper selector) for the dropdown.
 * Section order is first appearance; within one, width queries follow the preview bar's order
 * (contextRows.ts orderByBar). Queries that are not about width leave their sections and are
 * collected, in written order, into one `other` entry after everything else.
 */
export function groupContexts<T extends { readonly context: StyleContext; readonly wrapper: string | undefined }>(
  items: readonly T[],
  resolved: readonly ResolvedBreakpoint[],
): ContextGroup<T>[] {
  assert(items.length <= CONTEXT_GROUP_ENTRIES_MAX, 'groupContexts: a context list is bounded');
  const result: ContextGroup<T>[] = [];
  const groups = new Map<string, { key: ContextGroupKey; items: T[] }>();
  const loose: T[] = [];
  const other: T[] = [];
  let base: T | undefined;
  for (const item of items) {
    if (item.context.key === '') {
      assert(base === undefined, 'groupContexts: one Base');
      base = item;
      continue;
    }
    const atContext = item.context.embedAtContext ?? '';
    if (atContext !== '' && describeCondition(atContext, resolved).kind === 'other') {
      other.push(item);
      continue;
    }
    const source = item.context.source;
    if (source === undefined) {
      loose.push(item);
      continue;
    }
    const id = `${source}\u0000${item.wrapper ?? ''}`;
    const found = groups.get(id);
    if (found === undefined) {
      groups.set(id, { key: { source, wrapper: item.wrapper }, items: [item] });
    } else {
      found.items.push(item);
    }
  }
  if (base !== undefined) {
    result.push({ kind: 'base', item: base });
  }
  for (const group of groups.values()) {
    result.push({ kind: 'group', key: group.key, items: byWidth(group.items, resolved) });
  }
  for (const item of loose) {
    result.push({ kind: 'loose', item });
  }
  if (other.length > 0) {
    result.push({ kind: 'other', items: other });
  }
  return result;
}

// The preview bar's order: queries bounded from below from the widest down, then those bounded
// from above from the widest down; a tie keeps the written order. Rows that are not about width
// (a typed query not yet written, say) keep their written order after.
function byWidth<T extends { readonly context: StyleContext }>(items: readonly T[], resolved: readonly ResolvedBreakpoint[]): T[] {
  const described = items.map((item, index) => ({ item, index, condition: describeCondition(item.context.embedAtContext ?? '', resolved) }));
  const ordered = orderByBar(described).map((entry) => entry.item);
  const rest = described.filter((entry) => entry.condition.kind !== 'width').map((entry) => entry.item);
  return [...ordered, ...rest];
}
