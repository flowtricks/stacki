// Canvas coordinates for Design mode: screen ↔ canvas ↔ frame, and what sits under a point. A frame's
// document never scrolls (the frame is as tall as its page), so a frame's local coordinates are its
// document's own client coordinates and `elementFromPoint` answers directly.
import type { DesignFrameRecord } from '../model/designTypes';
import type { DesignView } from '../runtime/designSession';
import { frameDocument } from '../runtime/designSession';
import { frameHeightPx } from './DesignFrameView';
import { isSelectable } from '../model/designSelect';

export interface Point {
  readonly xPx: number;
  readonly yPx: number;
}

/** A pointer's place on the canvas, from its client position and the canvas element's box. */
export function canvasPoint(clientX: number, clientY: number, host: DOMRect, view: DesignView): Point {
  return { xPx: (clientX - host.left - view.xPx) / view.scale, yPx: (clientY - host.top - view.yPx) / view.scale };
}

export interface FrameHit {
  readonly frame: DesignFrameRecord;
  readonly local: Point;
}

/** The frame under a canvas point, the topmost when frames overlap. */
export function frameAt(frames: readonly DesignFrameRecord[], point: Point): FrameHit | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame === undefined) {
      continue;
    }
    const local = { xPx: point.xPx - frame.xPx, yPx: point.yPx - frame.yPx };
    if (local.xPx >= 0 && local.yPx >= 0 && local.xPx <= frame.widthPx && local.yPx <= frameHeightPx(frame)) {
      return { frame, local };
    }
  }
  return undefined;
}

/** The element of a frame's page under a local point (never the root or the head), or undefined. */
export function elementAt(hit: FrameHit): Element | undefined {
  const document = frameDocument(hit.frame.id);
  const element = document?.elementFromPoint(hit.local.xPx, hit.local.yPx) ?? undefined;
  if (element === undefined || element === null) {
    return document?.body ?? undefined;
  }
  return isSelectable(element) ? element : (document?.body ?? undefined);
}

/** Zooms around a screen point, keeping what is under it in place. */
export function zoomAround(view: DesignView, nextScale: number, anchorX: number, anchorY: number): DesignView {
  const ratio = nextScale / view.scale;
  return { xPx: anchorX - (anchorX - view.xPx) * ratio, yPx: anchorY - (anchorY - view.yPx) * ratio, scale: nextScale };
}

/** The view that fits every frame (at their measured heights, the tops when very tall) into a box. */
export function fitView(frames: readonly DesignFrameRecord[], widthPx: number, heightPx: number): DesignView {
  if (frames.length === 0) {
    return { xPx: 40, yPx: 40, scale: 1 };
  }
  const left = Math.min(...frames.map((frame) => frame.xPx));
  const top = Math.min(...frames.map((frame) => frame.yPx));
  const right = Math.max(...frames.map((frame) => frame.xPx + frame.widthPx));
  const bottom = Math.max(...frames.map((frame) => frame.yPx + Math.min(frameHeightPx(frame), frame.viewportHeightPx * 1.6)));
  const margin = 64;
  const scale = Math.max(0.05, Math.min(1, (widthPx - margin * 2) / Math.max(1, right - left), (heightPx - margin * 2) / Math.max(1, bottom - top)));
  return { xPx: margin - left * scale + Math.max(0, (widthPx - margin * 2 - (right - left) * scale) / 2), yPx: margin - top * scale, scale };
}
