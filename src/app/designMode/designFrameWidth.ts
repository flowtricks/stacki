// Design mode (experimental, removable: docs/design-mode/REMOVE.md): how wide a frame is.
//
// A frame has no width of its own until one is given: it is as wide as the canvas it was pictured on. The first
// resize gives every frame one, and from then on the shown frame and the editor's canvas under Design mode are one
// width. The canvas is asked for the shown frame's width, so media queries answer in the real page and the style
// panel's breakpoint follows, as in the normal editor; a width the canvas is given by anything else (a media query
// picked in the style panel, Base) becomes the shown frame's. This file is the pure half of that.
import { assert } from '../../../shared/core/assert';
import { DESIGN_SESSION_LIMITS, type DesignFrameId, type DesignFrameView, type DesignPlace } from '../../../shared/ipc/designSession';
import type { DesignSnapshot } from '../../../shared/ipc/designSnapshot';

/** A frame with no document yet is drawn this large. */
export const EMPTY_FRAME = { widthPx: 1_440, heightPx: 900 } as const;

/** A width a frame may be given: whole pixels within the limits. */
export function clampFrameWidth(widthPx: number): number {
  assert(Number.isFinite(widthPx), 'A frame width is a number');
  return Math.min(DESIGN_SESSION_LIMITS.frameWidthPxMax, Math.max(DESIGN_SESSION_LIMITS.frameWidthPxMin, Math.round(widthPx)));
}

/** The width a frame is drawn at: its own, else its picture's, else an empty frame's. */
export function frameWidthPx(frame: Pick<DesignFrameView, 'widthPx'>, snapshot: Pick<DesignSnapshot, 'viewportWidthPx'> | undefined): number {
  if (frame.widthPx !== undefined) {
    return frame.widthPx;
  }
  return snapshot === undefined || snapshot.viewportWidthPx < 1 ? EMPTY_FRAME.widthPx : snapshot.viewportWidthPx;
}

/** The side of a frame being dragged. */
export type DesignEdge = 'w' | 'e';

export interface ResizedFrame {
  readonly widthPx: number;
  readonly at: DesignPlace;
}

/**
 * A frame after `edge` is dragged `deltaPx` canvas pixels to the right. The other edge stays where it is, so a drag
 * of the left edge moves the frame as it widens it.
 */
export function resizedFrame(start: ResizedFrame, edge: DesignEdge, deltaPx: number): ResizedFrame {
  const widthPx = clampFrameWidth(start.widthPx + (edge === 'e' ? deltaPx : -deltaPx));
  if (edge === 'e') {
    return { widthPx, at: start.at };
  }
  const limit = DESIGN_SESSION_LIMITS.placePxMax;
  const x = Math.min(limit, Math.max(-limit, Math.round(start.at.x + start.widthPx - widthPx)));
  return { widthPx, at: { x, y: start.at.y } };
}

/** The shown frame and the editor's canvas as last seen together. */
export interface WidthSync {
  readonly frame: DesignFrameId;
  /** The frame's width. */
  readonly widthPx: number;
  /** The canvas's rendered width. */
  readonly canvasPx: number;
  /** Whether the canvas has been asked for the frame's width and not yet drawn it. */
  readonly step: 'asked' | 'together';
}

export type WidthSyncAction =
  | { readonly kind: 'none' }
  /** Ask the canvas for the shown frame's width. */
  | { readonly kind: 'request'; readonly widthPx: number }
  /** The canvas has just taken the frame's width: picture it. */
  | { readonly kind: 'picture' }
  /** The canvas was given another width by something else: the shown frame takes it. */
  | { readonly kind: 'adopt'; readonly widthPx: number };

export interface WidthSyncInput {
  /** The shown frame, and its own width when it has one. Undefined while no frame is settled on the canvas. */
  readonly shown: { readonly id: DesignFrameId; readonly widthPx: number | undefined } | undefined;
  /** Undefined while the canvas is not measured. */
  readonly canvasPx: number | undefined;
}

export function syncFrameWidth(
  previous: WidthSync | undefined,
  input: WidthSyncInput,
): { readonly next: WidthSync | undefined; readonly action: WidthSyncAction } {
  const { shown, canvasPx } = input;
  if (shown?.widthPx === undefined || canvasPx === undefined) {
    return { next: undefined, action: { kind: 'none' } };
  }
  const widthPx = shown.widthPx;
  const canvas = Math.round(canvasPx);
  const seen = { frame: shown.id, widthPx, canvasPx: canvas };
  const together = { next: { ...seen, step: 'together' }, action: { kind: 'picture' } } as const;
  const ask = { next: { ...seen, step: 'asked' }, action: { kind: 'request', widthPx } } as const;
  if (previous?.frame !== shown.id || previous.widthPx !== widthPx) {
    return canvas === widthPx ? together : ask;
  }
  if (previous.canvasPx === canvas) {
    return { next: previous, action: { kind: 'none' } };
  }
  if (previous.step === 'asked') {
    // Another width on the way to the one asked: it is asked again.
    return canvas === widthPx ? together : ask;
  }
  const adopted = clampFrameWidth(canvas);
  const next: WidthSync = { frame: shown.id, widthPx: adopted, canvasPx: canvas, step: 'together' };
  return { next, action: adopted === widthPx ? { kind: 'picture' } : { kind: 'adopt', widthPx: adopted } };
}
