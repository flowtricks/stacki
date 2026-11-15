// Where the main window was, so the next launch opens it there: its normal (windowed) rectangle, whether it
// was maximized or full screen, and the display it was on. Everything here is pure: reading Electron's
// screen and window objects, and the file, is windowStateStore.ts.
//
// Why the normal rectangle and not the current one: a maximized or full-screen window's own bounds are the
// whole display, so storing them would make "un-maximize" return to a window as large as the screen. The
// normal bounds are what the window returns to, so they are what is kept, with the two flags beside them.
//
// Why a fit step: a saved rectangle was true for the displays connected when it was written. A monitor
// unplugged since, a resolution change or a different arrangement can leave it off every screen, with its
// title bar out of reach. `fitWindowState` puts it back on a display, never larger than that display's work
// area and never below the window's minimum.
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { HEIGHT_PX_MIN, WIDTH_PX_MIN } from './windowBounds';

export const WINDOW_STATE_VERSION = 1;

/** Bounds for everything read from disk: a hand-edited or damaged file stays inside them. */
export const WINDOW_STATE_LIMITS = {
  /** Larger than any real desktop; a coordinate beyond it is damage, not a monitor arrangement. */
  coordinateAbsPxMax: 100_000,
  sizePxMax: 100_000,
  displayIdAbsMax: 2 ** 53 - 1,
  scaleFactorMax: 16,
  /** The file is a few hundred bytes; more than this is not ours. */
  fileBytesMax: 4096,
  /** After the last move or resize, how long the write waits. */
  saveDelayMs: 500,
  /** A drag that never pauses still writes this often, so a crash loses at most this much. */
  saveWaitMsMax: 3000,
  /** The part of a saved window that must still be on a display for it to count as on it. */
  visibleWidthPxMin: 160,
  visibleHeightPxMin: 48,
} as const;

export interface PixelRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowDisplay {
  readonly id: number;
  readonly scaleFactor: number;
  /** The display's work area: its bounds minus the menu bar, the Dock or the taskbar. */
  readonly workArea: PixelRectangle;
}

export interface WindowState {
  readonly version: typeof WINDOW_STATE_VERSION;
  /** The windowed rectangle (Electron's `getNormalBounds`). */
  readonly bounds: PixelRectangle;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
  /** The display the window was mostly on when it was saved. */
  readonly displayId: number;
  readonly scaleFactor: number;
}

export interface WindowStateError {
  readonly code: 'window-state-invalid';
  readonly message: string;
}

export interface FittedWindowState {
  readonly bounds: PixelRectangle;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
  /** `saved`: the rectangle was usable (perhaps nudged); `primary`: it was on no display, so it is centred on the primary one. */
  readonly placement: 'saved' | 'primary';
}

