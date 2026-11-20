// The geometry of dragging a rail button (railDrag.ts): when a press has become a drag, and which slot of
// which list the pointer is over. Pure numbers in, a slot out, so the rules are tested without a layout.
//
// The two lists are the rail's two zones. The top zone runs from the rail's top to the middle of the gap
// above the bottom list; the bottom zone runs from there down, and an empty bottom list still has a zone
// (the caller draws a placeholder), so a button can always be dropped into it. A pointer outside the rail
// has no slot, which is how a drop outside cancels.
import { assert } from '../../shared/core/assert';
import type { RailGroup } from './railOrder';

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
}

/** Where a drop would land: a list, the button it goes before (undefined for the end), and where to draw the line. */
export interface RailSlot {
  readonly group: RailGroup;
  readonly beforeId: string | undefined;
  /** The insertion line's vertical position, in the same space as the measure. */
  readonly lineY: number;
}

/** The half of the gap between buttons, where the line sits between two of them. */
const RAIL_LINE_INSET_PX = 2;

export function exceedsThreshold(start: RailPoint, point: RailPoint): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) >= RAIL_DRAG_THRESHOLD_PX;
}

/** The slot under `point`, or undefined when the pointer is outside the rail. */
export function slotAt(measure: RailMeasure, point: RailPoint): RailSlot | undefined {
  const { rail } = measure;
  assert(rail.right > rail.left, 'The rail has width');
  assert(rail.bottom > rail.top, 'The rail has height');
  if (point.x < rail.left || point.x > rail.right || point.y < rail.top || point.y > rail.bottom) {
    return undefined;
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
