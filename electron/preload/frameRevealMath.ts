// The arithmetic of revealing a selection, kept free of the page so tests can pin it
// with plain numbers: where a box should land, whether it needs to move at all, and the
// shape of the glide that carries the page there (frameReveal.ts, frameRevealGlide.ts).

import { assert } from '../../shared/core/assert';
import type { Rect } from './frameBasics';

// The room a reveal leaves between a box and the edge it is aligned to. It says where a
// reveal lands, not what counts as seen (boxComfortable).
export const SCROLL_MARGIN = 24;

// The most of the view a sticky or fixed bar at the top may take from a landing: a
// full-height pinned panel must not leave no room to land in.
export const INSET_FRACTION_MAX = 0.4;

// The glide is quick enough to feel like a response to the click, slow enough to follow
// with the eye, and longer for a longer trip up to a cap, so a page a thousand screens
// away does not take a second to cross.
export const GLIDE_MS_MIN = 300;
export const GLIDE_MS_MAX = 450;
const GLIDE_PX_FULL = 2_400;

// The scroll position that lands a box: centred in what is visible of its scroller
// (below `insetTop`, the height of a sticky or fixed bar covering the top), or, for a box
// too tall to centre, its top SCROLL_MARGIN below that bar, since centring would push its
// beginning out. `rect.y` is measured from the top of the visible area. Absolute, and
// stable: read again once the box is there, it gives the same position, so repeating a
// jump never moves the page.
export const landingTop = (rect: Rect, viewportHeight: number, scrollTop: number, insetTop: number): number => {
  assert(viewportHeight >= 0, 'landingTop: a scroller has a height');
  assert(Number.isFinite(scrollTop), 'landingTop: a scroller has a position');
  assert(insetTop >= 0, 'landingTop: a bar covers no negative height');
  assert(insetTop <= viewportHeight, 'landingTop: a bar is no taller than the view');
  const room = viewportHeight - insetTop;
  const offset = rect.h >= room - SCROLL_MARGIN * 2 ? insetTop + SCROLL_MARGIN : insetTop + Math.floor((room - rect.h) / 2);
  const target = Math.max(0, Math.round(scrollTop + rect.y - offset));
  assert(target >= 0, 'landingTop: a scroll position is never negative');
  return target;
};

// Whether a reveal should leave a box alone. A box that fits is comfortable only when all
// of it shows below any bar covering the top: a box cut by an edge is moved so the
// person sees the rest, and one hiding behind a sticky header is moved out from under it.
// A box taller than what is visible can never show whole, so it is left alone when at
// least half of the visible area is that box: the person is already looking at it.
//
// A box with no area has no part to show, so it stays judged whole: all of it inside the
// view, edges included, or covering the view from edge to edge.
export const boxComfortable = (rect: Rect, viewportHeight: number, insetTop: number): boolean => {
  assert(rect.w >= 0, 'boxComfortable: a box has no negative width');
  assert(rect.h >= 0, 'boxComfortable: a box has no negative height');
  assert(insetTop >= 0, 'boxComfortable: a bar covers no negative height');
  const bottom = rect.y + rect.h;
  if (rect.w > 0 && rect.h > 0) {
    if (rect.y >= insetTop) {
      if (bottom <= viewportHeight) {
        return true;
      }
    }
    const room = viewportHeight - insetTop;
    if (rect.h > room) {
      const overlap = Math.min(bottom, viewportHeight) - Math.max(rect.y, insetTop);
      return overlap * 2 >= room;
    }
    return false;
  }
  if (rect.y >= 0) {
    if (bottom <= viewportHeight) {
      return true;
    }
  }
  if (rect.y <= 0) {
    return bottom >= viewportHeight;
  }
  return false;
};

// How long a glide of this many pixels takes: GLIDE_MS_MIN for a short hop, rising
// linearly to GLIDE_MS_MAX at GLIDE_PX_FULL and past it.
export const glideDurationMs = (distancePx: number): number => {
  assert(Number.isFinite(distancePx), 'glideDurationMs: a distance is a number');
  const fraction = Math.min(1, Math.abs(distancePx) / GLIDE_PX_FULL);
  const durationMs = Math.round(GLIDE_MS_MIN + (GLIDE_MS_MAX - GLIDE_MS_MIN) * fraction);
  assert(durationMs >= GLIDE_MS_MIN, 'glideDurationMs: never shorter than the minimum');
  assert(durationMs <= GLIDE_MS_MAX, 'glideDurationMs: never longer than the cap');
  return durationMs;
};

// Where a glide stands after `elapsedMs`: an ease-out cubic from `from` to `to`, so the
// page leaves fast and settles gently on the box. Exactly `to` once the time is up.
export const glidePosition = (from: number, to: number, elapsedMs: number, durationMs: number): number => {
  assert(durationMs > 0, 'glidePosition: a glide takes time');
  assert(Number.isFinite(elapsedMs), 'glidePosition: elapsed time is a number');
  if (elapsedMs >= durationMs) {
    return to;
  }
  const progress = Math.max(0, elapsedMs) / durationMs;
  const eased = 1 - (1 - progress) ** 3;
  return Math.round(from + (to - from) * eased);
};
