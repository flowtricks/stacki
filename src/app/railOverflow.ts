// Which left-rail buttons fit, for both rails (Desktop's LeftRail.tsx, Studio's
// EditorRail.tsx). On a short window the buttons that do not fit move into a
// "More" menu at the foot of the rail. `railOverflow` decides which, from the
// room the rail has; `useRailOverflow` measures that room with a ResizeObserver.
//
// The order things leave in is fixed: pinned apps first, the last pinned first,
// then the panels from the bottom up. The active item never leaves while another
// can go in its place, so the open panel always has its button; only when nothing
// fits at all does it go too, and then the More button shows it is inside.
//
// Smoothness: the room is the rail's own box, which flex layout sets from the
// window, never from the buttons inside it (styles.css `.rail` clips and has
// `min-height: 0`). Hiding a button therefore cannot change the next measurement,
// so a resize settles in one pass and never flickers between two layouts.
import { useLayoutEffect, useState, type RefObject } from 'react';
import { assert } from '../../shared/core/assert';
import { ROLE_LIMITS } from '../../shared/properties/projectRoles';

/** A rail button: a built-in panel, or an app a role pinned. */
export interface RailOverflowItem {
  readonly id: string;
  readonly group: 'panel' | 'app';
}

/** The room in the rail's column, and what each kind of row takes of it, gap included. */
export interface RailRoom {
  /** The column's height for buttons: the rail's, less its padding and the rows anchored at its foot, plus one gap. */
  readonly availablePx: number;
  /** One button and the gap after it; the More button is one too. */
  readonly itemPx: number;
  /** The line between panels and pinned apps and the gap after it. */
  readonly separatorPx: number;
}

export interface RailLayout {
  /** Ids shown in the rail, in rail order. */
  readonly visible: readonly string[];
  /** Ids in the More menu, in rail order; empty means no More button. */
  readonly hidden: readonly string[];
}

/** Built-in panels, the More button and every pin a role may hold: the most rows a rail ever lays out. */
const RAIL_ITEMS_MAX = 32 + ROLE_LIMITS.pinnedAppsMax;

// What the hook assumes when the stylesheet gives it nothing to read (a test DOM):
// the values styles.css sets on `.rail`, `.rail-btn` and `.rail-separator`.
const RAIL_BUTTON_PX = 32;
const RAIL_GAP_PX = 4;
const RAIL_SEPARATOR_PX = 5;

/**
 * Which items fit in `room`, and which move into the More menu. Items are in
 * rail order: panels, then pinned apps in the order they were pinned. Every
 * item fits when the room allows; otherwise the More button takes a row and
 * items leave in the fixed order until the rest fit, `active` last of all.
 */
export function railOverflow(items: readonly RailOverflowItem[], room: RailRoom, active: string | undefined): RailLayout {
  assert(items.length <= RAIL_ITEMS_MAX, 'The rail lays out a bounded number of rows');
  assert(room.itemPx > 0, 'A rail row has height');
  assert(new Set(items.map((item) => item.id)).size === items.length, 'Rail ids are unique');
  if (fits(items, room, 'without-more')) {
    return { visible: items.map((item) => item.id), hidden: [] };
  }
  const order = leavingOrder(items);
  assert(order.length === items.length, 'Every item has a place in the leaving order');
  for (let count = 1; count <= items.length; count += 1) {
    const leaving = new Set(leavers(order, count, active));
    const staying = items.filter((item) => !leaving.has(item.id));
    if (fits(staying, room, 'with-more')) {
      return layoutOf(items, leaving);
    }
  }
  // Not even the More button and nothing else fits: everything is in the menu.
  return layoutOf(items, new Set(items.map((item) => item.id)));
}

/**
 * The rail's layout, kept up to date as the rail's box changes. Until a ResizeObserver
 * reports a laid-out rail (a test DOM, a hidden window) everything shows.
 */
