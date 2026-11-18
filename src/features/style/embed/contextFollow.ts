// Whether the style panel's edit target follows the canvas width, or is held where the person put it.
//
// Following is the default: as the canvas is resized, the query that holds at that width is
// the edit target (model/followWidth.ts). The link on the trigger (or the "0" key) holds
// ("pins") the target on Base, and picking a row with no canvas width holds it there: it stays
// where the person put it while the canvas is resized, until they check the matching row or the
// link again. The whole table is embed/followTransition.ts (docs/style-follow-canvas.md).
//
// The hold lasts the session only. An earlier version kept it in browser storage per project,
// and one stray click on Base then pinned the panel for good with nothing to say how to get
// back: resizing the canvas appeared to do nothing. Now every app launch and every project
// open starts following, and the old stored record is deleted the first time it is met.
// Resizing the canvas never releases a hold (that would defeat "edit every size without
// resizing"); only the person's explicit check does.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { assert } from '../../../../shared/core/assert';
import { getHost, onHostChange } from '../model/host';

export type FollowMode = 'follow' | 'pinned';

/** The key an earlier version stored the hold under; it is deleted when met (a stale pin must not survive). */
export const FOLLOW_STORAGE_PREFIX = 'stacki.styleContext:';

function forgetStored(projectKey: string | undefined): void {
  try {
    window.localStorage.removeItem(`${FOLLOW_STORAGE_PREFIX}${projectKey ?? ''}`);
  } catch {
    // Storage can be blocked: then there is nothing stored to forget.
  }
}

// One record per project, shared by every reader (the dropdown's pick, the desktop rule): two
// copies of the state would drift. Held in memory only (see the header).
const modes = new Map<string, FollowMode>();
const listeners = new Set<() => void>();

// Which project the held modes belong to: opening another one starts them over.
let openProject: string | undefined;
let projectSeen = false;

function modeOf(projectKey: string | undefined): FollowMode {
  if (!projectSeen || openProject !== projectKey) {
    projectSeen = true;
    openProject = projectKey;
    modes.clear();
    forgetStored(projectKey);
  }
  return modes.get(projectKey ?? '') ?? 'follow';
}

function setModeOf(projectKey: string | undefined, mode: FollowMode): void {
  modeOf(projectKey);
  assert(modes.size <= 1, 'one project is open at a time, so at most one mode is held');
  modes.set(projectKey ?? '', mode);
  for (const listener of listeners) {
    listener();
  }
}

/** Forgets every hold, as a fresh launch does (a test's fresh start). */
export function forgetFollowModes(): void {
  modes.clear();
  projectSeen = false;
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

const readCanvasDevice = (): string => {
  const device = getHost().device;
  assert(device.length > 0, 'the canvas device is named');
  return device;
};

/** The device picked in the canvas toolbar (`desktop`, `custom`, a breakpoint id), as the toolbar's pressed button is computed from it. */
export function useCanvasDevice(): string {
  return useSyncExternalStore(subscribeHost, readCanvasDevice);
}

// The mounted panels' toggle: the "0" key does what the link on the trigger does, and only a panel
// knows its edit target (turning following off while on a query also moves the target to Base,
// embed/followTransition.ts). One per mounted style panel; the bound catches a leaked registration.
const TOGGLE_HANDLERS_MAX = 16;
const toggleHandlers = new Set<(from: FollowMode) => void>();

/** Lets the "0" key reach a mounted panel's toggle, for as long as the panel is mounted. */
export function useFollowToggleHandler(handler: (from: FollowMode) => void): void {
  useEffect(() => {
    toggleHandlers.add(handler);
    assert(toggleHandlers.size <= TOGGLE_HANDLERS_MAX, 'useFollowToggleHandler: one handler per mounted style panel');
    return () => {
      toggleHandlers.delete(handler);
    };
  }, [handler]);
}

/**
 * Turns following off or on for the open project, as the link on the trigger does. Only where a
 * canvas width is known (without one there is nothing to follow). True when it toggled. The "0"
 * key calls this (model/appKeys.ts). With a panel mounted the panel applies the whole transition
 * (target included); with none, only the mode flips.
 */
export function toggleFollowMode(projectKey: string | undefined): boolean {
  if (readCanvasWidth() === undefined) {
    return false;
  }
  // Read once, so every mounted panel toggles from the same mode and they all land on the same one.
  const from = modeOf(projectKey);
  if (toggleHandlers.size === 0) {
    setModeOf(projectKey, from === 'follow' ? 'pinned' : 'follow');
    return true;
  }
  // One commit for the mode and the target. The key arrives outside a React event, where the mode's store
  // update renders at sync priority and the target's state update at default priority, in two commits: one
  // frame showed the old query beside a link already off. flushSync puts both in the same synchronous render.
  flushSync(() => {
    for (const handler of [...toggleHandlers]) {
      handler(from);
    }
  });
  return true;
}

/**
 * Where a following panel moves its target, or undefined to leave it. It moves only once the
 * element's rules have been read: until then the list of queries is the partial one the element
 * has before its scan lands, and the row that holds at the canvas width is picked from it, so
 * the trigger would show Base (or another row) for a frame and then jump back.
 */
export function followRetargetKey(state: {
  readonly following: boolean;
  readonly settled: boolean;
  readonly matchedKey: string | undefined;
  readonly context: string;
  /** A row was picked while following and the canvas has not reached its width yet: following waits for it, or the
   *  target would snap back to the row at the old width for a frame (embed/followTransition.ts). */
  readonly pickPending?: boolean;
}): string | undefined {
  if (!state.following || !state.settled || state.matchedKey === undefined) {
    return undefined;
  }
  if (state.pickPending === true) {
    return undefined;
  }
  return state.matchedKey === state.context ? undefined : state.matchedKey;
}
