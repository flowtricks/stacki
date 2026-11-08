// Bringing a selection into view on the canvas: the one reveal that Desktop's
// frame (frameReports.ts) and Studio's (studio previewClient.ts) both run, so a
// Navigator pick moves a page the same way on either canvas.
//
// Real sites make this harder than one `scrollTo` in two ways, and both are
// handled here without the site changing anything:
//
// - The page may not scroll at all. `html, body { height: 100%; overflow:
//   hidden }` with a scrolling wrapper is a common app-shell layout, and there
//   the window has nowhere to go. So the reveal scrolls the element's nearest
//   scrolling ancestor, which is the window on most pages.
// - A smooth-scroll library may own the position. Lenis, GSAP ScrollSmoother
//   and Locomotive v5 (built on Lenis) keep a scroll position of their own and
//   write it to the page on every animation frame while they animate, which
//   undoes a programmatic scroll; when they are idle they follow native scroll
//   events instead. The frame cannot reach the library: Desktop's preload runs
//   in an isolated world that never sees the page's globals, and a site need not
//   publish its instance anyway. So the reveal relies on the one behaviour they
//   share: it watches the scroll it made, lets a library's animation run out,
//   and then jumps again, which the now-idle library adopts.
//
// Every scroll a reveal makes is instant. The browser's own smooth scroll is an
// animation the reveal can neither see nor stop: on GitHub's Linux runner (xvfb)
// one still in flight carried on after the reveal had jumped, and after the next
// placement of the page, landing thousands of pixels past the box and moving a
// page that should have stayed put. A jump is synchronous, so what the reveal
// reads afterwards is what it did.
//
// What is out of reach: a library that never scrolls natively and moves the page
// with a transform instead (Locomotive v4's smooth mode). No scroll position
// exists there to set, and only its own instance could move it.

import { assert } from '../../shared/core/assert';
import { splitPseudoPath } from '../../shared/page/pseudoPath';
import type { Rect } from './frameBasics';
import { isElement } from './frameBasics';
import { rectsForPath } from './frameMeasure';
import { elementsWithPath, runsOf, taggedPlaces } from './frameRegions';

// Brings one occurrence of a path into view, when it is out of sight. Nothing
// moves when the path has no box, is the page itself, or has any part showing
// (boxShowing). Desktop and Studio both reveal through this, so a selection
// behaves the same on either canvas.
//
// Only ever vertically. A site is routinely wider than the frame on purpose — a
// hero video bleeding off the right, a track of cards, a decorative circle
// hanging off the edge — and clips it with `overflow-x: hidden` or `clip` on the
// body or a wrapper. Scrolling sideways to reveal such a node moves a viewport
// the site never meant to scroll, and nothing on the canvas can scroll it back:
// the page stays stuck to one side. `scrollIntoView` is worse still, because it
// also scrolls every clipping ancestor on the way. So the target is computed
// here, vertically, and only the one scroller that holds the box moves.
export const revealPath = (nodePath: string, occurrence: number): void => {
  assert(Number.isSafeInteger(occurrence), 'revealPath: an occurrence is an integer');
  assert(occurrence >= 0, 'revealPath: an occurrence is never negative');
  // Whatever an earlier reveal was still watching for is stale now, even when this
  // one has nothing to move: left running, it would jump the page back to the old
  // target once the page went quiet, under a selection that is somewhere else.
  cancelReveal();
  assert(stopWatch === undefined, 'revealPath: no earlier reveal is still watching');
  const box = boxOf(nodePath, occurrence);
  if (box === undefined) {
    return;
  }
  if (pathIsPageRoot(box.measuredPath)) {
    return;
  }
  const anchor = anchorOf(nodePath, occurrence);
  const scroller = anchor === undefined ? undefined : nearestScroller(anchor);
  const scrollport = scroller === undefined ? PAGE_SCROLLPORT : elementScrollport(scroller);
  const measure = (): Landing | undefined => landingOf(scrollport, boxOf(nodePath, occurrence)?.rect);
  const first = measure();
  if (first === undefined) {
    return;
  }
  if (first.showing) {
    return;
  }
  scrollport.scrollTo(first.top);
  watchReveal(scrollport, measure);
};

// Ends the reveal in progress, if any. Every new reveal does this first, and a
// canvas selects with it too: once the selection has moved on, the old target
// must never be acted on.
export const cancelReveal = (): void => {
  stopWatch?.();
  assert(stopWatch === undefined, 'cancelReveal: a stopped watch forgets itself');
};

