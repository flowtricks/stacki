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
// Every scroll a reveal makes is instant, and the smoothness is the reveal's own: a
// glide (frameRevealGlide.ts) of instant scrolls, one per animation frame. The browser's
// own smooth scroll is an animation the reveal can neither see nor stop: on GitHub's
// Linux runner (xvfb) one still in flight carried on after the reveal had jumped, and
// after the next placement of the page, landing thousands of pixels past the box and
// moving a page that should have stayed put. An instant scroll is synchronous, so what
// the reveal reads afterwards is what it did, and it ignores the site's
// `scroll-behavior`, so a page that forces `auto` or `smooth` glides the same. A person
// who scrolls, or asks for reduced motion, gets their way: the glide ends where they
// put the page, and reduced motion lands in one jump.
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
import type { GlideMove } from './frameRevealGlide';
import { startGlide, TAKEOVER_EVENTS } from './frameRevealGlide';
import { boxComfortable, INSET_FRACTION_MAX, landingTop } from './frameRevealMath';

// Brings one occurrence of a path into view, when it is not comfortably in sight
// (boxComfortable). Nothing moves when the path has no box, is the page itself, or is
// fixed to the frame. The page glides there, and a selection that arrives mid-glide
// starts a new one from wherever the page has got to. Desktop and Studio both reveal through this, so a selection
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
    undrawn = { nodePath, occurrence };
    return;
  }
  if (pathIsPageRoot(box.measuredPath)) {
    return;
  }
  const anchor = anchorOf(nodePath, occurrence);
  if (anchor !== undefined && isPinned(anchor)) {
    return; // A fixed box does not move with the page: scrolling cannot bring it closer.
  }
  const scroller = anchor === undefined ? undefined : nearestScroller(anchor);
  // Innermost first: a box in a scroller is brought into that scroller, then the page
  // is moved if the scroller itself is out of view, since a box "in view" of a panel
  // below the fold is still nowhere the person can see. The glide moves them together,
  // so the page's landing is worked out as if the scroller had already landed the box.
  // Only the outermost move is watched: a smooth-scroll library fights the page, never
  // a panel inside it.
  const scrollports = scroller === undefined ? [PAGE_SCROLLPORT] : [elementScrollport(scroller), PAGE_SCROLLPORT];
  const pageInsetTop = stickyInsetOf(anchor);
  const insetOf = (scrollport: Scrollport): number => (scrollport === PAGE_SCROLLPORT ? pageInsetTop : 0);
  const moves: GlideMove[] = [];
  let watched: Scrollport | undefined;
  let shiftPx = 0; // How far the scrollers before this one will carry the box up.
  for (const scrollport of scrollports) {
    const rect = boxOf(nodePath, occurrence)?.rect;
    const landing = landingOf(scrollport, rect === undefined ? undefined : { ...rect, y: rect.y - shiftPx }, insetOf(scrollport));
    if (landing === undefined) {
      return;
    }
    if (!landing.showing) {
      moves.push({ from: landing.position, to: landing.top, scrollTo: (top) => scrollport.scrollTo(top), events: scrollport.events });
      shiftPx += landing.top - landing.position;
      watched = scrollport;
    }
  }
  if (watched === undefined) {
    return;
  }
  const moved = watched;
  const watchMoved = (): void => watchReveal(moved, () => landingOf(moved, boxOf(nodePath, occurrence)?.rect, insetOf(moved)));
  if (prefersReducedMotion() || moves.every((move) => move.from === move.to)) {
    for (const move of moves) {
      move.scrollTo(move.to);
    }
    watchMoved();
    return;
  }
  const stopGlide = startGlide(moves, (outcome) => {
    stopWatch = undefined;
    if (outcome === 'arrived') {
      watchMoved();
    }
  });
  const stopGlideAndForget = (): void => {
    stopGlide();
    if (stopWatch === stopGlideAndForget) {
      stopWatch = undefined;
    }
  };
  stopWatch = stopGlideAndForget;
};

// The last reveal that found no box: a node selected before anything of it is drawn (a component
// still being rendered, framePendingInsert.ts). One, forgotten by the next reveal or canvas pick.
let undrawn: { readonly nodePath: string; readonly occurrence: number } | undefined;

/** Reveals the node the last reveal could not find, if the selection has not moved on since. */
export const revealWhenDrawn = (): void => {
  if (undrawn !== undefined) {
    revealPath(undrawn.nodePath, undrawn.occurrence);
  }
};

