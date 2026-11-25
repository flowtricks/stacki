// The left rail's button order, which each person arranges themselves: drag a button to reorder it, to move it
// between the TOP list and the BOTTOM list (LeftRail.tsx), or into the project's Settings panel, whose root lists
// the third container's items as rows (SettingsRailRows.tsx). This file is the pure model: the default order, how
// a stored order is read and completed, and each move.
//
// The default order is the source of truth for WHICH items exist. A stored order only arranges them:
// an id the build no longer has is dropped, an id the stored order lacks (a panel added since) is placed
// where the default puts it, and a repeated id keeps its first place. The resolved order always holds every
// default id exactly once, across the three containers, so no item can ever be lost. An item the role hides stays
// in the order (its place is kept for when the role shows it); `visibleRailOrder` filters at draw time.
//
// Settings itself and the AI button are fixed to the rail (RAIL_FIXED_IDS): Settings is the container the third
// list lives in, so it cannot go inside itself, and the AI chat is the rail's foot. They still reorder on the rail.
//
// The order belongs to the person, not the project: it is kept for the app as a whole (railOrderStore.ts),
// never in a `.stacki/` file or any project directory.
import { assert } from '../../shared/core/assert';

/** The rail's own two lists. */
export const RAIL_GROUPS = ['top', 'bottom'] as const;
export type RailGroup = (typeof RAIL_GROUPS)[number];

/** Every place an item can live: the rail's two lists and the Settings panel's root. */
export const RAIL_CONTAINERS = ['top', 'bottom', 'settings'] as const;
export type RailContainer = (typeof RAIL_CONTAINERS)[number];

/** The items in three lists, each top to bottom. */
export interface RailOrder {
  readonly top: readonly string[];
  readonly bottom: readonly string[];
  /** The rows of the Settings panel's root: its own views and any rail panel moved in. */
  readonly settings: readonly string[];
}

/** Where a move puts an item: a container, right before `beforeId` (an item of that container) or at its end. */
export interface RailTarget {
  readonly container: RailContainer;
  readonly beforeId: string | undefined;
}

/** Items that never go into Settings: Settings itself (it holds that list) and the AI chat. */
export const RAIL_FIXED_IDS: readonly string[] = ['projectSettings', 'ai'];

/** The most ids a stored list is read for; a rail has a few dozen buttons at most. */
export const RAIL_ORDER_IDS_MAX = 64;
/** The longest id the order holds; the rail's ids are short words. */
export const RAIL_ORDER_ID_CHARS_MAX = 64;

/** The stored form's version. Version 1 had no Settings list; it is still read, its Settings items placed by default. */
const RAIL_ORDER_VERSION = 2;
const RAIL_ORDER_VERSION_WITHOUT_SETTINGS = 1;

/** Whether `id` is fixed to the rail. */
export function isRailFixedId(id: string): boolean {
  return RAIL_FIXED_IDS.includes(id);
}

/** Every id in the order, top list first, Settings last. */
export function railOrderIds(order: RailOrder): readonly string[] {
  return [...order.top, ...order.bottom, ...order.settings];
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
  const version: unknown = Reflect.get(parsed, 'version');
  if (version !== RAIL_ORDER_VERSION && version !== RAIL_ORDER_VERSION_WITHOUT_SETTINGS) {
    return undefined;
  }
  const seen = new Set<string>();
  const top = parseIds(Reflect.get(parsed, 'top'), seen);
  const bottom = parseIds(Reflect.get(parsed, 'bottom'), seen);
  // A version 1 order predates the Settings list: every Settings item is placed where the default puts it.
  const settings = version === RAIL_ORDER_VERSION ? parseIds(Reflect.get(parsed, 'settings'), seen) : [];
  if (top === undefined || bottom === undefined || settings === undefined) {
    return undefined;
  }
  assert(top.length + bottom.length + settings.length <= RAIL_CONTAINERS.length * RAIL_ORDER_IDS_MAX, 'A parsed order stays within its bound');
  assert(seen.size === top.length + bottom.length + settings.length, 'A parsed order names each id once');
  return { top, bottom, settings };
}

