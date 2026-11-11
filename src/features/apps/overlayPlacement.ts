// Where each app overlay item is drawn: pure geometry, so tests can pin it. An
// item anchored to an element takes the boxes the canvas measured for that
// element's path (one per place it renders, or the one occurrence asked for);
// the canvas re-measures on scroll and resize, so the items follow. An item on
// a viewport rectangle is drawn where it says. Everything scales with the
// canvas's zoom, as the selection outlines do.
import { assert } from '../../../shared/core/assert';
import { APP_RPC_LIMITS, type AppNodeRef, type AppOverlayItem, type AppPoint } from '../../../shared/properties/appsRpc';
import type { DragPoint } from './overlayDrag';

/** A measured box, as the canvas reports it (src/features/preview/outlineBoxes.ts). */
export interface MeasuredBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type MeasuredRects = Readonly<Record<string, readonly MeasuredBox[] | undefined>>;

export interface OverlayPlacement {
  readonly appId: string;
  readonly item: AppOverlayItem;
  /** Where to draw, in overlay-layer pixels (already scaled). */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** The element the item is on, for its click event. */
  readonly nodeId: string | undefined;
  /** Which place of a repeated element this is: keys stay stable across measurements. */
  readonly copy: number;
}

/** Boxes drawn per item at most: a loop's thousand copies draw the first few hundred. */
const COPIES_MAX = 500;

/** Where anchored refs are drawn, once resolved (nodeRefs.ts NodeRefTargets): each one's canvas path and copy. */
export interface RefTargetLookup {
  readonly target: (ref: AppNodeRef) => { readonly path: string; readonly occurrence: number } | undefined;
}

/** No ref resolves: a host or test without refs. */
export const NO_REF_TARGETS: RefTargetLookup = { target: () => undefined };

/** The canvas paths app overlays anchor to, which the canvas must measure. */
export function overlayAnchorPaths(
  overlays: ReadonlyMap<string, readonly AppOverlayItem[]>,
  measuring: readonly string[],
  refTarget: RefTargetLookup,
  pathFor: (nodeId: string) => string | undefined,
): readonly string[] {
  const paths = new Set<string>();
  // Elements `node.measure` waits on (overlayMeasure.ts), bounded by measureRequestsMax.
  assert(measuring.length <= APP_RPC_LIMITS.measureRequestsMax, 'Measure requests are bounded');
  for (const nodeId of measuring) {
    const path = pathFor(nodeId);
    if (path !== undefined) {
      paths.add(path);
    }
  }
  for (const items of overlays.values()) {
    for (const item of items) {
      const path = 'nodeId' in item.anchor ? pathFor(item.anchor.nodeId) : 'ref' in item.anchor ? refTarget.target(item.anchor.ref)?.path : undefined;
      if (path !== undefined) {
        paths.add(path);
      }
    }
  }
  assert(paths.size <= overlays.size * APP_RPC_LIMITS.overlayAnchorsMax + measuring.length, 'Anchors are bounded per app');
  return [...paths];
}

export function placeOverlays(
  overlays: ReadonlyMap<string, readonly AppOverlayItem[]>,
  rects: MeasuredRects,
  scale: number,
  refTarget: RefTargetLookup,
  pathFor: (nodeId: string) => string | undefined,
): readonly OverlayPlacement[] {
  assert(scale > 0, 'The canvas scale is positive');
  const placements: OverlayPlacement[] = [];
  for (const [appId, items] of overlays) {
    for (const item of items) {
      placements.push(...placeItem(appId, item, rects, scale, refTarget, pathFor));
    }
  }
  return placements;
}

/** A point within a measured box, in the canvas's CSS pixels: `at` runs 0–1 across and down the box. */
export function anchorPoint(box: MeasuredBox, at: AppPoint): { readonly x: number; readonly y: number } {
  assert(at.x >= 0, 'A point starts at the left edge');
  assert(at.y <= 1, 'A point ends at the bottom edge');
  return { x: box.x + at.x * Math.max(0, box.w), y: box.y + at.y * Math.max(0, box.h) };
}

/**
 * A pointer in client pixels, in the overlay layer's pixels and in the canvas
 * viewport's: the layer is the canvas drawn at `scale` from `origin` (its
 * top-left corner on screen), so a drag reports what a click there would.
 */
