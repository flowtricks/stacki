// Who hears what the canvas recovery controller (canvasRecovery.ts) found. The controller is built where the dev
// server's address is known (the lifecycle hooks) and the notice that says "the page stopped compiling" lives in the
// editing hooks, which have the undo; neither owns the other, so the news passes through here. Module state, because
// there is one canvas.
import { assert } from '../../../shared/core/assert';
import type { CanvasRecoveryEvent } from './canvasRecovery';

/** Listeners at once: the notice owner and a test; more means a leak. */
export const CANVAS_RECOVERY_LISTENERS_MAX = 8;

type Listener = (event: CanvasRecoveryEvent) => void;
const listeners = new Set<Listener>();

export function publishCanvasRecovery(event: CanvasRecoveryEvent): void {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

export function onCanvasRecovery(listener: Listener): () => void {
  assert(listeners.size < CANVAS_RECOVERY_LISTENERS_MAX, 'Canvas recovery listeners are released when their owner goes');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What the canvas frame said about the dev server's error overlay (electron/preload/frameErrorOverlay.ts): it came
 * up over the page, with its words, or it went away. The frame's messages are read where the canvas lives
 * (previewRuntime.ts) and the controller lives in the lifecycle hooks, so this news passes through here too.
 */
export type FrameOverlayReport = { readonly kind: 'shown'; readonly message: string | undefined } | { readonly kind: 'cleared' };

type OverlayListener = (report: FrameOverlayReport) => void;
const overlayListeners = new Set<OverlayListener>();

export function reportFrameOverlay(report: FrameOverlayReport): void {
  for (const listener of [...overlayListeners]) {
    listener(report);
  }
}

export function onFrameOverlay(listener: OverlayListener): () => void {
  assert(overlayListeners.size < CANVAS_RECOVERY_LISTENERS_MAX, 'Frame overlay listeners are released when their owner goes');
  overlayListeners.add(listener);
  return () => {
    overlayListeners.delete(listener);
  };
}