// Something that scrolls vertically: the page, or one element on it.
interface Scrollport {
  readonly position: () => number;
  // The furthest down it can go: a target past it is clamped, or it never arrives.
  readonly positionMax: () => number;
  // Where its visible area starts, from the top of the frame, and how tall it is.
  readonly viewTop: () => number;
  readonly viewHeight: () => number;
  // Always instant: see the note at the top of this file.
  readonly scrollTo: (top: number) => void;
  // Where the events a person scrolls with arrive.
  readonly events: EventTarget;
  // Where its own `scroll` events fire, whoever moved it.
  readonly moves: EventTarget;
}

const PAGE_SCROLLPORT: Scrollport = {
  position: () => window.scrollY,
  positionMax: () => {
    const page = document.scrollingElement ?? document.documentElement;
    return Math.max(0, page.scrollHeight - page.clientHeight);
  },
  viewTop: () => 0,
  viewHeight: () => window.innerHeight || document.documentElement.clientHeight,
  // No `left`: the horizontal scroll stays wherever it is (see revealPath).
  scrollTo: (top) => window.scrollTo({ top, behavior: 'instant' }),
  // Read when a reveal starts, not when the module loads: the frame's modules are also
  // loaded where there is no window (frameReports' tests), and the page's window is
  // the same object either way.
  get events(): EventTarget {
    return window;
  },
  get moves(): EventTarget {
    return window;
  },
};

const elementScrollport = (element: Element): Scrollport => ({
  position: () => element.scrollTop,
  positionMax: () => Math.max(0, element.scrollHeight - element.clientHeight),
  viewTop: () => element.getBoundingClientRect().top + element.clientTop,
  viewHeight: () => element.clientHeight,
  scrollTo: (top) => element.scrollTo({ top, behavior: 'instant' }),
  // A wheel over the scroller and a key pressed anywhere both reach the window.
  events: window,
  moves: element,
});

// Where a box is against its scroller right now, read in one go: the scroller's
// position, whether any of the box shows, and the absolute position that would
// land it, clamped to the scroller's range. Every decision the watch makes reads
// a fresh one, so a jump always goes to a place worked out from where the box is
// now, never by adding a distance to a position that may have moved since.
interface Landing {
  readonly position: number;
  readonly showing: boolean;
  readonly top: number;
}

const landingOf = (scrollport: Scrollport, rect: Rect | undefined): Landing | undefined => {
  if (rect === undefined) {
    return undefined;
  }
  const viewHeight = scrollport.viewHeight();
  const position = scrollport.position();
  const inView = { ...rect, y: rect.y - scrollport.viewTop() };
  const top = Math.min(landingTop(inView, viewHeight, position), scrollport.positionMax());
  assert(Number.isFinite(top), 'landingOf: a landing is a number');
  assert(top >= 0, 'landingOf: a landing is never above the top');
  return { position, showing: boxShowing(inView, viewHeight), top };
};

// The watch after a reveal's jump. A smooth-scroll library animating when the
// reveal arrives replaces the position on every one of its frames until its
// animation ends, which undoes the jump. So the watch waits for the page to go
// quiet, and jumps again if the box is not where the reveal put it. While the
// page still moves, the watch waits, whichever way it goes: a library pulls it
// back toward its own target before it lets go.
//
// A person who scrolls in the meantime has taken over, and is left alone. That
// is told by their input (a wheel, a touch, a key, a press on a scrollbar) and
// not by the direction of travel, which a library's animation shares.
//
// "Quiet" is measured against the page's own pace, not a fixed time. A library
// writes once per animation frame, and frames arrive late on a slow machine: the
// Linux release runner draws about one every 200ms, and runs every animation, the
// library's glide included, at a quarter of its speed. A fixed stillness of a few
// checks read a gap between two of those frames as the end of the glide. So the
// watch times the gaps between the page's scroll events and needs the page to
// hold still for twice the longest one (at least QUIET_MS_MIN) before it jumps
// again, or before it calls the box landed and lets go.
//
// Bounded on two counts: REVEAL_CHECKS_MAX looks, REVEAL_CHECK_MS apart, which
// outlasts a glide even at a quarter speed; and REVEAL_JUMPS_MAX jumps, so a page
// that keeps moving itself is not fought for that whole time.
const REVEAL_CHECK_MS = 100;
const REVEAL_CHECKS_MAX = 300;
const REVEAL_JUMPS_MAX = 10;
const QUIET_MS_MIN = 300;
// A gap longer than this is the page at rest between two unrelated moves, not a
// slow frame, and must not stretch the wait.
const FRAME_GAP_MS_MAX = 1_000;
const ARRIVED_PX = 1;
const TAKEOVER_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

let stopWatch: (() => void) | undefined;

