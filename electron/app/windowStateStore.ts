// Reads, writes and follows the main window's state file (windowState.ts holds the rules). The file is
// `window-state.json` in the app's data folder, next to settings.json: a person's preference about their
// own window, never part of a project.
//
// Writes are small and rare (the debounce in windowState.ts), made through a temporary file and a rename so
// a crash mid-write leaves the previous state, not half of one. A failed read or write is a value the caller
// ignores: the window then opens as it does on a first launch, which is always a usable state.
import * as fs from 'fs';
import type { BrowserWindow } from 'electron';
import * as path from 'path';
import { assert } from '../../shared/core/assert';
import { err, type Result } from '../../shared/core/result';
import {
  WINDOW_STATE_LIMITS,
  WINDOW_STATE_VERSION,
  createDebouncedSaver,
  parseWindowStateText,
  type PixelRectangle,
  type SaveClock,
  type WindowDisplay,
  type WindowState,
  type WindowStateError,
} from './windowState';

export const WINDOW_STATE_FILE = 'window-state.json';

/** The part of Electron's `Display` this reads; a fake stands in for it in tests. */
export interface ScreenDisplay {
  readonly id: number;
  readonly scaleFactor: number;
  readonly workArea: PixelRectangle;
}

export interface ScreenSource {
  readonly getAllDisplays: () => ScreenDisplay[];
  readonly getPrimaryDisplay: () => ScreenDisplay;
  readonly getDisplayMatching: (rectangle: PixelRectangle) => ScreenDisplay;
}

/** What this reads of a BrowserWindow. */
export interface TrackedWindow {
  readonly getNormalBounds: () => PixelRectangle;
  readonly isMaximized: () => boolean;
  readonly isFullScreen: () => boolean;
  readonly isDestroyed: () => boolean;
}

/** A BrowserWindow, which is a TrackedWindow that can also be listened to. */
export type ListenableWindow = TrackedWindow & Pick<BrowserWindow, 'on'>;

export function toWindowDisplay(display: ScreenDisplay): WindowDisplay {
  return { id: display.id, scaleFactor: display.scaleFactor, workArea: display.workArea };
}

/** The saved state, or why there is none (no file, too large, damaged): all of them mean "open as the first time". */
export function readWindowState(directory: string): Result<WindowState, WindowStateError> {
  const file = path.join(directory, WINDOW_STATE_FILE);
  try {
    const sizeBytes = fs.statSync(file).size;
    if (sizeBytes > WINDOW_STATE_LIMITS.fileBytesMax) {
      return err({ code: 'window-state-invalid', message: 'window state: file is larger than the limit' });
    }
    return parseWindowStateText(fs.readFileSync(file, 'utf8'));
  } catch {
    return err({ code: 'window-state-invalid', message: 'window state: no readable file' });
  }
}

/** Writes `state` atomically; false when the disk refused (the next change tries again). */
export function writeWindowState(directory: string, state: WindowState): boolean {
  const file = path.join(directory, WINDOW_STATE_FILE);
  const temporary = `${file}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), 'utf8');
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

/** The window's state now: its windowed rectangle and flags, and the display the rectangle is mostly on. */
export function snapshotWindow(window: TrackedWindow, screen: ScreenSource): WindowState {
  const bounds = window.getNormalBounds();
  const display = screen.getDisplayMatching(bounds);
  assert(bounds.width > 0, 'snapshotWindow: a window has a width');
  assert(bounds.height > 0, 'snapshotWindow: a window has a height');
  return {
    version: WINDOW_STATE_VERSION,
    bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) },
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    displayId: display.id,
    scaleFactor: display.scaleFactor,
  };
}

/** Saves the window's state after it moves, resizes or changes mode (debounced) and once more when it closes. */
export function trackWindowState<Timer>(window: ListenableWindow, screen: ScreenSource, directory: string, clock: SaveClock<Timer>): void {
  const saver = createDebouncedSaver(clock, () => {
    if (window.isDestroyed()) {
      return;
    }
    const state = snapshotWindow(window, screen);
    // Not valid to keep (a degenerate rectangle while minimising on some platforms): the last good one stays on disk.
    if (parseWindowStateText(JSON.stringify(state)).ok) {
      writeWindowState(directory, state);
    }
  });
  window.on('resize', saver.schedule);
  window.on('move', saver.schedule);
  window.on('maximize', saver.schedule);
  window.on('unmaximize', saver.schedule);
  window.on('enter-full-screen', saver.schedule);
  window.on('leave-full-screen', saver.schedule);
  window.on('close', saver.flush);
}
