// Lists picked by hand, read back from the code that picks them: Astro's
// getEntries, a collection filtered to ids and kept in their order, and a
// builder export's ids mapped to the items of a list (loopQueryRead.ts).

import { LOOP_QUERY_LIMITS, isItemId } from './loopQuery';
import { namePath, type Js } from './loopSyntax';
import { listCollectionOf } from './optionsQuery';

/** How a list expression is followed to its collection. */
export interface ListContext {
  readonly lookup: (name: string) => Js | undefined;
  readonly importedFrom: (local: string, spec: string) => string | undefined;
}

export interface CuratedSelection {
  readonly collection: string;
  readonly ids: readonly string[];
  /** The list the ids are found in, as written, and where its items hold fields. */
  readonly list: { readonly text: string; readonly itemPath: readonly string[] };
}

// `getEntries([{ collection: 'team', id: 'a' }, …])`: entries picked from one
// collection, in the order listed.
export function entriesSelection(args: readonly Js[]): { readonly collection: string; readonly ids: readonly string[] } | undefined {
  const [list] = args;
  if (list?.kind !== 'array' || args.length !== 1 || list.items.length > LOOP_QUERY_LIMITS.selectionMax) {
    return undefined;
  }
  let collection: string | undefined;
  const ids: string[] = [];
  for (const item of list.items) {
    const name = item.kind === 'object' ? item.entries.find((entry) => entry.key === 'collection')?.value : undefined;
    const id = item.kind === 'object' ? item.entries.find((entry) => entry.key === 'id')?.value : undefined;
    if (name?.kind !== 'string' || id?.kind !== 'string' || !isItemId(id.value) || (collection !== undefined && name.value !== collection)) {
      return undefined;
    }
    collection = name.value;
    ids.push(id.value);
  }
  // An empty list names no collection; it is read as nothing chosen yet.
  return collection === undefined ? undefined : { collection, ids };
}

// `["a", "b"].map((id) => list.find((entry) => entry.id === id)).filter(Boolean)`:
// a builder export's picked items, found in a list by id, in the order listed.
export function curatedSelection(node: Js, context: ListContext, source: string): CuratedSelection | undefined {
  const mapped = node.kind === 'call' && node.callee.kind === 'member' && node.callee.property === 'filter' ? node.callee.object : node;
  if (mapped.kind !== 'call' || mapped.callee.kind !== 'member' || mapped.callee.property !== 'map') {
    return undefined;
  }
  const ids = mapped.callee.object;
  const callback = mapped.args[0];
  const find = callback?.kind === 'function' ? callback.body : undefined;
  if (
    ids.kind !== 'array' ||
    ids.items.length > LOOP_QUERY_LIMITS.selectionMax ||
    find?.kind !== 'call' ||
    find.callee.kind !== 'member' ||
    find.callee.property !== 'find'
  ) {
    return undefined;
  }
  const picked = ids.items.flatMap((item) => (item.kind === 'string' && isItemId(item.value) ? [item.value] : []));
  const list = find.callee.object;
  const listed = listCollectionOf(list, context);
  if (picked.length !== ids.items.length || listed === undefined) {
    return undefined;
  }
  const text = source.slice(list.from, list.to);
  return { collection: listed.collection, ids: picked, list: { text, itemPath: listed.itemPath } };
}

// `.filter((entry) => ["a", "b"].includes(entry.id))`, then optionally the
// sort that restores that order: entries picked from a collection by id.
export function pickedIds(callback: Js, sort: Js | undefined): readonly string[] | undefined {
  // The only sort that keeps it a picked list is the one restoring that order.
  if (sort !== undefined && !ordersByIndex(sort)) {
    return undefined;
  }
  const parameter = callback.kind === 'function' ? callback.parameters[0] : undefined;
  const body = callback.kind === 'function' ? callback.body : undefined;
  if (parameter?.kind !== 'name' || body?.kind !== 'call' || body.callee.kind !== 'member' || body.callee.property !== 'includes') {
    return undefined;
  }
  const list = body.callee.object;
  const argument = namePath(body.args[0] ?? body.callee);
  if (list.kind !== 'array' || list.items.length > LOOP_QUERY_LIMITS.selectionMax || argument?.join('.') !== `${parameter.name}.id`) {
    return undefined;
  }
  const ids = list.items.flatMap((item) => (item.kind === 'string' && isItemId(item.value) ? [item.value] : []));
  return ids.length === list.items.length ? ids : undefined;
}

// `(a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)`.
function ordersByIndex(node: Js): boolean {
  const body = node.kind === 'function' ? node.body : undefined;
  const indexed = (side: Js): boolean => side.kind === 'call' && side.callee.kind === 'member' && side.callee.property === 'indexOf';
  return body?.kind === 'binary' && body.operator === '-' && indexed(body.left) && indexed(body.right);
}