// Ends the reveal in progress, if any. Every new reveal does this first, and a
// canvas selects with it too: once the selection has moved on, the old target
// must never be acted on.
export const cancelReveal = (): void => {
  undrawn = undefined;
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

const landingOf = (scrollport: Scrollport, rect: Rect | undefined, insetTop: number): Landing | undefined => {
  if (rect === undefined) {
    return undefined;
  }
  const viewHeight = scrollport.viewHeight();
  const position = scrollport.position();
  const inView = { ...rect, y: rect.y - scrollport.viewTop() };
  const top = Math.min(landingTop(inView, viewHeight, position, insetTop), scrollport.positionMax());
  assert(Number.isFinite(top), 'landingOf: a landing is a number');
  assert(top >= 0, 'landingOf: a landing is never above the top');
  return { position, showing: boxComfortable(inView, viewHeight, insetTop), top };
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
// writes once per animation frame, and frames arrive late on a slow machine: a
// hidden window on GitHub's Linux runner (xvfb) can go a second or more between
// them. So the watch times the gaps between the page's scroll events and judges
// quiet against the longest one it has seen:
//
// - It jumps again once the page has held still away from the landing for twice
//   that gap (at least JUMP_QUIET_MS_MIN): the library has let go.
// - It lets go itself only once the page has held still at the landing for three
//   times that gap (at least REST_QUIET_MS_MIN), which is longer. Letting go on
//   a short stillness at the landing ended the watch between two frames of a
//   glide on the runner; the glide then carried the page on to its own target,
//   and nothing was left to bring the box back.
//
// So the watch lasts as long as the page keeps moving on its own, and ends a
// rest after it stops. Bounded on two counts as well: REVEAL_CHECKS_MAX looks,
// REVEAL_CHECK_MS apart (a minute), and REVEAL_JUMPS_MAX jumps, so a page that
// keeps undoing the reveal is not fought for all of that minute.
const REVEAL_CHECK_MS = 100;
const REVEAL_CHECKS_MAX = 600;
const REVEAL_JUMPS_MAX = 20;
const JUMP_QUIET_MS_MIN = 300;
const REST_QUIET_MS_MIN = 2_000;
// A gap longer than this is the page at rest between two unrelated moves, not a
// slow frame, and must not stretch the wait.
const FRAME_GAP_MS_MAX = 5_000;
const ARRIVED_PX = 1;

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
      jumpQuietMs: Math.max(JUMP_QUIET_MS_MIN, frameGapMs * 2),
      restQuietMs: Math.max(REST_QUIET_MS_MIN, frameGapMs * 3),
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
  readonly jumpQuietMs: number;
  readonly restQuietMs: number;
  readonly checksLeft: number;
  readonly jumpsLeft: number;
}): RevealStep => {
  assert(look.checksLeft >= 0, 'revealStep: the watch has checks left to count');
  assert(look.jumpsLeft >= 0, 'revealStep: the watch never jumps past its bound');
  assert(look.jumpQuietMs >= JUMP_QUIET_MS_MIN, 'revealStep: a jump never waits less than the minimum');
  assert(look.restQuietMs > look.jumpQuietMs, 'revealStep: letting go waits longer than jumping');
  if (look.arrived) {
    if (look.quietMs >= look.restQuietMs) {
      return 'done'; // At rest on the landing: no library is pulling it away.
    }
    return look.checksLeft === 0 ? 'done' : 'wait';
  }
  if (look.jumpsLeft === 0) {
    return 'done'; // The jumps are spent: a page that keeps undoing the reveal wins.
  }
  if (look.quietMs >= look.jumpQuietMs) {
    return 'jump'; // At rest away from the landing: let go of by a library's glide.
  }
  // Still moving on its own, or not quiet long enough to tell. The last look jumps.
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

// Whether the person asked their system for less motion: the reveal then lands in one
// jump. A frame without `matchMedia` (a test document) is read as no preference.
const prefersReducedMotion = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Whether a box, or something around it, is fixed to the frame: it stays where it is
// however the page scrolls. A sticky box is not: it scrolls until it sticks.
const isPinned = (element: Element): boolean => {
  let ancestor: Element | undefined = element;
  for (let depth = 0; depth < ANCESTORS_MAX; depth += 1) {
    if (ancestor === undefined) {
      return false;
    }
    if (getComputedStyle(ancestor).position === 'fixed') {
      return true;
    }
    ancestor = ancestor.parentElement ?? undefined;
  }
  return false;
};

// How many elements are looked at in the stack under the top edge.
const STACK_MAX = 32;

// The height of the sticky or fixed bar covering the top of the frame, or 0: a box
// landed at the very top would sit under it. Only a bar counts, not a backdrop: taller
// than INSET_FRACTION_MAX of the frame it is something else. Read once, when the
// reveal starts, so the landing does not shift as the page moves under the bar.
const stickyInsetOf = (anchor: Element | undefined): number => {
  if (typeof document.elementsFromPoint !== 'function') {
    return 0;
  }
  const viewHeight = PAGE_SCROLLPORT.viewHeight();
  const heightMax = Math.floor(viewHeight * INSET_FRACTION_MAX);
  const stack = document.elementsFromPoint(Math.floor(window.innerWidth / 2), 1).slice(0, STACK_MAX);
  let insetTop = 0;
  for (const element of stack) {
    if (anchor !== undefined && (element.contains(anchor) || anchor.contains(element))) {
      continue; // The target is not a bar over itself.
    }
    const position = getComputedStyle(element).position;
    if (position === 'fixed' || position === 'sticky') {
      const rect = element.getBoundingClientRect();
      if (rect.top <= 1 && rect.bottom > 0 && rect.height <= heightMax) {
        insetTop = Math.max(insetTop, Math.ceil(rect.bottom));
      }
    }
  }
  assert(insetTop >= 0, 'stickyInsetOf: a bar covers no negative height');
  return Math.min(insetTop, heightMax);
};
