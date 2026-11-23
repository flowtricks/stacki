// The canvas's hover outline, held still for a capture of the window (AI screenshots and recordings).
//
// Why it exists: the person hovers an element, then moves the pointer to the screenshot button. The pointer leaving the
// canvas frame clears the hover outline, so the capture would show the page without the element they meant. The canvas
// therefore remembers the last node the pointer was on (`rememberCanvasHover`, called as the frame reports it), and a
// capture pins it: while pinned, the canvas draws that node as hovered and ignores the frame's hover reports (the
// pointer is elsewhere, or over the region selector), so nothing moves the outline under the picture.
//
// The pin ends when every holder released it (a screenshot's frame; a recording's whole run). A memory older than
// HOVER_MEMORY_MS_MAX is not pinned: a hover from minutes ago is not what the person is pointing at.
import { assert } from '../../shared/core/assert';
import type { DeepHoverNode } from '../../shared/properties/deepOutline';
import type { PseudoLayer } from '../../shared/page/pseudoPath';

/** What the frame said about the hovered node: enough to draw it again (its boxes stay in the canvas's own rect map, and the frame measures it again once it is tracked). */
export interface RememberedHover {
  readonly path: string;
  readonly pseudo: PseudoLayer | undefined;
  readonly occurrence: number;
  readonly deep: DeepHoverNode | undefined;
}

/** How old a remembered hover may be and still be pinned, in milliseconds. */
export const HOVER_MEMORY_MS_MAX = 30_000;
/** Pins held at once: a screenshot and a recording, each once, with room to spare. */
const PINS_MAX = 8;

let remembered: { readonly hover: RememberedHover; readonly atMs: number } | undefined;
let pins = 0;
const listeners = new Set<() => void>();

/** Notes the node the pointer is on, as the frame reported it. Ignored while pinned, so a capture's hover is the one pinned. */
export function rememberCanvasHover(hover: RememberedHover, nowMs: number): void {
  assert(hover.path.length > 0, 'rememberCanvasHover: a hovered node has a path');
  assert(Number.isFinite(nowMs), 'rememberCanvasHover: a finite time');
  if (pins === 0) {
    remembered = { hover, atMs: nowMs };
  }
}

/** Forgets the memory: a new document is a new page, and its paths mean other nodes. */
export function forgetCanvasHover(): void {
  if (pins === 0) {
    remembered = undefined;
  }
}

/** The hover a capture would pin now, or undefined when there is none or it is too old. */
export function rememberedCanvasHover(nowMs: number): RememberedHover | undefined {
  if (remembered === undefined) {
    return undefined;
  }
  if (nowMs - remembered.atMs > HOVER_MEMORY_MS_MAX) {
    return undefined;
  }
  return remembered.hover;
}

/** Pins the remembered hover; the returned call releases this pin (and only once). The hover ends when the last pin is released. */
export function pinCanvasHover(): () => void {
  assert(pins < PINS_MAX, 'pinCanvasHover: pins are released after each capture');
  pins += 1;
  tell();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    assert(pins > 0, 'pinCanvasHover: a release matches a pin');
    pins -= 1;
    tell();
  };
}

export function canvasHoverPinned(): boolean {
  return pins > 0;
}

export function subscribeCanvasHoverPin(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function tell(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}
