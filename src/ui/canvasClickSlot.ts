// Where a canvas click goes while a Stacki app captures the canvas
// (docs/apps.md, "Canvas clicks"). The canvas's click handlers live in the
// preview layer, below the Apps feature, so they cannot import it; the Apps host
// installs its capture here while the editor is open, and Desktop's canvas
// (src/features/preview/previewRuntime.ts) and Studio's preview ask through this
// one seam before they select. With nothing installed, or no app capturing,
// every click selects exactly as before.
import { assert } from '../../shared/core/assert';
import { APP_RPC_LIMITS } from '../../shared/properties/appsRpc';

/** A measured box in the canvas viewport, in the page's CSS pixels. */
export interface CanvasClickBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A click as the canvas frame reports it: the marker path it landed on, which copy, and where. */
export interface CanvasClickReport {
  /** The full canvas path (`<file>|` scope included), or undefined over markup no node owns. */
  readonly path: string | undefined;
  readonly occurrence: number;
  /** The pointer, in the canvas viewport's CSS pixels; undefined from a frame that does not say. */
  readonly x: number | undefined;
  readonly y: number | undefined;
  /** The box of the copy clicked, when the frame measured it. */
  readonly box: CanvasClickBox | undefined;
}

/** What the Apps host installs. */
export interface CanvasClickHandler {
  /** Whether an app captures canvas clicks now. */
  readonly capturing: () => boolean;
  /** Whether an app observes canvas clicks now: the editor handles each click, and the app hears it too. */
  readonly observing: () => boolean;
  /** Hands a click to the capturing app. Called only while `capturing()` is true. */
  readonly take: (click: CanvasClickReport) => void;
}

let handler: CanvasClickHandler | undefined;

/** Installs the Apps host's handler, or removes it with undefined. */
export function setCanvasClickHandler(next: CanvasClickHandler | undefined): void {
  handler = next;
}

/** Whether a canvas click or double click belongs to an app now, not to selection. */
export function canvasClicksCaptured(): boolean {
  return handler?.capturing() === true;
}

/**
 * How long an observed click waits before it reaches the app: a second click within it is a double
 * click, which enters a component at once in the editor and reaches the app as no placement at all.
 * About the platform's own double-click interval.
 */
export const OBSERVE_DOUBLE_CLICK_MS = 350;

let observed: ReturnType<typeof setTimeout> | undefined;

/**
 * Hands a click the editor is also handling to the observing app, once the double-click window has
 * passed; false when no app observes. A double click (`noteCanvasOpen`) or another click inside the
 * window drops the waiting one, so a double click never reaches the app as a placement.
 */
export function observeCanvasClick(click: CanvasClickReport): boolean {
  if (handler === undefined || !handler.observing()) {
    return false;
  }
  const observer = handler;
  clearTimeout(observed);
  observed = setTimeout(() => {
    observed = undefined;
    if (observer.observing()) {
      observer.take(click);
    }
  }, OBSERVE_DOUBLE_CLICK_MS);
  return true;
}

/** The canvas opened a node (a double click): an observed click still waiting is not a placement. */
export function noteCanvasOpen(): void {
  clearTimeout(observed);
  observed = undefined;
}

/** Gives the click to the capturing app; false when none captures, and the canvas selects as usual. */
export function takeCanvasClick(click: CanvasClickReport): boolean {
  if (handler === undefined || !handler.capturing()) {
    return false;
  }
  assert(Number.isSafeInteger(click.occurrence), 'A click names a whole copy');
  assert(click.occurrence >= 0, 'A click names a copy from the first');
  handler.take(click);
  return true;
}

/** A box a frame reported, or undefined when it is not one: frames run project code, so a box is checked before use. */
export function canvasClickBox(input: unknown): CanvasClickBox | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const x = coordinateOf(Reflect.get(input, 'x'));
  const y = coordinateOf(Reflect.get(input, 'y'));
  const width = coordinateOf(Reflect.get(input, 'w'));
  const height = coordinateOf(Reflect.get(input, 'h'));
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  if (width < 0 || height < 0) {
    return undefined;
  }
  return { x, y, w: width, h: height };
}

/** A pointer coordinate a frame reported, or undefined when it is not a finite canvas coordinate. */
export function coordinateOf(input: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return undefined;
  }
  return Math.abs(input) <= APP_RPC_LIMITS.coordinatePxMax ? input : undefined;
}
