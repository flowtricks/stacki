// Whether the person is asked to Keep each AI change ("Ask me to keep AI changes"). The preference
// lives in the app's own settings file (main process, `aiReviewChanges`), once per person and never in a
// project. An AI edit is on disk the moment the agent makes it; this decides only what the changes card
// offers: off (the default), each file reads "Applied" with Undo; on, each file waits for Keep or Undo.
//
// The renderer keeps one copy, read when the panel opens and replaced whenever the person flips the
// switch (the panel's menu or Settings), so every changes card on screen follows it at once.
import { useSyncExternalStore } from 'react';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parsePreferenceResult, parsePreferences } from '../../../shared/ipc/preferences';

/** `auto`: edits apply and read "Applied". `review`: each file waits for Keep or Undo, as before this setting. */
export type ReviewMode = 'auto' | 'review';

/** `auto` until the saved choice is read: the quiet default, and the one a new person has. */
let mode: ReviewMode = 'auto';
const listeners = new Set<() => void>();

export function reviewModeOf({ enabled }: { readonly enabled: boolean }): ReviewMode {
  return enabled ? 'review' : 'auto';
}

/** Makes `next` the mode on screen. Used by the loader, the setter and Settings. */
export function publishReviewMode(next: ReviewMode): void {
  if (next === mode) {
    return;
  }
  mode = next;
  for (const listener of listeners) {
    listener();
  }
}

export function currentReviewMode(): ReviewMode {
  return mode;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReviewMode(): ReviewMode {
  return useSyncExternalStore(subscribe, currentReviewMode, currentReviewMode);
}

/** Reads the saved choice. A failure keeps the default: the card is never blocked on a setting. */
export async function loadReviewMode(): Promise<void> {
  try {
    const preferences = parsePreferences(await window.avb.settings(parseIpcPayload('settings:get', undefined)));
    publishReviewMode(reviewModeOf({ enabled: preferences.aiReviewChanges }));
  } catch (error: unknown) {
    console.error('Reading the review preference failed', error);
  }
}

/**
 * Saves the choice and applies it at once; if saving fails the screen goes back to what was saved, so the
 * switch never shows a choice the next launch will not have. Resolves true when it was saved.
 */
export async function saveReviewMode(next: ReviewMode): Promise<boolean> {
  const previous = mode;
  publishReviewMode(next);
  try {
    const payload = parseIpcPayload('settings:set', { setting: 'aiReviewChanges', enabled: next === 'review' });
    const result = parsePreferenceResult(await window.avb.setPreference(payload));
    publishReviewMode(reviewModeOf({ enabled: result.aiReviewChanges }));
    return result.saved;
  } catch (error: unknown) {
    console.error('Saving the review preference failed', error);
    publishReviewMode(previous);
    return false;
  }
}
