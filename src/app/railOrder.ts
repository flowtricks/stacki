// The left rail's button order, which each person arranges themselves: drag a button to reorder it or to
// move it between the TOP list and the BOTTOM list (LeftRail.tsx, Studio's EditorRail.tsx). This file is the
// pure model: the default order, how a stored order is read and completed, and each move.
//
// The default order is the source of truth for WHICH buttons exist. A stored order only arranges them:
// an id the build no longer has is dropped, an id the stored order lacks (a panel added since) is placed
// where the default puts it, and a repeated id keeps its first place. The resolved order always holds every
// default id exactly once, so the rail can never lose a button. A button the role hides stays in the order
// (its place is kept for when the role shows it); `visibleRailOrder` filters at draw time.
//
// The order belongs to the person, not the project: it is kept for the app as a whole (railOrderStore.ts),
// never in a `.stacki/` file or any project directory.
import { assert } from '../../shared/core/assert';

export const RAIL_GROUPS = ['top', 'bottom'] as const;
export type RailGroup = (typeof RAIL_GROUPS)[number];

/** The rail's buttons in two lists, each top to bottom. */
export interface RailOrder {
  readonly top: readonly string[];
  readonly bottom: readonly string[];
}

/** The most ids a stored order is read for; a rail has a few dozen buttons at most. */
export const RAIL_ORDER_IDS_MAX = 64;
/** The longest id the order holds; the rail's ids are short words. */
export const RAIL_ORDER_ID_CHARS_MAX = 64;

/** The stored form's version, so a later shape can be told from this one. */
const RAIL_ORDER_VERSION = 1;

/** Every id in the order, top list first. */
export function railOrderIds(order: RailOrder): readonly string[] {
  return [...order.top, ...order.bottom];
}

/**
 * The order stored text holds, or undefined when it is not one. Anything is accepted as input; an id that
 * is not a short non-empty string, or repeats an earlier one, is dropped, and each list is cut to the bound.
 */
export function parseStoredRailOrder(raw: unknown): RailOrder | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  if (Reflect.get(parsed, 'version') !== RAIL_ORDER_VERSION) {
    return undefined;
  }
  const seen = new Set<string>();
  const top = parseIds(Reflect.get(parsed, 'top'), seen);
  const bottom = parseIds(Reflect.get(parsed, 'bottom'), seen);
  if (top === undefined || bottom === undefined) {
    return undefined;
  }
  assert(top.length + bottom.length <= 2 * RAIL_ORDER_IDS_MAX, 'A parsed order stays within its bound');
  return { top, bottom };
}

/** The text to store for `order`. */
export function stringifyRailOrder(order: RailOrder): string {
  assert(order.top.length + order.bottom.length <= 2 * RAIL_ORDER_IDS_MAX, 'A stored order stays within its bound');
  return JSON.stringify({ version: RAIL_ORDER_VERSION, top: order.top, bottom: order.bottom });
}

/**
 * `stored` laid over `defaults`: every default id exactly once, in the stored places where the stored order
 * names it, and the rest where the default puts them. Total: a missing or hostile `stored` gives the default.
 */
export function resolveRailOrder(defaults: RailOrder, stored: RailOrder | undefined): RailOrder {
  const defaultIds = railOrderIds(defaults);
  assert(new Set(defaultIds).size === defaultIds.length, 'Default rail ids are unique');
  assert(defaultIds.length <= RAIL_ORDER_IDS_MAX, 'The default rail is within its bound');
  if (stored === undefined) {
    return defaults;
  }
  const known = new Set(defaultIds);
  const placed = new Set<string>();
  const keep = (ids: readonly string[]): string[] => {
    const kept: string[] = [];
    for (const id of ids) {
      if (known.has(id) && !placed.has(id)) {
        placed.add(id);
        kept.push(id);
      }
    }
    return kept;
  };
  const top = keep(stored.top);
  const bottom = keep(stored.bottom);
  // A default id the stored order lacks goes after its nearest default neighbour before it in its default
  // list (or first in that list), so a panel added later appears where the default places it.
  for (const group of RAIL_GROUPS) {
    const list = group === 'top' ? top : bottom;
    const defaultList = defaults[group];
    for (let index = 0; index < defaultList.length; index += 1) {
      const id = defaultList[index];
      assert(id !== undefined, 'The index is inside the default list');
      if (!placed.has(id)) {
        placed.add(id);
        list.splice(insertionIndex(list, defaultList, index), 0, id);
      }
    }
  }
  assert(top.length + bottom.length === defaultIds.length, 'The resolved order holds every default id once');
  assert(placed.size === known.size, 'Every default id is placed');
  return { top, bottom };
}

/** Whether `order` is `defaults`, so a reset has nothing to do. */
export function isDefaultRailOrder(defaults: RailOrder, order: RailOrder): boolean {
  return sameRailOrder(defaults, order);
}