/** The text to store for `order`. */
export function stringifyRailOrder(order: RailOrder): string {
  assertRailOrder(order);
  return JSON.stringify({ version: RAIL_ORDER_VERSION, top: order.top, bottom: order.bottom, settings: order.settings });
}

/**
 * `stored` laid over `defaults`: every default id exactly once, in the stored places where the stored order
 * names it, and the rest where the default puts them. Total: a missing or hostile `stored` gives the default.
 */
export function resolveRailOrder(defaults: RailOrder, stored: RailOrder | undefined): RailOrder {
  const defaultIds = railOrderIds(defaults);
  assert(new Set(defaultIds).size === defaultIds.length, 'Default rail ids are unique');
  assert(defaultIds.length <= RAIL_ORDER_IDS_MAX, 'The default rail is within its bound');
  assert(!defaults.settings.some(isRailFixedId), 'The default Settings list holds no fixed item');
  if (stored === undefined) {
    return defaults;
  }
  const known = new Set(defaultIds);
  const placed = new Set<string>();
  const keep = (ids: readonly string[], container: RailContainer): string[] => {
    const kept: string[] = [];
    for (const id of ids) {
      // A fixed item stored inside Settings (a hand-edited value) is dropped there and placed by default.
      const allowed = container !== 'settings' || !isRailFixedId(id);
      if (known.has(id) && !placed.has(id) && allowed) {
        placed.add(id);
        kept.push(id);
      }
    }
    return kept;
  };
  const lists: Record<RailContainer, string[]> = {
    top: keep(stored.top, 'top'),
    bottom: keep(stored.bottom, 'bottom'),
    settings: keep(stored.settings, 'settings'),
  };
  // A default id the stored order lacks goes after its nearest default neighbour before it in its default
  // list (or first in that list), so a panel added later appears where the default places it.
  for (const container of RAIL_CONTAINERS) {
    const list = lists[container];
    const defaultList = defaults[container];
    for (let index = 0; index < defaultList.length; index += 1) {
      const id = defaultList[index];
      assert(id !== undefined, 'The index is inside the default list');
      if (!placed.has(id)) {
        placed.add(id);
        list.splice(insertionIndex(list, defaultList, index), 0, id);
      }
    }
  }
  const result: RailOrder = { top: lists.top, bottom: lists.bottom, settings: lists.settings };
  assert(railOrderIds(result).length === defaultIds.length, 'The resolved order holds every default id once');
  assert(placed.size === known.size, 'Every default id is placed');
  assertRailOrder(result);
  return result;
}

/** Whether `order` is `defaults`, so a reset has nothing to do. */
export function isDefaultRailOrder(defaults: RailOrder, order: RailOrder): boolean {
  return sameRailOrder(defaults, order);
}

/** Whether two orders hold the same ids in the same places. */
export function sameRailOrder(left: RailOrder, right: RailOrder): boolean {
  return sameIds(left.top, right.top) && sameIds(left.bottom, right.bottom) && sameIds(left.settings, right.settings);
}

/** `order` limited to the ids in `shown`, keeping their order: what the rail and the Settings root draw. */
export function visibleRailOrder(order: RailOrder, shown: ReadonlySet<string>): RailOrder {
  return {
    top: order.top.filter((id) => shown.has(id)),
    bottom: order.bottom.filter((id) => shown.has(id)),
    settings: order.settings.filter((id) => shown.has(id)),
  };
}

/** Where `id` sits in `order`, or undefined when the order lacks it. */
export function railPlaceOf(order: RailOrder, id: string): { readonly group: RailContainer; readonly index: number } | undefined {
  for (const container of RAIL_CONTAINERS) {
    const index = order[container].indexOf(id);
    if (index >= 0) {
      return { group: container, index };
    }
  }
  return undefined;
}

/**
 * `id` moved to `target`. The one function every drag, key and menu move goes through. The same ids result in
 * total, each once; an id the order lacks, a `beforeId` outside the target container, a fixed item into Settings,
 * or a move to where the item already is leaves the order as it was (the same object, so callers can tell).
 */
