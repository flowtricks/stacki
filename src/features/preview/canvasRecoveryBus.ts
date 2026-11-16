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