/** Whether two orders hold the same ids in the same places. */
export function sameRailOrder(left: RailOrder, right: RailOrder): boolean {
  return sameIds(left.top, right.top) && sameIds(left.bottom, right.bottom);
}

/** `order` limited to the ids in `shown`, keeping their order: what the rail draws. */
export function visibleRailOrder(order: RailOrder, shown: ReadonlySet<string>): RailOrder {
  return { top: order.top.filter((id) => shown.has(id)), bottom: order.bottom.filter((id) => shown.has(id)) };
}

/** Where `id` sits in `order`, or undefined when the order lacks it. */
export function railPlaceOf(order: RailOrder, id: string): { readonly group: RailGroup; readonly index: number } | undefined {
  const topIndex = order.top.indexOf(id);
  if (topIndex >= 0) {
    return { group: 'top', index: topIndex };
  }
  const bottomIndex = order.bottom.indexOf(id);
  return bottomIndex >= 0 ? { group: 'bottom', index: bottomIndex } : undefined;
}

/**
 * `id` moved into `group`, right before `beforeId` (a button of that group) or at its end when `beforeId` is
 * undefined. The same ids result in total; an id the order lacks, or a `beforeId` outside `group`, leaves it as it was.
 */
export function placeRailItem(order: RailOrder, id: string, group: RailGroup, beforeId: string | undefined): RailOrder {
  if (railPlaceOf(order, id) === undefined || beforeId === id) {
    return order;
  }
  const without: RailOrder = { top: order.top.filter((other) => other !== id), bottom: order.bottom.filter((other) => other !== id) };
  const list = without[group];
  const index = beforeId === undefined ? list.length : list.indexOf(beforeId);
  if (index < 0) {
    return order;
  }
  const next = [...list.slice(0, index), id, ...list.slice(index)];
  const result: RailOrder = group === 'top' ? { top: next, bottom: without.bottom } : { top: without.top, bottom: next };
  assert(result.top.length + result.bottom.length === order.top.length + order.bottom.length, 'A move keeps every id');
  return result;
}

/**
 * `id` one place up or down among the buttons in `shown` (the ones the rail draws); a role-hidden button
 * between two shown ones keeps its place. The edge of a list is a no-op: a move across lists is `placeRailItem`.
 */
export function shiftRailItem(order: RailOrder, shown: ReadonlySet<string>, id: string, direction: 'up' | 'down'): RailOrder {
  const place = railPlaceOf(order, id);
  if (place === undefined) {
    return order;
  }
  const visible = order[place.group].filter((other) => shown.has(other));
  const at = visible.indexOf(id);
  if (at < 0) {
    return order;
  }
  if (direction === 'up') {
    const neighbour = visible[at - 1];
    return neighbour === undefined ? order : placeRailItem(order, id, place.group, neighbour);
  }
  const following = visible[at + 1];
  if (following === undefined) {
    return order;
  }
  const after = visible[at + 2];
  return placeRailItem(order, id, place.group, after);
}

/**
 * `id` into the other list, at the edge that meets the one it left: the start of the bottom list from the top,
 * the end of the top list from the bottom, so it stays where the eye expects it.
 */
export function crossRailItem(order: RailOrder, id: string, group: RailGroup): RailOrder {
  const place = railPlaceOf(order, id);
  if (place === undefined || place.group === group) {
    return order;
  }
  const first = group === 'bottom' ? order.bottom[0] : undefined;
  return placeRailItem(order, id, group, first);
}

/** The 1-based position of `id` among the shown buttons of its list, with that list's shown count, for announcements. */
export function railPosition(
  order: RailOrder,
  shown: ReadonlySet<string>,
  id: string,
): { readonly group: RailGroup; readonly position: number; readonly count: number } | undefined {
  const place = railPlaceOf(order, id);
  if (place === undefined) {
    return undefined;
  }
  const visible = order[place.group].filter((other) => shown.has(other));
  const at = visible.indexOf(id);
  return at < 0 ? undefined : { group: place.group, position: at + 1, count: visible.length };
}

function parseIds(value: unknown, seen: Set<string>): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  // Read as unknowns: `Array.isArray` narrows to `any[]`, which would let an element through unchecked.
  const entries: readonly unknown[] = value;
  const ids: string[] = [];
  for (const entry of entries.slice(0, RAIL_ORDER_IDS_MAX)) {
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= RAIL_ORDER_ID_CHARS_MAX && !seen.has(entry)) {
      seen.add(entry);
      ids.push(entry);
    }
  }
  return ids;
}

// Where in `list` the default id at `index` goes: after the nearest earlier default id already in `list`,
// or first when none is.
function insertionIndex(list: readonly string[], defaultList: readonly string[], index: number): number {
  for (let before = index - 1; before >= 0; before -= 1) {
    const neighbour = defaultList[before];
    const at = neighbour === undefined ? -1 : list.indexOf(neighbour);
    if (at >= 0) {
      return at + 1;
    }
  }
  return 0;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