export function moveRailItem(order: RailOrder, id: string, target: RailTarget): RailOrder {
  assertRailOrder(order);
  if (railPlaceOf(order, id) === undefined || target.beforeId === id) {
    return order;
  }
  if (target.container === 'settings' && isRailFixedId(id)) {
    return order;
  }
  const without: RailOrder = {
    top: order.top.filter((other) => other !== id),
    bottom: order.bottom.filter((other) => other !== id),
    settings: order.settings.filter((other) => other !== id),
  };
  const list = without[target.container];
  const index = target.beforeId === undefined ? list.length : list.indexOf(target.beforeId);
  if (index < 0) {
    return order;
  }
  const next = [...list.slice(0, index), id, ...list.slice(index)];
  const result: RailOrder = {
    top: target.container === 'top' ? next : without.top,
    bottom: target.container === 'bottom' ? next : without.bottom,
    settings: target.container === 'settings' ? next : without.settings,
  };
  assert(railOrderIds(result).length === railOrderIds(order).length, 'A move keeps every id');
  assert(result[target.container].includes(id), 'A move puts the item in its target');
  assertRailOrder(result);
  return sameRailOrder(result, order) ? order : result;
}

/** `id` moved into `group`, before `beforeId` or at its end: `moveRailItem` in the drag's terms. */
export function placeRailItem(order: RailOrder, id: string, group: RailContainer, beforeId: string | undefined): RailOrder {
  return moveRailItem(order, id, { container: group, beforeId });
}

/**
 * `id` one place up or down among the items in `shown` (the ones drawn) of its container; a role-hidden item
 * between two shown ones keeps its place. The edge of a list is a no-op: a move across lists is `moveRailItem`.
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
 * `id` into the other rail list, at the edge that meets the one it left: the start of the bottom list from the top,
 * the end of the top list from the bottom, so it stays where the eye expects it. From Settings, the same edges.
 */
export function crossRailItem(order: RailOrder, id: string, group: RailGroup): RailOrder {
  const place = railPlaceOf(order, id);
  if (place === undefined || place.group === group) {
    return order;
  }
  const first = group === 'bottom' ? order.bottom[0] : undefined;
  return placeRailItem(order, id, group, first);
}

/** `id` into the Settings panel, as its last row; a fixed item stays where it is. */
export function moveIntoSettings(order: RailOrder, id: string): RailOrder {
  return moveRailItem(order, id, { container: 'settings', beforeId: undefined });
}

/**
 * A Settings row out onto the rail, right above the Settings button it left, so it lands beside where the eye was.
 * An item not in Settings stays where it is.
 */
export function moveOutOfSettings(order: RailOrder, id: string): RailOrder {
  const place = railPlaceOf(order, id);
  if (place?.group !== 'settings') {
    return order;
  }
  const settingsPlace = railPlaceOf(order, 'projectSettings');
  if (settingsPlace === undefined || settingsPlace.group === 'settings') {
    // An order without the Settings button (a test's own defaults) takes the row to the end of the top list.
    return moveRailItem(order, id, { container: 'top', beforeId: undefined });
  }
  return moveRailItem(order, id, { container: settingsPlace.group, beforeId: 'projectSettings' });
}

/** The 1-based position of `id` among the shown items of its container, with that container's shown count, for announcements. */
export function railPosition(
  order: RailOrder,
  shown: ReadonlySet<string>,
  id: string,
): { readonly group: RailContainer; readonly position: number; readonly count: number } | undefined {
  const place = railPlaceOf(order, id);
  if (place === undefined) {
    return undefined;
  }
  const visible = order[place.group].filter((other) => shown.has(other));
  const at = visible.indexOf(id);
  return at < 0 ? undefined : { group: place.group, position: at + 1, count: visible.length };
}

/** The order's invariants: each id once across all containers, within the bound, and no fixed item in Settings. */
export function assertRailOrder(order: RailOrder): void {
  const all = railOrderIds(order);
  assert(all.length <= RAIL_CONTAINERS.length * RAIL_ORDER_IDS_MAX, 'A rail order stays within its bound');
  assert(new Set(all).size === all.length, 'A rail order holds each id once');
  assert(!order.settings.some(isRailFixedId), 'Settings and the AI button never go inside Settings');
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
