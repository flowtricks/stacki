// Where Chromium's own scrollbar starts on the canvas (Settings › Editor › Canvas, `canvasScrollbar`): nowhere, so the
// canvas draws its own bar beside every frame, or from one breakpoint up (shared/properties/canvasScrollbar.ts). The
// preference lives in the app's own settings file (main process), once per person and never in a project.
//
// The renderer keeps one copy. It starts at the default, so the first frame already has the canvas's bar; the saved
// choice is read once, the first time a canvas asks, and replaced whenever the person picks another in Settings. Every
// canvas listens, so a change reaches the open frame at once. Studio and the demo have no app settings file and keep
// the default.

import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parsePreferences } from '../../../shared/ipc/preferences';
import { CANVAS_SCROLLBAR_DEFAULT, canvasScrollbarPreferenceText, type CanvasScrollbarPreference } from '../../../shared/properties/canvasScrollbarChoice';

let preference: CanvasScrollbarPreference = CANVAS_SCROLLBAR_DEFAULT;
let loadStarted = false;
const listeners = new Set<() => void>();

/** Makes `next` the preference every canvas follows. Used by the loader and by Settings. */
export function publishCanvasScrollbarPreference(next: CanvasScrollbarPreference): void {
  if (canvasScrollbarPreferenceText(next) === canvasScrollbarPreferenceText(preference)) {
    return; // The same choice: listeners would redraw for nothing.
  }
  preference = next;
  for (const listener of listeners) {
    listener();
  }
  assert(preference === next, 'publishCanvasScrollbarPreference: the new choice is current');
}

export function currentCanvasScrollbarPreference(): CanvasScrollbarPreference {
  return preference;
}

/** Calls `listener` after each change; the returned function stops it. */
export function subscribeCanvasScrollbarPreference(listener: () => void): () => void {
  listeners.add(listener);
  loadCanvasScrollbarPreferenceOnce();
  return () => {
    listeners.delete(listener);
  };
}

export function useCanvasScrollbarPreference(): CanvasScrollbarPreference {
  return useSyncExternalStore(subscribeCanvasScrollbarPreference, currentCanvasScrollbarPreference, currentCanvasScrollbarPreference);
}

// Reads the saved choice the first time anything listens. Only Desktop has the settings channel; a failure keeps the
// default, since a canvas is never blocked on a setting.
function loadCanvasScrollbarPreferenceOnce(): void {
  if (loadStarted) {
    return;
  }
  loadStarted = true;
  if (typeof window === 'undefined') {
    return;
  }
  if (typeof window.avb?.settings !== 'function') {
    return;
  }
  // Parsed in its own step, so a reply that does not parse lands in the same handler as a failed read.
  void window.avb
    .settings(parseIpcPayload('settings:get', undefined))
    .then((reply: unknown) => parsePreferences(reply).canvasScrollbar)
    .then(publishCanvasScrollbarPreference, (error: unknown) => console.error('Reading the canvas scrollbar preference failed', error));
}