export function overlayPointerPoint(
  origin: { readonly left: number; readonly top: number },
  client: { readonly x: number; readonly y: number },
  scale: number,
): DragPoint {
  assert(scale > 0, 'The canvas scale is positive');
  const layerX = client.x - origin.left;
  const layerY = client.y - origin.top;
  const point = { layerX, layerY, x: layerX / scale, y: layerY / scale };
  assert(Number.isFinite(point.x), 'A pointer is finite across the canvas');
  assert(Number.isFinite(point.y), 'A pointer is finite down the canvas');
  return point;
}

/** A wheel over the overlay layer, as the canvas frame takes it (electron/preload/frameAppScroll.ts `avb:app-wheel`). */
export interface OverlayWheelMessage {
  readonly type: 'avb:app-wheel';
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/**
 * The wheel the canvas frame scrolls by for one that landed on an overlay item:
 * the point in the canvas viewport's CSS pixels, as a drag maps it, and the
 * deltas as they came. The deltas are not divided by the zoom: a wheel over the
 * frame itself moves the page by the same CSS pixels whatever the zoom.
 */
export function overlayWheelMessage(
  origin: { readonly left: number; readonly top: number },
  wheel: Pick<WheelEvent, 'clientX' | 'clientY' | 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  scale: number,
): OverlayWheelMessage {
  const point = overlayPointerPoint(origin, { x: wheel.clientX, y: wheel.clientY }, scale);
  const message: OverlayWheelMessage = {
    type: 'avb:app-wheel',
    x: point.x,
    y: point.y,
    deltaX: wheel.deltaX,
    deltaY: wheel.deltaY,
    deltaMode: wheel.deltaMode,
    ctrlKey: wheel.ctrlKey,
    shiftKey: wheel.shiftKey,
    altKey: wheel.altKey,
    metaKey: wheel.metaKey,
  };
  assert(Number.isFinite(message.deltaX), 'A wheel moves a finite way across');
  assert(Number.isFinite(message.deltaY), 'A wheel moves a finite way down');
  return message;
}

function placeItem(
  appId: string,
  item: AppOverlayItem,
  rects: MeasuredRects,
  scale: number,
  refTarget: RefTargetLookup,
  pathFor: (nodeId: string) => string | undefined,
): readonly OverlayPlacement[] {
  const anchor = item.anchor;
  if ('rect' in anchor) {
    const { x, y, width, height } = anchor.rect;
    return [{ appId, item, left: x * scale, top: y * scale, width: width * scale, height: height * scale, nodeId: undefined, copy: 0 }];
  }
  // A ref names one copy, wherever it sits inside component instances; its click names no open-page id.
  const resolved = 'ref' in anchor ? refTarget.target(anchor.ref) : undefined;
  const path = 'ref' in anchor ? resolved?.path : pathFor(anchor.nodeId);
  const occurrence = 'ref' in anchor ? resolved?.occurrence : anchor.occurrence;
  const nodeId = 'ref' in anchor ? undefined : anchor.nodeId;
  const boxes = path === undefined ? undefined : rects[path];
  if (boxes === undefined || boxes.length === 0) {
    return []; // Not rendered, or not measured yet: nothing to draw until it is.
  }
  if ('ref' in anchor && occurrence === undefined) {
    return []; // A ref that has not resolved yet.
  }
  const chosen = occurrence === undefined ? boxes.slice(0, COPIES_MAX) : boxes.slice(occurrence, occurrence + 1);
  const at = anchor.at;
  if (at !== undefined) {
    // A point within the box, from this same measurement: it follows scroll, resize and zoom with the box.
    return chosen.map((box, index) => {
      const point = anchorPoint(box, at);
      return { appId, item, left: point.x * scale, top: point.y * scale, width: 0, height: 0, nodeId, copy: occurrence ?? index };
    });
  }
  return chosen.map((box, index) => ({
    appId,
    item,
    left: box.x * scale,
    top: box.y * scale,
    width: Math.max(0, box.w * scale),
    height: Math.max(0, box.h * scale),
    nodeId,
    copy: occurrence ?? index,
  }));
}
