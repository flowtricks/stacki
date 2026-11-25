// The canvas's outline mode, as the editor holds it (shared/properties/deepOutline.ts).
// The preview layer sits below the Apps feature, so the Apps runtime sets the mode
// here and the canvas reads it: the frame is told on every change and again when
// a new document announces itself ready (Desktop previewRuntime.ts, Studio
// usePreview.ts), and the outlines label a deep hover from it (PreviewOverlays.tsx).
import { assert } from '../../shared/core/assert';
import { HIGHLIGHT_MESSAGE, OUTLINE_MODE_MESSAGE, type CanvasHighlight, type CanvasOutlineMode, type DeepHoverNode } from '../../shared/properties/deepOutline';
import { tellCanvas } from '../editor/canvasQuery';

let mode: CanvasOutlineMode = 'normal';
// An app's highlight (`canvas.highlight`): drawn in the hover outline's place, over any hover,
// until the app clears it or the runtime does (appsRuntime.ts). Display only: no selection.
let highlight: CanvasHighlight | undefined;
const highlightListeners = new Set<() => void>();
const listeners = new Set<() => void>();

/** Sets the mode and tells the canvas; nothing happens when it is the mode already. */
export function setCanvasOutlineMode(next: CanvasOutlineMode): void {
  if (next === mode) {
    return;
  }
  mode = next;
  resendCanvasOutlineMode();
  for (const listener of [...listeners]) {
    listener();
  }
  assert(mode === next, 'setCanvasOutlineMode: the mode is the one set');
}

export function canvasOutlineMode(): CanvasOutlineMode {
  return mode;
}

/** Tells the canvas frame the mode: on a change, and to a document that just loaded in the editor's own mode. */
export function resendCanvasOutlineMode(): void {
  tellCanvas({ type: OUTLINE_MODE_MESSAGE, mode });
  tellCanvas({ type: HIGHLIGHT_MESSAGE, highlight });
}

export function subscribeCanvasOutlineMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// How the latest deep hover's node is labelled, by its canvas path: the frame says it
// with the hover (previewRuntime.ts), and the outline reads it to draw the node as the
// editor draws one with its component open (PreviewOverlays.tsx).
let deepHover: { readonly path: string; readonly node: DeepHoverNode } | undefined;

/** Notes the canvas's latest hover: a deep one with its node, or any other, which clears it. */
export function noteDeepHover(path: string | undefined, node: DeepHoverNode | undefined): void {
  deepHover = path === undefined || node === undefined ? undefined : { path, node };
  assert(deepHover === undefined || deepHover.node.label.length > 0, 'noteDeepHover: a deep hover labels its node');
}

/** The node a deep hover or the highlight at `path` names, when the latest is that one. */
export function deepHoverNode(path: string): DeepHoverNode | undefined {
  if (highlight?.path === path) {
    return highlight.node;
  }
  return deepHover?.path === path ? deepHover.node : undefined;
}

/** Shows a highlight, or clears it with undefined, and tells the canvas (Studio's frame draws it). */
export function setCanvasHighlight(next: CanvasHighlight | undefined): void {
  if (next === highlight) {
    return;
  }
  highlight = next;
  tellCanvas({ type: HIGHLIGHT_MESSAGE, highlight: next });
  for (const listener of [...highlightListeners]) {
    listener();
  }
  assert(highlight === next, 'setCanvasHighlight: the highlight is the one set');
}

export function canvasHighlight(): CanvasHighlight | undefined {
  return highlight;
}

export function subscribeCanvasHighlight(listener: () => void): () => void {
  highlightListeners.add(listener);
  return () => {
    highlightListeners.delete(listener);
  };
}
