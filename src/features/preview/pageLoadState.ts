// Whether any canvas frame is waiting for its page, shared between the frames (which know) and the
// address bar in the title bar (which draws the thin loading line). A frame reports through a start and an
// end keyed by its own id, so two frames loading at once keep the line up until both are ready, and a frame
// that unmounts mid-load ends its own report instead of leaving the line stuck.
//
// Bounded: at most PAGE_LOAD_FRAMES_MAX ids are tracked; the canvas shows a handful of breakpoint frames,
// and a report past the cap is ignored rather than growing the set.

import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';

/** The most frames tracked at once: the all-breakpoints canvas draws a handful. */
export const PAGE_LOAD_FRAMES_MAX = 16;

const loadingIds = new Set<string>();
const listeners = new Set<() => void>();
let loading = false;

function publish(): void {
  const next = loadingIds.size > 0;
  if (next === loading) {
    return;
  }
  loading = next;
  for (const listener of listeners) {
    listener();
  }
}

/** A frame started waiting for its page. */
export function pageLoadStart(frameId: string): void {
  assert(frameId.length > 0, 'pageLoadStart: a frame id is never empty');
  if (loadingIds.size < PAGE_LOAD_FRAMES_MAX) {
    loadingIds.add(frameId);
  }
  assert(loadingIds.size <= PAGE_LOAD_FRAMES_MAX, 'pageLoadStart: the tracked frames are bounded');
  publish();
}

/** A frame is ready, or gone. Ending a frame that never started is a no-op. */
export function pageLoadEnd(frameId: string): void {
  assert(frameId.length > 0, 'pageLoadEnd: a frame id is never empty');
  loadingIds.delete(frameId);
  publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether any frame is still waiting for its page. */
export function usePageLoading(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => loading,
    () => false,
  );
}
