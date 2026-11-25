// Overlay crowding: an app's anchored labels that land too close together on
// the canvas collapse into one count bubble, so thirty comment pins read as a
// few bubbles rather than an illegible pile (docs/apps.md, "Crowding"). Pure
// geometry over the placements the layer already computed, so it follows
// scroll and zoom exactly as the labels do and tests can pin the thresholds.
//
// Only labels on an element (or a point within one) cluster, only with labels
// of the same app, and only while they ask to (`cluster`, on by default). A
// label on a viewport rectangle is where the app put it on purpose.
//
// A label being pressed or dragged (overlayDrag.ts) never clusters: it must
// stay the element the pointer holds, so passing another label cannot fold it
// into a bubble mid-drag. A label already in a bubble is not draggable until
// zooming in or the app's `cluster: false` sets it apart (docs/apps.md, "Dragging").
//
// Pins (docs/apps.md, "Pins") cluster by the same rules, at the point their tail
// marks, and with the same app's labels: both are markers on the page.
import { assert } from '../../../shared/core/assert';
import { APP_RPC_LIMITS } from '../../../shared/properties/appsRpc';
import type { OverlayPlacement } from './overlayPlacement';

/** Labels collapsed into one bubble. */
export interface OverlayCluster {
  /** Stable while the first member stays first: the expand state is kept by it. */
  readonly key: string;
  readonly appId: string;
  /** Where the bubble is drawn: the first member's point, in overlay-layer pixels. */
  readonly left: number;
  readonly top: number;
  readonly members: readonly OverlayPlacement[];
}

export interface ClusteredOverlays {
  /** Placements drawn as they are: everything that is not in a cluster of two or more. */
  readonly singles: readonly OverlayPlacement[];
  readonly clusters: readonly OverlayCluster[];
}

/** Placements one clustering pass considers: every item's every copy, the most the layer can draw. */
const PLACEMENTS_MAX = APP_RPC_LIMITS.overlayItemsMax * APP_RPC_LIMITS.measureRectsMax * 8;

interface Group {
  readonly appId: string;
  readonly x: number;
  readonly y: number;
  readonly members: OverlayPlacement[];
}

/**
 * Groups each app's clusterable labels whose points lie within `radiusPx` of a
 * group's first label, in placement order; a group of one stays a single.
 * Buckets on a grid of `radiusPx` cells, so each label checks only the nine
 * cells around it and the pass stays linear in the placements.
 */
export function clusterOverlays(
  placements: readonly OverlayPlacement[],
  radiusPx: number,
  held: { readonly appId: string; readonly itemId: string } | undefined,
): ClusteredOverlays {
  assert(radiusPx > 0, 'A cluster radius is positive');
  assert(placements.length <= PLACEMENTS_MAX, 'Placements are bounded by the items and their copies');
  const groups: Group[] = [];
  const cells = new Map<string, Group[]>();
  const order: (OverlayPlacement | Group)[] = [];
  for (const placement of placements) {
    const isHeld = held !== undefined && placement.appId === held.appId && placement.item.id === held.itemId;
    const point = isHeld ? undefined : clusterPoint(placement);
    if (point === undefined) {
      order.push(placement);
      continue;
    }
    const found = nearbyGroup(cells, placement.appId, point, radiusPx);
    if (found === undefined) {
      const group: Group = { appId: placement.appId, x: point.x, y: point.y, members: [placement] };
      const key = cellKey(placement.appId, Math.floor(point.x / radiusPx), Math.floor(point.y / radiusPx));
      cells.set(key, [...(cells.get(key) ?? []), group]);
      groups.push(group);
      order.push(group);
    } else {
      found.members.push(placement);
    }
  }
  const singles: OverlayPlacement[] = [];
  const clusters: OverlayCluster[] = [];
  for (const entry of order) {
    if ('members' in entry) {
      const [first] = entry.members;
      assert(first !== undefined, 'A group starts with the label that made it');
      if (entry.members.length === 1) {
        singles.push(first);
      } else {
        clusters.push({ key: `${entry.appId}:${first.item.id}:${first.copy}`, appId: entry.appId, left: entry.x, top: entry.y, members: entry.members });
      }
    } else {
      singles.push(entry);
    }
  }
  assert(singles.length + clusters.reduce((sum, cluster) => sum + cluster.members.length, 0) === placements.length, 'Clustering keeps every placement once');
  return { singles, clusters };
}

/**
 * The point a label or a pin stands for: where a label is pinned, by its
 * placement on the element, and where a pin's tail points (its anchor point, or
 * the element's top-left corner). Undefined for what does not cluster.
 */
export function clusterPoint(placement: OverlayPlacement): { readonly x: number; readonly y: number } | undefined {
  const { item } = placement;
  if (item.kind !== 'label' && item.kind !== 'pin') {
    return undefined;
  }
  if (!item.cluster) {
    return undefined;
  }
  if (placement.nodeId === undefined) {
    return undefined;
  }
  if (item.kind === 'pin') {
    return { x: placement.left, y: placement.top };
  }
  switch (item.placement) {
    case 'top':
      return { x: placement.left, y: placement.top };
    case 'bottom':
      return { x: placement.left, y: placement.top + placement.height };
    case 'center':
      return { x: placement.left + placement.width / 2, y: placement.top + placement.height / 2 };
    default: {
      const exhaustive: never = item.placement;
      return exhaustive;
    }
  }
}

function nearbyGroup(
  cells: ReadonlyMap<string, readonly Group[]>,
  appId: string,
  point: { readonly x: number; readonly y: number },
  radiusPx: number,
): Group | undefined {
  const column = Math.floor(point.x / radiusPx);
  const row = Math.floor(point.y / radiusPx);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const group of cells.get(cellKey(appId, column + dx, row + dy)) ?? []) {
        if (Math.hypot(group.x - point.x, group.y - point.y) <= radiusPx) {
          return group;
        }
      }
    }
  }
  return undefined;
}

function cellKey(appId: string, column: number, row: number): string {
  return `${appId}\n${column}\n${row}`;
}
