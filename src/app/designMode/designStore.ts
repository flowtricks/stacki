// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the renderer's view of the session.
//
// Main owns the session (electron/handlers/designMode); this holds its last answered state, the documents the
// canvas's frames show, what is selected on the canvas, and what the window is doing about it, so the header
// button, the bar and the canvas read one value. Framework-free; React reads it through `useDesignView`.
import { useSyncExternalStore } from 'react';
import { DESIGN_SESSION_LIMITS, type DesignFrameId, type DesignFrameView, type DesignSessionState } from '../../../shared/ipc/designSession';
import type { DesignSnapshot } from '../../../shared/ipc/designSnapshot';

export type DesignPhase = 'idle' | 'entering' | 'working' | 'leaving';

/** What the person last picked on the canvas: nothing, a whole frame, or an element in one. */
export type DesignSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'frame'; readonly frame: DesignFrameId }
  | { readonly kind: 'element'; readonly frame: DesignFrameId; readonly path: string; readonly copy: number };

/** The canvas's camera: where its origin is on screen, and how large a canvas pixel is drawn. */
export interface DesignCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** What the canvas shows from the click until the window is on the copy: nothing in it can be edited yet. */
export interface DesignOpening {
  readonly frames: readonly DesignFrameView[];
}

export interface DesignView {
  readonly session: DesignSessionState;
  readonly phase: DesignPhase;
  readonly opening: DesignOpening | undefined;
  readonly snapshots: ReadonlyMap<DesignFrameId, DesignSnapshot>;
  readonly selection: DesignSelection;
  /** The frame the site's copy is being rewritten to; until it is read, the panels have nothing selected. */
  readonly switching: DesignFrameId | undefined;
  /** Undefined until the canvas first fits its frames. */
  readonly camera: DesignCamera | undefined;
  /** The one frame shown while it is photographed for the AI. */
  readonly photo: DesignFrameId | undefined;
}

/** Mounted readers; a leak past this is a bug, not growth. */
const LISTENERS_MAX = 50;

let view: DesignView = {
  session: { kind: 'off' },
  phase: 'idle',
  opening: undefined,
  snapshots: new Map(),
  selection: { kind: 'none' },
  switching: undefined,
  camera: undefined,
  photo: undefined,
};
const listeners = new Set<() => void>();

export function designView(): DesignView {
  return view;
}

export function updateDesignView(change: (current: DesignView) => DesignView): void {
  const next = change(view);
  if (next === view) {
    return;
  }
  if (next.snapshots.size > DESIGN_SESSION_LIMITS.framesMax) {
    throw new Error('Assertion failed: updateDesignView: at most one snapshot a frame');
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

/** Whether the header button shows Design mode as on: on, or on its way. */
export function isDesignModeActive(): boolean {
  return view.session.kind === 'on' || view.phase === 'entering';
}

export function useDesignView(): DesignView {
  return useSyncExternalStore(subscribeDesignView, designView, designView);
}
