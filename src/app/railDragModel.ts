// The geometry of dragging a rail button (railDrag.ts): when a press has become a drag, and which slot of
// which list the pointer is over. Pure numbers in, a slot out, so the rules are tested without a layout.
//
// The two lists are the rail's two zones. The top zone runs from the rail's top to the middle of the gap
// above the bottom list; the bottom zone runs from there down, and an empty bottom list still has a zone
// (the caller draws a placeholder), so a button can always be dropped into it. A pointer outside the rail
// has no slot, which is how a drop outside cancels.
//
// Settings is a third place (railOrder.ts): while a movable item is dragged, the middle of the Settings button is a
// target of its own (a drop there makes the item Settings' last row, and a rest there opens the panel, railDrag.ts),
// and the Settings panel's root list, once it is on screen, has slots between its rows like a rail list.
import { assert } from '../../shared/core/assert';
import { moveIntoSettings, placeRailItem, type RailContainer, type RailGroup, type RailOrder } from './railOrder';

/** How far a press must move before it is a drag; the same as the other drags, so a click still opens the panel. */
export const RAIL_DRAG_THRESHOLD_PX = 6;

export interface RailPoint {
  readonly x: number;
  readonly y: number;
}

/** A button's vertical extent. */
export interface RailRow {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

export interface RailMeasure {
  readonly rail: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
  /** The draggable buttons of each list, top to bottom, the dragged one included. */
  readonly rows: Readonly<Record<RailGroup, readonly RailRow[]>>;
  /** Where the top list's column ends: the foot of its last row, pinned apps and More included. */
  readonly topEndY: number;
  /** The top of the bottom list's zone: its first button, or the placeholder that stands in for it. */
  readonly bottomStartY: number;
  /** The Settings button's extent, present only while the dragged item may go into Settings. */
  readonly settingsButton?: { readonly top: number; readonly bottom: number } | undefined;
  /** The Settings panel's root list, present only while it is on screen and the dragged item may go into it. */
  readonly settings?: RailSettingsZone | undefined;
}

/** The Settings panel's root list: its box and its rows, top to bottom, the dragged one included. */
export interface RailSettingsZone {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly rows: readonly RailRow[];
}

/**
 * Where a drop would land: a list, the item it goes before (undefined for the end) and where to draw the line;
 * or the Settings button itself, which takes the item as Settings' last row and draws no line.
 */
export type RailSlot =
  | {
      readonly group: RailContainer;
      readonly beforeId: string | undefined;
      /** The insertion line's vertical position, in the same space as the measure. */
      readonly lineY: number;
    }
  | { readonly group: 'settingsButton' };

/** The share of the Settings button's height, at each end, that still reorders around it rather than dropping in. */
const SETTINGS_BUTTON_EDGE_SHARE = 0.25;

/** The half of the gap between buttons, where the line sits between two of them. */
const RAIL_LINE_INSET_PX = 2;

/** The order a drop on `slot` makes: the Settings button takes the item as Settings' last row. */
export function orderAfterDrop(order: RailOrder, id: string, slot: RailSlot): RailOrder {
  if (slot.group === 'settingsButton') {
    return moveIntoSettings(order, id);
  }
  return placeRailItem(order, id, slot.group, slot.beforeId);
}

export function exceedsThreshold(start: RailPoint, point: RailPoint): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) >= RAIL_DRAG_THRESHOLD_PX;
}

/** The slot under `point`, or undefined when the pointer is outside the rail. */
export function slotAt(measure: RailMeasure, point: RailPoint): RailSlot | undefined {
  const { rail } = measure;
  assert(rail.right > rail.left, 'The rail has width');
  assert(rail.bottom > rail.top, 'The rail has height');
  const settings = measure.settings;
  if (settings !== undefined && inside(settings, point)) {
    return settingsSlotAt(settings, point);
  }
  if (point.x < rail.left || point.x > rail.right || point.y < rail.top || point.y > rail.bottom) {
    return undefined;
  }
  const button = measure.settingsButton;
  if (button !== undefined) {
    assert(button.bottom > button.top, 'The Settings button has height');
    const edge = (button.bottom - button.top) * SETTINGS_BUTTON_EDGE_SHARE;
    if (point.y > button.top + edge && point.y < button.bottom - edge) {
      return { group: 'settingsButton' };
    }
  }
  const boundaryY = (measure.topEndY + measure.bottomStartY) / 2;
  const group: RailGroup = point.y < boundaryY ? 'top' : 'bottom';
  const rows = measure.rows[group];
  for (const row of rows) {
    if (point.y < (row.top + row.bottom) / 2) {
      return { group, beforeId: row.id, lineY: row.top - RAIL_LINE_INSET_PX };
    }
  }
  const last = rows.at(-1);
  if (last !== undefined) {
    return { group, beforeId: undefined, lineY: last.bottom + RAIL_LINE_INSET_PX };
  }
  // An empty list: the line sits at the zone's head.
  return { group, beforeId: undefined, lineY: group === 'top' ? rail.top + RAIL_LINE_INSET_PX : measure.bottomStartY - RAIL_LINE_INSET_PX };
}

// The slot in the Settings root list under `point`, which is inside the list's box: before the row whose middle
// is below the pointer, or the end (the head of an empty list).
function settingsSlotAt(zone: RailSettingsZone, point: RailPoint): RailSlot {
  assert(zone.bottom >= zone.top, 'The Settings list has a box');
  for (const row of zone.rows) {
    if (point.y < (row.top + row.bottom) / 2) {
      return { group: 'settings', beforeId: row.id, lineY: row.top - RAIL_LINE_INSET_PX / 2 };
    }
  }
  const last = zone.rows.at(-1);
  return { group: 'settings', beforeId: undefined, lineY: last === undefined ? zone.top + RAIL_LINE_INSET_PX : last.bottom + RAIL_LINE_INSET_PX / 2 };
}

function inside(box: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }, point: RailPoint): boolean {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}
