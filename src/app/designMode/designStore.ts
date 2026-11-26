// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the renderer's view of the session.
//
// Main owns the session (electron/handlers/designMode); this holds its last answered state, the frames' pictures
// for the board, and what the window is doing about it, so the Modes menu, the bar and the board read one value.
// Framework-free; React reads it through `useDesignStore`.
import { useSyncExternalStore } from 'react';
import type { DesignFrameId, DesignSessionState } from '../../../shared/ipc/designSession';

export type DesignPhase = 'idle' | 'entering' | 'working' | 'leaving';

export interface DesignView {
  readonly session: DesignSessionState;
  readonly phase: DesignPhase;
  readonly board: 'closed' | 'open';
  readonly images: ReadonlyMap<DesignFrameId, string>;
}

/** Mounted readers; a leak past this is a bug, not growth. */
const LISTENERS_MAX = 50;

let view: DesignView = { session: { kind: 'off' }, phase: 'idle', board: 'closed', images: new Map() };
const listeners = new Set<() => void>();

export function designView(): DesignView {
  return view;
}

export function updateDesignView(change: (current: DesignView) => DesignView): void {
  const next = change(view);
  if (next === view) {
    return;
  }
  if (next.session.kind === 'off' && next.board === 'open') {
    throw new Error('Assertion failed: updateDesignView: the board opens only while the mode is on');
  }
  view = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeDesignView(listener: () => void): () => void {
  if (listeners.size >= LISTENERS_MAX) {
    throw new Error('Assertion failed: subscribeDesignView: listeners are bounded');
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the Modes menu shows Design mode as on: on, or on its way. */
export function isDesignModeActive(): boolean {
  return view.session.kind === 'on' || view.phase === 'entering';
}

export function useDesignView(): DesignView {
  return useSyncExternalStore(subscribeDesignView, designView, designView);
}
