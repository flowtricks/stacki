// Whether the style panel's edit target follows the canvas width, or is pinned to a choice.
//
// Following is the default: as the canvas is resized, the query that holds at that width is
// the edit target (model/followWidth.ts). Unchecking that query, or choosing any row by hand,
// pins the target: it stays where the person put it while the canvas is resized, until they
// check the matching row again.
//
// The choice is kept per project in the browser's storage, the way the column guide was
// before it moved to project files: a small bounded record, read once when the project opens
// (reading never writes), written only when the person changes it, and dropped again when it
// returns to the default. Desktop and Studio share this file, so they behave the same. It is
// a per-machine preference (like the panel layout), not part of the project's sources, so a
// teammate's checkout is not touched by one person's pin.

import { useCallback, useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import { getHost, onHostChange } from '../model/host';

export type FollowMode = 'follow' | 'pinned';

export const FOLLOW_STORAGE_PREFIX = 'stacki.styleContext:';
/** A stored record is one short object; anything longer is not one. */
export const FOLLOW_STORED_CHARS_MAX = 64;

/** The stored record read at the boundary: anything unreadable or unknown is the default, follow. */
export function parseFollowMode(stored: unknown): FollowMode {
  if (typeof stored !== 'string' || stored.length === 0 || stored.length > FOLLOW_STORED_CHARS_MAX) {
    return 'follow';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return 'follow';
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return 'follow';
  }
  const record = parsed as Record<string, unknown>;
  return record['follow'] === false ? 'pinned' : 'follow';
}

/** The record for a mode, or undefined for the default, which is stored as nothing. */
export function serializeFollowMode(mode: FollowMode): string | undefined {
  return mode === 'pinned' ? JSON.stringify({ follow: false }) : undefined;
}

function storageKey(projectKey: string | undefined): string {
  return `${FOLLOW_STORAGE_PREFIX}${projectKey ?? ''}`;
}

function readStored(projectKey: string | undefined): FollowMode {
  try {
    return parseFollowMode(window.localStorage.getItem(storageKey(projectKey)));
  } catch {
    return 'follow';
  }
}

function writeStored(projectKey: string | undefined, mode: FollowMode): void {
  try {
    const record = serializeFollowMode(mode);
    if (record === undefined) {
      window.localStorage.removeItem(storageKey(projectKey));
    } else {
      window.localStorage.setItem(storageKey(projectKey), record);
    }
  } catch {
    // Storage can be blocked: the choice then lasts the session, which is the fallback.
  }
}

// One record per project, shared by every reader (the dropdown's pick, the desktop rule): two
// copies of the state would drift. Read from storage the first time a project is asked for.
const modes = new Map<string, FollowMode>();
const listeners = new Set<() => void>();
const PROJECTS_MAX = 32;

function modeOf(projectKey: string | undefined): FollowMode {
  const key = projectKey ?? '';
  const held = modes.get(key);
  if (held !== undefined) {
    return held;
  }
  const read = readStored(projectKey);
  assert(modes.size <= PROJECTS_MAX * 2, 'the follow modes held stay within their bound');
  if (modes.size >= PROJECTS_MAX) {
    modes.clear();
  }
  modes.set(key, read);
  return read;
}

function setModeOf(projectKey: string | undefined, mode: FollowMode): void {
  writeStored(projectKey, mode);
  modes.set(projectKey ?? '', mode);
  for (const listener of listeners) {
    listener();
  }
}

/** Forgets what was read, so the next read comes from storage again (a test's, or a reopened project's, fresh start). */
export function forgetFollowModes(): void {
  modes.clear();
  for (const listener of listeners) {
    listener();
  }
}

const subscribeModes = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The mode for the open project and the one way to change it. */
export function useFollowMode(projectKey: string | undefined): readonly [FollowMode, (mode: FollowMode) => void] {
  const mode = useSyncExternalStore(subscribeModes, () => modeOf(projectKey));
  const setMode = useCallback((next: FollowMode) => setModeOf(projectKey, next), [projectKey]);
  return [mode, setMode] as const;
}

const subscribeHost = (listener: () => void): (() => void) => onHostChange(listener);
const readCanvasWidth = (): number | undefined => {
  const width = getHost().canvasWidthPx;
  assert(width === undefined || Number.isFinite(width), 'the canvas width is a number when it is known');
  return width;
};

/** The canvas's rendered width in CSS pixels, or undefined while it is not known (no canvas, not measured). */
export function useCanvasWidthPx(): number | undefined {
  return useSyncExternalStore(subscribeHost, readCanvasWidth);
}
