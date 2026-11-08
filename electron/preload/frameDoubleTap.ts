// Double taps on a touch screen. Safari on iPhone and iPad may answer a double tap
// with two clicks and no dblclick, so the canvas tells one from two single taps
// itself (frameText.ts). Kept apart from the frame modules, which touch the page
// on import, so the regression suite can pin the rule without a DOM.
import { assert } from '../../shared/core/assert';

export interface TapPoint {
  readonly x: number;
  readonly y: number;
  readonly timeMs: number;
}

// The window and the slop of a double tap: iOS's own double-tap gesture uses about
// 350 ms, and a fingertip lands within a few CSS pixels of where it last did.
export const DOUBLE_TAP_MS_MAX = 350;
export const DOUBLE_TAP_PX_MAX = 24;

// Whether a tap completes a double tap begun by the previous one. Pure, so the
// regression suite can pin the bounds without a touch screen.
export function isTouchDoubleTap(previous: TapPoint | undefined, next: TapPoint): boolean {
  assert(Number.isFinite(next.timeMs), 'A tap carries a finite time');
  assert(Number.isFinite(next.x), 'A tap carries a finite x');
  assert(Number.isFinite(next.y), 'A tap carries a finite y');
  if (previous === undefined) {
    return false;
  }
  const elapsedMs = next.timeMs - previous.timeMs;
  if (elapsedMs < 0) {
    return false;
  }
  if (elapsedMs > DOUBLE_TAP_MS_MAX) {
    return false;
  }
  return Math.hypot(next.x - previous.x, next.y - previous.y) <= DOUBLE_TAP_PX_MAX;
}
