// The context dropdown's rows, grouped by where each query is written.
//
// Listed flat, every query repeated its stylesheet chip and the selector it is nested in
// (`Grid .grid @media (width >= 30rem)`, three times over), so the eye had to read each
// row whole to tell them apart. The rows are grouped instead: Base on its own at the top,
// then one group per stylesheet and wrapper selector, named once in the group's header,
// with its queries under it, width queries from the narrowest boundary up and the rest
// after them in the order they were written. Queries that name no stylesheet (typed, not
// yet written) follow ungrouped. Pure, so the order is tested without React.

import { assert } from '../../../../shared/core/assert';
import { canvasWidthForQuery } from '../model/queryWidth';
import type { StyleContext } from '../model/resolved';

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
  | { readonly kind: 'loose'; readonly item: T };

const ROOT_FONT_SIZE_PX = 16;

/**
 * Groups `items` (each carrying its StyleContext and its wrapper selector) for the dropdown.
 * Group order is first appearance; within a group, width queries sort by the width a pick
 * lands on (canvasWidthForQuery), ascending, and the rest keep their written order after.
 */
export function groupContexts<T extends { readonly context: StyleContext; readonly wrapper: string | undefined }>(items: readonly T[]): ContextGroup<T>[] {
  assert(items.length <= CONTEXT_GROUP_ENTRIES_MAX, 'groupContexts: a context list is bounded');
  const result: ContextGroup<T>[] = [];
  const groups = new Map<string, { key: ContextGroupKey; items: T[] }>();
  const loose: T[] = [];
  let base: T | undefined;
  for (const item of items) {
    if (item.context.key === '') {
      assert(base === undefined, 'groupContexts: one Base');
      base = item;
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
    result.push({ kind: 'group', key: group.key, items: byWidth(group.items) });
  }
  for (const item of loose) {
    result.push({ kind: 'loose', item });
  }
  return result;
}

// Width queries first, from the narrowest boundary; ties and the others keep written order.
function byWidth<T extends { readonly context: StyleContext }>(items: readonly T[]): T[] {
  const measured = items.map((item, index) => ({ item, index, widthPx: widthOf(item.context) }));
  measured.sort((left, right) => {
    if (left.widthPx !== undefined && right.widthPx !== undefined) {
      return left.widthPx - right.widthPx || left.index - right.index;
    }
    if (left.widthPx !== undefined) {
      return -1;
    }
    if (right.widthPx !== undefined) {
      return 1;
    }
    return left.index - right.index;
  });
  return measured.map((entry) => entry.item);
}

function widthOf(context: StyleContext): number | undefined {
  const atContext = context.embedAtContext;
  if (atContext === undefined || atContext === '') {
    return undefined;
  }
  const width = canvasWidthForQuery(atContext, ROOT_FONT_SIZE_PX);
  return width.kind === 'width' ? width.widthPx : undefined;
}