const watchReveal = (scrollport: Scrollport, measure: () => Landing | undefined): void => {
  assert(stopWatch === undefined, 'watchReveal: the reveal before it was cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checks = 0;
  let jumps = 1; // The reveal's own scroll.
  let last = scrollport.position();
  let movedAt = performance.now();
  let frameGapMs = 0;
  const moved = (): void => {
    const now = performance.now();
    const gapMs = now - movedAt;
    if (gapMs <= FRAME_GAP_MS_MAX) {
      frameGapMs = Math.max(frameGapMs, gapMs);
    }
    movedAt = now;
  };
  const stop = (): void => {
    clearTimeout(timer);
    for (const type of TAKEOVER_EVENTS) {
      scrollport.events.removeEventListener(type, stop, true);
    }
    scrollport.moves.removeEventListener('scroll', moved);
    if (stopWatch === stop) {
      stopWatch = undefined;
    }
  };
  const check = (): void => {
    checks += 1;
    assert(checks <= REVEAL_CHECKS_MAX, 'watchReveal: the watch is bounded');
    const landing = measure();
    if (landing === undefined) {
      stop(); // The box has gone: nothing is left to reveal.
      return;
    }
    if (Math.abs(landing.position - last) > ARRIVED_PX) {
      // A move the scroll event has not reported yet still counts.
      movedAt = Math.max(movedAt, performance.now() - REVEAL_CHECK_MS);
    }
    last = landing.position;
    const step = revealStep({
      arrived: Math.abs(landing.position - landing.top) <= ARRIVED_PX,
      quietMs: performance.now() - movedAt,
      quietMsNeeded: Math.max(QUIET_MS_MIN, frameGapMs * 2),
      checksLeft: REVEAL_CHECKS_MAX - checks,
      jumpsLeft: REVEAL_JUMPS_MAX - jumps,
    });
    switch (step) {
      case 'done':
        stop();
        return;
      case 'wait':
        break;
      case 'jump':
        jumps += 1;
        scrollport.scrollTo(landing.top);
        last = scrollport.position();
        movedAt = performance.now();
        break;
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
    if (checks < REVEAL_CHECKS_MAX) {
      timer = setTimeout(check, REVEAL_CHECK_MS);
    } else {
      stop();
    }
  };
  for (const type of TAKEOVER_EVENTS) {
    scrollport.events.addEventListener(type, stop, { capture: true, passive: true });
  }
  scrollport.moves.addEventListener('scroll', moved, { passive: true });
  stopWatch = stop;
  timer = setTimeout(check, REVEAL_CHECK_MS);
};

// What the watch does after one look at the page, kept free of the timers.
type RevealStep = 'done' | 'wait' | 'jump';

const revealStep = (look: {
  readonly arrived: boolean;
  readonly quietMs: number;
  readonly quietMsNeeded: number;
  readonly checksLeft: number;
  readonly jumpsLeft: number;
}): RevealStep => {
  assert(look.checksLeft >= 0, 'revealStep: the watch has checks left to count');
  assert(look.jumpsLeft >= 0, 'revealStep: the watch never jumps past its bound');
  assert(look.quietMsNeeded >= QUIET_MS_MIN, 'revealStep: quiet is never judged on less than the minimum');
  const quiet = look.quietMs >= look.quietMsNeeded;
  if (look.arrived) {
    // Landed, and held long enough that a library's next frame would have shown.
    if (quiet) {
      return 'done';
    }
    return look.checksLeft === 0 ? 'done' : 'wait';
  }
  if (look.jumpsLeft === 0) {
    return 'done'; // The jumps are spent: a page that keeps moving itself wins.
  }
  if (quiet) {
    return 'jump'; // Quiet away from the landing: let go of by a library's animation.
  }
  // Still moving, or not quiet long enough to tell. The last look jumps anyway.
  return look.checksLeft === 0 ? 'jump' : 'wait';
};

// An element that stands for one occurrence of a path, to find what scrolls it.
// A ::before or ::after is scrolled by whatever scrolls its element.
const anchorOf = (nodePath: string, occurrence: number): Element | undefined => {
  const hostPath = splitPseudoPath(nodePath)?.nodePath ?? nodePath;
  const runs = runsOf(hostPath);
  if (runs !== undefined) {
    const run = runs[occurrence] ?? runs[0];
    const first = run?.[0];
    if (first === undefined) {
      return undefined;
    }
    const element = run?.find(isElement);
    return element ?? first.parentElement ?? undefined;
  }
  const places = taggedPlaces(hostPath);
  return (places[occurrence] ?? places[0])?.el;
};

// The box a reveal brings into view, and the path it was measured on: a ::before
// or ::after that paints no box has nothing of its own to reveal, so its element
// stands in. The row was picked to get to that place on the page.
const boxOf = (nodePath: string, occurrence: number): { readonly rect: Rect; readonly measuredPath: string } | undefined => {
  const measuredPath = rectsForPath(nodePath) === undefined ? (splitPseudoPath(nodePath)?.nodePath ?? nodePath) : nodePath;
  const rects = rectsForPath(measuredPath);
  const rect = rects?.[occurrence] ?? rects?.[0]; // Viewport-relative.
  return rect === undefined ? undefined : { rect, measuredPath };
};

// Whether a path names <html> or <body>, the page itself. Their boxes say nothing
// about what the person can see: with `html, body { height: 100% }`, which is
// common, a taller page overflows them, so a page scrolled past the first screen
// leaves their boxes above the frame while the page they stand for fills it.
const pathIsPageRoot = (nodePath: string): boolean => {
  const roots: readonly Element[] = [document.documentElement, document.body];
  return elementsWithPath(nodePath).some((element) => roots.includes(element));
};

// How far up the page the search for a scroller goes. Pages nest far less than
// this; past it the window is assumed, which is what most pages scroll anyway.
const ANCESTORS_MAX = 512;

// The nearest ancestor that scrolls vertically and is not the page itself, or
// nothing when the window is what scrolls the element.
//
// Only real scrollers count: overflow `auto` or `scroll` with content past the
// bottom. A box that clips (`hidden`, `clip`) is one the site never meant anyone
// to scroll, and moving it leaves the page stuck where nothing can scroll it back
// (see revealPath). `overflow-x: hidden` makes overflow-y compute to `auto`
// as well, but such a box grows with its content, so it has nothing to scroll.
//
// <body> scrolls itself only when <html> does not let its overflow through to
// the window; otherwise its `overflow` is the window's and the window scrolls.
const nearestScroller = (element: Element): Element | undefined => {
  const root = document.documentElement;
  const page = document.scrollingElement ?? root;
  let ancestor = element.parentElement;
  for (let depth = 0; depth < ANCESTORS_MAX; depth += 1) {
    if (ancestor === null) {
      return undefined;
    }
    if (ancestor === page) {
      return undefined;
    }
    if (ancestor === root) {
      return undefined;
    }
    if (scrollsItself(ancestor, root)) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return undefined;
};

const SCROLLING_OVERFLOW: ReadonlySet<string> = new Set(['auto', 'scroll', 'overlay']);

const scrollsItself = (element: Element, root: Element): boolean => {
  assert(element !== root, 'scrollsItself: the page root is the window, never an inner scroller');
  if (element.scrollHeight <= element.clientHeight + ARRIVED_PX) {
    return false;
  }
  if (!SCROLLING_OVERFLOW.has(getComputedStyle(element).overflowY)) {
    return false;
  }
  if (element === document.body) {
    // Propagated to the window when <html> is left visible.
    return getComputedStyle(root).overflowY !== 'visible';
  }
  return true;
};

// The scroll position that lands a box: centred in its scroller's visible area,
// or, for a box too tall to centre, its top SCROLL_MARGIN below the top of that
// area, since centring would push its beginning out. `rect.y` is measured from
// the top of the visible area. Absolute, and stable: read again once the box is
// there, it gives the same position, so repeating a jump never moves the page.
// The margin says where a reveal lands, not what counts as seen (boxShowing).
const SCROLL_MARGIN = 24;

const landingTop = (rect: Rect, viewportHeight: number, scrollTop: number): number => {
  assert(viewportHeight >= 0, 'landingTop: a scroller has a height');
  assert(Number.isFinite(scrollTop), 'landingTop: a scroller has a position');
  const offset = rect.h >= viewportHeight - SCROLL_MARGIN * 2 ? SCROLL_MARGIN : Math.floor((viewportHeight - rect.h) / 2);
  const target = Math.max(0, Math.round(scrollTop + rect.y - offset));
  assert(target >= 0, 'landingTop: a scroll position is never negative');
  return target;
};

// Whether a reveal should leave a box alone. One pixel inside the view is
// enough: the person can see where the box is, and moving the page under them to
// show the rest costs more than it gives. A box that only touches the edge shows
// nothing, so it is not in view.
//
// A box with no area has no part to show, so it stays judged whole: all of it
// inside the view, edges included, or covering the view from edge to edge.
const boxShowing = (rect: Rect, viewportHeight: number): boolean => {
  assert(rect.w >= 0, 'boxShowing: a box has no negative width');
  assert(rect.h >= 0, 'boxShowing: a box has no negative height');
  const bottom = rect.y + rect.h;
  if (rect.w > 0) {
    if (rect.h > 0) {
      return rect.y < viewportHeight ? bottom > 0 : false;
    }
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