export function useRailOverflow(
  rail: RefObject<HTMLElement>,
  anchored: RefObject<HTMLElement> | undefined,
  items: readonly RailOverflowItem[],
  active: string | undefined,
): RailLayout {
  const [room, setRoom] = useState<RailRoom | undefined>(undefined);
  useLayoutEffect(() => {
    const element = rail.current ?? undefined;
    if (element === undefined || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const update = () => {
      const next = measureRail(element, anchored?.current ?? undefined);
      // Only a changed room renders again, so a resize that leaves the room as it was costs nothing.
      setRoom((previous) => (previous !== undefined && next !== undefined && sameRoom(previous, next) ? previous : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [rail, anchored]);
  if (room === undefined) {
    return { visible: items.map((item) => item.id), hidden: [] };
  }
  return railOverflow(items, room, active);
}

/** The room in `rail` now, or undefined while it has no height (not laid out). */
export function measureRail(rail: HTMLElement, anchored: HTMLElement | undefined): RailRoom | undefined {
  const heightPx = rail.clientHeight;
  if (heightPx <= 0) {
    return undefined;
  }
  const style = window.getComputedStyle(rail);
  const gapPx = pixels(style.rowGap, RAIL_GAP_PX);
  const paddingPx = pixels(style.paddingTop, 0) + pixels(style.paddingBottom, 0);
  const button = rail.querySelector<HTMLElement>('.rail-btn') ?? undefined;
  const buttonPx = button === undefined || button.offsetHeight <= 0 ? RAIL_BUTTON_PX : button.offsetHeight;
  // A row anchored at the foot (Studio's AI button) keeps its place; its gap goes with it.
  const anchoredPx = anchored === undefined ? 0 : (anchored.offsetHeight > 0 ? anchored.offsetHeight : RAIL_BUTTON_PX) + gapPx;
  const room = { availablePx: heightPx - paddingPx - anchoredPx + gapPx, itemPx: buttonPx + gapPx, separatorPx: RAIL_SEPARATOR_PX + gapPx };
  assert(room.itemPx > 0, 'A measured rail row has height');
  return room;
}

function pixels(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sameRoom(left: RailRoom, right: RailRoom): boolean {
  return left.availablePx === right.availablePx && left.itemPx === right.itemPx && left.separatorPx === right.separatorPx;
}

// Whether `items` and, when asked, the More button fit in the room. The separator
// takes a row's share only while both a panel and a pinned app are shown.
function fits(items: readonly RailOverflowItem[], room: RailRoom, more: 'with-more' | 'without-more'): boolean {
  const panels = items.some((item) => item.group === 'panel');
  const apps = items.some((item) => item.group === 'app');
  const separatorPx = panels && apps ? room.separatorPx : 0;
  const morePx = more === 'with-more' ? room.itemPx : 0;
  return items.length * room.itemPx + separatorPx + morePx <= room.availablePx;
}

// Apps, the last pinned first, then panels from the bottom up.
function leavingOrder(items: readonly RailOverflowItem[]): readonly string[] {
  const apps = items.filter((item) => item.group === 'app').map((item) => item.id);
  const panels = items.filter((item) => item.group === 'panel').map((item) => item.id);
  return [...apps.reverse(), ...panels.reverse()];
}

// The first `count` ids to leave, skipping `active` while another can go instead.
function leavers(order: readonly string[], count: number, active: string | undefined): readonly string[] {
  assert(count > 0, 'Some item leaves');
  assert(count <= order.length, 'No more items leave than there are');
  if (active === undefined || !order.includes(active) || count === order.length) {
    return order.slice(0, count);
  }
  const others = order.filter((id) => id !== active);
  const chosen = others.slice(0, count);
  assert(!chosen.includes(active), 'The active item stays while another can leave');
  return chosen;
}

function layoutOf(items: readonly RailOverflowItem[], leaving: ReadonlySet<string>): RailLayout {
  const visible = items.filter((item) => !leaving.has(item.id)).map((item) => item.id);
  const hidden = items.filter((item) => leaving.has(item.id)).map((item) => item.id);
  assert(visible.length + hidden.length === items.length, 'Every item is either shown or in the menu');
  return { visible, hidden };
}
