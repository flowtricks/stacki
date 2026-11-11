import type { WindowMode } from './DockableWindow';
import { toRecord } from '../../shared/core/record';
import { centeredWindowRectangle, fitWindowRectangle, initialWindowRectangle, type WindowRectangle, type WindowSize } from './windowGeometry';

const STORED_VALUE_CHARS_MAX = 256;
const COORDINATE_PX_MAX = 100_000;

// A separate key preserves compatibility with existing saved window rectangles.
export function readWindowMode(key: string): WindowMode {
  try {
    const value: unknown = localStorage.getItem(key);
    if (value === 'docked' || value === 'floating') {
      return value;
    }
  } catch {
    // Storage is optional; a denied read must not prevent opening the editor.
  }
  return 'floating';
}

export function storeWindowMode(key: string, mode: WindowMode): void {
  try {
    localStorage.setItem(key, mode);
  } catch {
    // Losing an optional preference must not interrupt docking or editing.
  }
}

// Stored geometry is only a preference: corrupt or unavailable storage falls back to the center,
// at the window's own first size when it names one.
export function readWindowRectangle(key: string | undefined, viewport: WindowSize, minimum: WindowSize, initial?: WindowSize): WindowRectangle {
  let stored: WindowRectangle | undefined;
  if (key) {
    try {
      stored = parseStoredWindowRectangle(localStorage.getItem(key));
    } catch {
      // Privacy modes can deny storage; the tool must remain usable.
    }
  }
  if (stored) {
    return fitWindowRectangle(stored, viewport, minimum);
  }
  return initial ? centeredWindowRectangle(viewport, initial, minimum) : initialWindowRectangle(viewport, minimum);
}

export function storeWindowRectangle(key: string | undefined, rectangle: WindowRectangle): void {
  if (!key) {
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(rectangle));
  } catch {
    // Losing an optional preference must not interrupt an editor gesture.
  }
}

export function parseStoredWindowRectangle(raw: unknown): WindowRectangle | undefined {
  if (typeof raw !== 'string' || raw.length > STORED_VALUE_CHARS_MAX) {
    return undefined;
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const value = toRecord(input);
  const x = value?.['x'];
  const y = value?.['y'];
  const width = value?.['width'];
  const height = value?.['height'];
  if (!storedCoordinate(x, 0)) {
    return undefined;
  }
  if (!storedCoordinate(y, 0)) {
    return undefined;
  }
  if (!storedCoordinate(width, 1)) {
    return undefined;
  }
  if (!storedCoordinate(height, 1)) {
    return undefined;
  }
  return { x, y, width, height };
}

function storedCoordinate(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= COORDINATE_PX_MAX;
}