function invalid(message: string): Result<never, WindowStateError> {
  return err({ code: 'window-state-invalid', message });
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isIntegerWithin(value: unknown, absoluteMax: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= absoluteMax;
}

function parseRectangle(input: unknown): Result<PixelRectangle, WindowStateError> {
  if (!isRecord(input)) {
    return invalid('bounds: expected an object');
  }
  const { x, y, width, height } = input;
  if (!isIntegerWithin(x, WINDOW_STATE_LIMITS.coordinateAbsPxMax)) {
    return invalid('bounds.x: expected a bounded integer');
  }
  if (!isIntegerWithin(y, WINDOW_STATE_LIMITS.coordinateAbsPxMax)) {
    return invalid('bounds.y: expected a bounded integer');
  }
  if (!isIntegerWithin(width, WINDOW_STATE_LIMITS.sizePxMax) || width <= 0) {
    return invalid('bounds.width: expected a positive bounded integer');
  }
  if (!isIntegerWithin(height, WINDOW_STATE_LIMITS.sizePxMax) || height <= 0) {
    return invalid('bounds.height: expected a positive bounded integer');
  }
  return ok({ x, y, width, height });
}

/** Parses what a window-state file held, as unknown. A bad file is a value, never a crash: the window opens as on a first launch. */
export function parseWindowState(input: unknown): Result<WindowState, WindowStateError> {
  if (!isRecord(input)) {
    return invalid('window state: expected an object');
  }
  if (input['version'] !== WINDOW_STATE_VERSION) {
    return invalid('window state: unknown version');
  }
  const bounds = parseRectangle(input['bounds']);
  if (!bounds.ok) {
    return bounds;
  }
  const { maximized, fullScreen, displayId, scaleFactor } = input;
  if (typeof maximized !== 'boolean') {
    return invalid('window state.maximized: expected a boolean');
  }
  if (typeof fullScreen !== 'boolean') {
    return invalid('window state.fullScreen: expected a boolean');
  }
  if (!isIntegerWithin(displayId, WINDOW_STATE_LIMITS.displayIdAbsMax)) {
    return invalid('window state.displayId: expected a bounded integer');
  }
  if (typeof scaleFactor !== 'number' || !Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor > WINDOW_STATE_LIMITS.scaleFactorMax) {
    return invalid('window state.scaleFactor: expected a number above 0');
  }
  return ok({ version: WINDOW_STATE_VERSION, bounds: bounds.value, maximized, fullScreen, displayId, scaleFactor });
}

/** The text of a state file, or an error when it is not JSON or is too large. */
export function parseWindowStateText(text: string): Result<WindowState, WindowStateError> {
  if (text.length > WINDOW_STATE_LIMITS.fileBytesMax) {
    return invalid('window state: file is larger than the limit');
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return invalid('window state: not JSON');
  }
  return parseWindowState(input);
}

function intersectionArea(left: PixelRectangle, right: PixelRectangle): { readonly width: number; readonly height: number } {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/** The display the rectangle overlaps most, among those it overlaps enough to be reachable; undefined when none. */
function displayHolding(bounds: PixelRectangle, displays: ReadonlyArray<WindowDisplay>): WindowDisplay | undefined {
  let best: WindowDisplay | undefined;
  let bestArea = 0;
  for (const display of displays) {
    const overlap = intersectionArea(bounds, display.workArea);
    if (overlap.width < WINDOW_STATE_LIMITS.visibleWidthPxMin || overlap.height < WINDOW_STATE_LIMITS.visibleHeightPxMin) {
      continue;
    }
    const area = overlap.width * overlap.height;
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return best;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** `bounds` sized to fit `workArea` (never below the minimum) and moved wholly inside it. */
function insideWorkArea(bounds: PixelRectangle, workArea: PixelRectangle): PixelRectangle {
  const width = Math.max(WIDTH_PX_MIN, Math.min(bounds.width, workArea.width));
  const height = Math.max(HEIGHT_PX_MIN, Math.min(bounds.height, workArea.height));
  const x = clamp(bounds.x, workArea.x, Math.max(workArea.x, workArea.x + workArea.width - width));
  const y = clamp(bounds.y, workArea.y, Math.max(workArea.y, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

/**
 * Where to open given what was saved and the displays connected now. A saved rectangle that is still on a
 * display stays (nudged inside that display's work area, and no larger than it). One that is on none is
 * centred on the primary display at its saved size, capped to that display. Display scale changes need no
 * conversion: window bounds are device-independent, so the same rectangle is the same size to the person;
 * the cap to the work area is what holds when a display is now smaller in those units.
 */
export function fitWindowState(state: WindowState, displays: ReadonlyArray<WindowDisplay>, primary: WindowDisplay): FittedWindowState {
  assert(displays.length > 0, 'fitWindowState: at least one display is connected');
  assert(primary.workArea.width > 0, 'fitWindowState: the primary display has a work area width');
  assert(primary.workArea.height > 0, 'fitWindowState: the primary display has a work area height');
  const holder = displayHolding(state.bounds, displays);
  const common = { minWidth: WIDTH_PX_MIN, minHeight: HEIGHT_PX_MIN, maximized: state.maximized, fullScreen: state.fullScreen } as const;
  if (holder !== undefined) {
    const bounds = insideWorkArea(state.bounds, holder.workArea);
    assert(bounds.width >= WIDTH_PX_MIN, 'fitWindowState: a fitted window is not narrower than its minimum');
    assert(bounds.height >= HEIGHT_PX_MIN, 'fitWindowState: a fitted window is not shorter than its minimum');
    return { ...common, bounds, placement: 'saved' };
  }
  const sized = insideWorkArea({ x: 0, y: 0, width: state.bounds.width, height: state.bounds.height }, primary.workArea);
  const bounds = {
    x: primary.workArea.x + Math.floor((primary.workArea.width - sized.width) / 2),
    y: primary.workArea.y + Math.floor((primary.workArea.height - sized.height) / 2),
    width: sized.width,
    height: sized.height,
  };
  return { ...common, bounds, placement: 'primary' };
}

/** What `createDebouncedSaver` needs of a clock; the global timers are the real one. */
export interface SaveClock<Timer> {
  readonly now: () => number;
  readonly setTimer: (task: () => void, delayMs: number) => Timer;
  readonly clearTimer: (timer: Timer) => void;
}

export interface DebouncedSaver {
  /** Asks for a save: it runs after the delay, or at the latest `saveWaitMsMax` after the first ask of a burst. */
  readonly schedule: () => void;
  /** Runs a waiting save now (the window is closing); a no-op when none waits. */
  readonly flush: () => void;
}

/**
 * Coalesces the many resize and move events of a drag into few writes: one at most every `saveWaitMsMax`
 * during a continuous drag, and one `saveDelayMs` after it stops. At most one timer exists.
 */
export function createDebouncedSaver<Timer>(clock: SaveClock<Timer>, save: () => void): DebouncedSaver {
  let timer: Timer | undefined;
  let burstStartedAtMs: number | undefined;
  const run = (): void => {
    if (timer !== undefined) {
      clock.clearTimer(timer);
    }
    timer = undefined;
    burstStartedAtMs = undefined;
    save();
  };
  return {
    schedule(): void {
      const nowMs = clock.now();
      const startedAtMs = burstStartedAtMs ?? nowMs;
      burstStartedAtMs = startedAtMs;
      if (timer !== undefined) {
        clock.clearTimer(timer);
      }
      const remainingMs = WINDOW_STATE_LIMITS.saveWaitMsMax - (nowMs - startedAtMs);
      const delayMs = Math.max(0, Math.min(WINDOW_STATE_LIMITS.saveDelayMs, remainingMs));
      assert(delayMs <= WINDOW_STATE_LIMITS.saveDelayMs, 'createDebouncedSaver: the wait is bounded');
      timer = clock.setTimer(run, delayMs);
    },
    flush(): void {
      if (timer !== undefined) {
        run();
      }
    },
  };
}
