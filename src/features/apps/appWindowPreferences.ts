// Where each running app shows, and what the user chose for it. An app is either
// docked in the side panel or popped out into a popup over the canvas, the
// Variables window's two modes (src/ui/DockableWindow.tsx). The user's last mode,
// popup rectangle and docked panel width are remembered per project and app in
// local storage, and win over the manifest's `window` defaults. Each is only a
// preference: unreadable or corrupt storage falls back to the manifest.
//
// The docked window is drawn by AppsHost, which lives as long as the editor, over
// a slot the Apps panel reserves; the frame is never moved between parents, so it
// is never reloaded (browsers reload an iframe that changes parent).
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_LIMITS, type AppSummary, type AppWindowMode } from '../../../shared/properties/apps';
import { appAccessFeature } from '../../../shared/properties/appsRpc';
import { can, type RoleView } from '../../../shared/properties/projectRoles';
import type { WindowMode } from '../../ui/DockableWindow';
import type { WindowSize } from '../../ui/windowGeometry';
import type { RunningApp } from './appsRuntime';

/** A popup may shrink to the manifest's smallest size, never below. */
export const APP_WINDOW_MINIMUM_SIZE: WindowSize = { width: APP_LIMITS.windowWidthPxMin, height: APP_LIMITS.windowHeightPxMin };

// Keys are per project and app; a project holds at most `APP_LIMITS.appsMax` apps,
// and only apps the user opened write keys, three at most each.
const KEY_PREFIX = 'stacki.app.window';
const STORED_MODE_CHARS_MAX = 8;
const STORED_WIDTH_CHARS_MAX = 4;

/** The DockableWindow storage key for one app's popup rectangle in one project. */
export function appWindowStorageKey(projectPath: string, appId: string): string {
  assert(projectPath.length > 0, 'An app window key names its project');
  assert(appId.length > 0, 'An app window key names its app');
  assert(appId.length <= APP_LIMITS.idCharsMax, 'An app window key names a bounded app id');
  return `${KEY_PREFIX}.${encodeURIComponent(projectPath)}.${appId}`;
}

/** The mode an app opens in: the user's last choice in this project, else the manifest's. */
export function appOpeningMode(projectPath: string, app: AppSummary): AppWindowMode {
  return readStored(`${appWindowStorageKey(projectPath, app.manifest.id)}.mode`, parseStoredAppWindowMode) ?? app.manifest.window.mode;
}

export function storeAppWindowMode(projectPath: string, appId: string, mode: AppWindowMode): void {
  writeStored(`${appWindowStorageKey(projectPath, appId)}.mode`, mode);
}

/** The side panel width a docked app asks for: the user's resize in this project, else the manifest's, else none. */
export function appPanelWidth(projectPath: string, app: AppSummary): number | undefined {
  const stored = readStored(`${appWindowStorageKey(projectPath, app.manifest.id)}.panelWidth`, parseStoredAppPanelWidth);
  return stored ?? app.manifest.window.widthPx;
}

export function storeAppPanelWidth(projectPath: string, appId: string, widthPx: number): void {
  assert(parseStoredAppPanelWidth(String(widthPx)) === widthPx, 'A stored app panel width is a valid manifest width');
  writeStored(`${appWindowStorageKey(projectPath, appId)}.panelWidth`, String(widthPx));
}

// The manifest's width bounds; the side panel clamps to its own narrower range when it draws.
export function parseStoredAppPanelWidth(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > STORED_WIDTH_CHARS_MAX) {
    return undefined;
  }
  const width = Number(raw);
  if (!Number.isSafeInteger(width)) {
    return undefined;
  }
  if (width < APP_LIMITS.windowWidthPxMin) {
    return undefined;
  }
  return width <= APP_LIMITS.windowWidthPxMax ? width : undefined;
}

export function parseStoredAppWindowMode(raw: unknown): AppWindowMode | undefined {
  if (typeof raw !== 'string' || raw.length > STORED_MODE_CHARS_MAX) {
    return undefined;
  }
  if (raw === 'panel' || raw === 'popup') {
    return raw;
  }
  return undefined;
}

/** The manifest's mode names, in the shared window's terms. */
export function dockModeOf(mode: AppWindowMode): WindowMode {
  switch (mode) {
    case 'panel':
      return 'docked';
    case 'popup':
      return 'floating';
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

export function appModeOf(mode: WindowMode): AppWindowMode {
  switch (mode) {
    case 'docked':
      return 'panel';
    case 'floating':
      return 'popup';
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/** The docked app the side panel shows: the latest docked one `role` may use. */
export function shownDockedApp(running: readonly RunningApp[], role: RoleView): RunningApp | undefined {
  const docked = running.filter((entry) => entry.mode === 'panel' && can(role, appAccessFeature(entry.app.manifest.id)));
  const shown = docked.at(-1);
  assert(shown === undefined || shown.mode === 'panel', 'The shown docked app is docked');
  return shown;
}

// The Apps panel's slot for the docked app: the element the docked window covers.
// One panel at a time mounts, so one slot.
let dockSlot: HTMLElement | undefined;
const slotListeners = new Set<() => void>();

export function setAppDockSlot(element: HTMLElement | undefined): void {
  if (dockSlot === element) {
    return;
  }
  dockSlot = element;
  for (const listener of [...slotListeners]) {
    listener();
  }
}

export function useAppDockSlot(): HTMLElement | undefined {
  return useSyncExternalStore(
    (listener) => {
      slotListeners.add(listener);
      return () => {
        slotListeners.delete(listener);
      };
    },
    () => dockSlot,
  );
}

function readStored<T>(key: string, parse: (raw: unknown) => T | undefined): T | undefined {
  try {
    return parse(localStorage.getItem(key));
  } catch {
    // Storage can be unavailable; the manifest's defaults still apply.
    return undefined;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Losing an optional preference must not interrupt docking or resizing.
  }
}
