// What the preview supervisor (previewSupervisor.ts) found, for the canvas to draw, and what the canvas and the
// toolbar ask of it. The supervisor lives with the lifecycle hooks, which can start the dev server; the cover lives
// in the canvas, so both pass through here. Module state, because there is one canvas.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import type { PreviewSupervision, PreviewSupervisor } from './previewSupervisor';

/** Listeners at once: the canvas cover and the interactive preview; more means a leak. */
export const SUPERVISION_LISTENERS_MAX = 8;

export interface SupervisionView {
  readonly state: PreviewSupervision;
  /** Goes up each time the pages are loaded again, for a frame the canvas's refresh does not reach. */
  readonly reloads: number;
}

let view: SupervisionView = { state: { kind: 'ok' }, reloads: 0 };
let owner: PreviewSupervisor | undefined;
const listeners = new Set<() => void>();

function publish(next: SupervisionView): void {
  view = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function publishSupervision(state: PreviewSupervision): void {
  publish({ ...view, state });
}

export function publishSupervisedReload(): void {
  publish({ ...view, reloads: view.reloads + 1 });
}

/** The supervisor the buttons speak to. The returned release also takes its cover down. */
export function adoptPreviewSupervisor(supervisor: PreviewSupervisor): () => void {
  owner = supervisor;
  return () => {
    if (owner === supervisor) {
      owner = undefined;
      publishSupervision({ kind: 'ok' });
    }
  };
}

export function restartPreview(): void {
  owner?.restart();
}

/** The person asked for a reload (the address bar's button, ⌘R). */
export function previewReloadAsked(): void {
  owner?.asked();
}

function subscribe(listener: () => void): () => void {
  assert(listeners.size < SUPERVISION_LISTENERS_MAX, 'Supervision listeners are released when their owner goes');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSupervision(): SupervisionView {
  return useSyncExternalStore(
    subscribe,
    () => view,
    () => view,
  );
}
