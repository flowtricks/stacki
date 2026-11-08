import { useSyncExternalStore } from 'react';
import { assert } from '../../shared/core/assert';

// Whether an editor side panel is being dragged to a new width. The canvas reads it to
// hold the page's layout width for the length of the drag: a page that re-measures on
// every width change (text split into lines, for one) would otherwise re-lay out each frame.
export type PanelDragPhase = 'idle' | 'dragging';

// One listener per mounted canvas; a handful at most. The cap catches a leaked subscription.
const LISTENERS_MAX = 64;
const listeners = new Set<() => void>();
let phase: PanelDragPhase = 'idle';

export function panelDragPhase(): PanelDragPhase {
  return phase;
}

export function setPanelDragPhase(next: PanelDragPhase): void {
  if (next === phase) {
    return;
  }
  phase = next;
  for (const listener of [...listeners]) {
    listener();
  }
  assert(phase === next, 'A panel drag listener must not change the phase it is told about');
}

export function usePanelDragPhase(): PanelDragPhase {
  return useSyncExternalStore(subscribePanelDragPhase, panelDragPhase, panelDragPhase);
}

function subscribePanelDragPhase(listener: () => void): () => void {
  assert(listeners.size < LISTENERS_MAX, 'Too many panel drag listeners');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
