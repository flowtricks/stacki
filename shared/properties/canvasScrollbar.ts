// The page's scrollbar in a canvas frame: which one is drawn, and the messages between the app and the frame.
//
// A canvas frame scrolls inside itself. Chromium's own scrollbar there takes about 15px from the page on a
// computer that draws classic scrollbars (macOS "Show scroll bars: Automatic" with a mouse, Windows, most Linux
// desktops), so a 320px phone frame laid its content out in 305px while its media queries and `vw` units still
// read 320, and text wrapped where it never wraps on a phone. A phone or a tablet floats its scrollbar over the
// page and takes no width.
//
// So the frame draws no root scrollbar of its own, and the page gets the frame's whole width at every breakpoint.
// The canvas draws a thin scrollbar of its own beside the frame instead (CanvasScrollbar.tsx): always visible, so
// the person sees where they are in the page, and draggable. A person who wants the real desktop look picks a
// breakpoint in Settings (`canvasScrollbar`): frames at that breakpoint's canvas width and wider then keep
// Chromium's own scrollbar, as a desktop browser with a mouse does, and the canvas draws none beside them.
//
// Messages:
//   app → frame  `avb:canvas-scrollbar` { chromiumFromPx? }  sent on every page load: where Chromium's bar starts.
//   frame → app  `avb:page-scroll` { topPx, heightPx, viewHeightPx, chromium }  the page's vertical scroll.
//   app → frame  `avb:page-scroll-to` { topPx }  a drag or a click on the canvas's scrollbar.
// Only the root scrollbar is touched: the page's own inner scroll areas (a menu, a carousel) keep theirs.

import { assert } from '../core/assert';
import { iconFor } from './breakpointIcon';
import type { CanvasScrollbarPreference } from './canvasScrollbarChoice';
import { BREAKPOINT_LIMITS, DESKTOP_ID, type ResolvedBreakpoint } from './projectBreakpoints';

export const CANVAS_SCROLLBAR_MESSAGE = 'avb:canvas-scrollbar';
export const PAGE_SCROLL_MESSAGE = 'avb:page-scroll';
export const PAGE_SCROLL_TO_MESSAGE = 'avb:page-scroll-to';

export const CANVAS_SCROLLBAR_LIMITS = {
  /** The tallest page a scroll report describes, in CSS pixels (a 1000-screen page fits with room). */
  pagePxMax: 10_000_000,
  /** The shortest thumb, in screen pixels: a long page keeps a thumb a pointer can catch. */
  thumbScreenPxMin: 24,
} as const satisfies Record<string, number>;

// ───────────────────────────── The preference ─────────────────────────────
// Its stored form and parser are in canvasScrollbarChoice.ts.

/**
 * The frame width from which Chromium draws its own scrollbar: the chosen breakpoint's canvas width (Laptop's 1023px
 * for `width < 64rem`), so that breakpoint and every wider frame keep it; for Desktop (`desktop`, an id no breakpoint
 * may take), one pixel past the widest narrower breakpoint. Undefined: the canvas's bar everywhere,
 * which is also the answer for a breakpoint this project does not have.
 */
export function chromiumScrollbarFromPx(preference: CanvasScrollbarPreference, breakpoints: readonly ResolvedBreakpoint[]): number | undefined {
  if (preference.kind === 'off') {
    return undefined;
  }
  if (preference.breakpointId === DESKTOP_ID) {
    return desktopFromPx(breakpoints);
  }
  const breakpoint = chromiumScrollbarBreakpoints(breakpoints).find((candidate) => candidate.id === preference.breakpointId);
  if (breakpoint === undefined) {
    return undefined;
  }
  assert(widthPxValid(breakpoint.widthPx), 'chromiumScrollbarFromPx: a canvas width within the breakpoint bounds');
  return breakpoint.widthPx;
}

// ───────────────────────────── App → frame: where Chromium's bar starts ─────────────────────────────

export interface CanvasScrollbarMessage {
  readonly type: typeof CANVAS_SCROLLBAR_MESSAGE;
  /** Frames this wide and wider keep Chromium's scrollbar; absent: no frame does. */
  readonly chromiumFromPx?: number;
}

export function canvasScrollbarMessage(chromiumFromPx: number | undefined): CanvasScrollbarMessage {
  const message: CanvasScrollbarMessage =
    chromiumFromPx === undefined ? { type: CANVAS_SCROLLBAR_MESSAGE } : { type: CANVAS_SCROLLBAR_MESSAGE, chromiumFromPx };
  assert(parseCanvasScrollbarMessage(message) !== undefined, 'canvasScrollbarMessage: the message parses');
  return message;
}

/** The message if `input` is one; undefined for anything else, including a width out of bounds. */
export function parseCanvasScrollbarMessage(input: unknown): CanvasScrollbarMessage | undefined {
  if (!messageOfType(input, CANVAS_SCROLLBAR_MESSAGE)) {
    return undefined;
  }
  const chromiumFromPx: unknown = Reflect.get(input, 'chromiumFromPx');
  if (chromiumFromPx === undefined) {
    return { type: CANVAS_SCROLLBAR_MESSAGE };
  }
  if (typeof chromiumFromPx !== 'number') {
    return undefined;
  }
  if (widthPxValid(chromiumFromPx)) {
    return { type: CANVAS_SCROLLBAR_MESSAGE, chromiumFromPx };
  }
  return undefined;
}

/**
 * The stylesheet a frame applies: no root scrollbar, everywhere or below `chromiumFromPx`. `scrollbar-width: none`
 * on the root takes the bar out of the layout with its gutter (`scrollbar-gutter: stable`, `overflow-y: scroll`) and
 * outranks `::-webkit-scrollbar` styles; `!important` keeps it above the page's own root `scrollbar-width`. A media
 * query, not a message per resize: a frame dragged across the width switches by itself.
 */
export function canvasScrollbarCss(chromiumFromPx: number | undefined): string {
  const rule = 'html { scrollbar-width: none !important; }';
  if (chromiumFromPx === undefined) {
    return rule;
  }
  assert(widthPxValid(chromiumFromPx), 'canvasScrollbarCss: a canvas width within the breakpoint bounds');
  return `@media (width < ${chromiumFromPx}px) { ${rule} }`;
}

/** The media query a frame answers to know whether Chromium draws its bar there; undefined: it never does. */
export function chromiumScrollbarQuery(chromiumFromPx: number | undefined): string | undefined {
  if (chromiumFromPx === undefined) {
    return undefined;
  }
  assert(widthPxValid(chromiumFromPx), 'chromiumScrollbarQuery: a canvas width within the breakpoint bounds');
  return `(width >= ${chromiumFromPx}px)`;
}

// ───────────────────────────── Frame → app: the page's scroll ─────────────────────────────

/** Where the page is scrolled, in the frame's CSS pixels. */
export interface PageScroll {
  readonly topPx: number;
  readonly heightPx: number;
  readonly viewHeightPx: number;
  /** Chromium draws its own scrollbar in this frame: the canvas draws none. */
  readonly chromium: boolean;
}

export interface PageScrollMessage extends PageScroll {
  readonly type: typeof PAGE_SCROLL_MESSAGE;
}

export function pageScrollMessage(scroll: PageScroll): PageScrollMessage {
  const message = { type: PAGE_SCROLL_MESSAGE, ...scroll } as const;
  assert(parsePageScrollMessage(message) !== undefined, 'pageScrollMessage: the message parses');
  return message;
}

export function parsePageScrollMessage(input: unknown): PageScrollMessage | undefined {
  if (!messageOfType(input, PAGE_SCROLL_MESSAGE)) {
    return undefined;
  }
  const topPx = pagePx(Reflect.get(input, 'topPx'));
  const heightPx = pagePx(Reflect.get(input, 'heightPx'));
  const viewHeightPx = pagePx(Reflect.get(input, 'viewHeightPx'));
  const chromium: unknown = Reflect.get(input, 'chromium');
  if (topPx === undefined || heightPx === undefined || viewHeightPx === undefined) {
    return undefined;
  }
  if (typeof chromium !== 'boolean') {
    return undefined;
  }
  return { type: PAGE_SCROLL_MESSAGE, topPx, heightPx, viewHeightPx, chromium };
}

// ───────────────────────────── App → frame: scroll to ─────────────────────────────

export interface PageScrollToMessage {
  readonly type: typeof PAGE_SCROLL_TO_MESSAGE;
  readonly topPx: number;
}

export function pageScrollToMessage(topPx: number): PageScrollToMessage {
  const message = { type: PAGE_SCROLL_TO_MESSAGE, topPx } as const;
  assert(parsePageScrollToMessage(message) !== undefined, 'pageScrollToMessage: the message parses');
  return message;
}

export function parsePageScrollToMessage(input: unknown): PageScrollToMessage | undefined {
  if (!messageOfType(input, PAGE_SCROLL_TO_MESSAGE)) {
    return undefined;
  }
  const topPx = pagePx(Reflect.get(input, 'topPx'));
  return topPx === undefined ? undefined : { type: PAGE_SCROLL_TO_MESSAGE, topPx };
}

// ───────────────────────────── The thumb ─────────────────────────────

/** The thumb on a track, in the track's own pixels. */
export interface ScrollThumb {
  readonly offsetPx: number;
  readonly lengthPx: number;
}

/**
 * Where the thumb sits on a track `trackPx` long, as long as the visible share of the page and never shorter than
 * `lengthPxMin`. Undefined when the page does not scroll: a bar with nothing to move would only be noise.
 */
export function scrollThumb(scroll: Pick<PageScroll, 'topPx' | 'heightPx' | 'viewHeightPx'>, trackPx: number, lengthPxMin: number): ScrollThumb | undefined {
  assert(trackPx >= 0, 'scrollThumb: a track has a length');
  assert(lengthPxMin >= 0, 'scrollThumb: a thumb has a length');
  const rangePx = scroll.heightPx - scroll.viewHeightPx;
  if (rangePx > 0) {
    const lengthPx = Math.min(trackPx, Math.max(lengthPxMin, (trackPx * scroll.viewHeightPx) / scroll.heightPx));
    const share = Math.min(1, Math.max(0, scroll.topPx / rangePx));
    const thumb = { offsetPx: (trackPx - lengthPx) * share, lengthPx };
    assert(thumb.offsetPx + thumb.lengthPx <= trackPx + 1e-6, 'scrollThumb: the thumb stays on its track');
    return thumb;
  }
  return undefined;
}

/** The page scroll that puts the thumb at `offsetPx`: `scrollThumb` read backwards, clamped to the page. */
export function scrollTopForThumb(scroll: Pick<PageScroll, 'heightPx' | 'viewHeightPx'>, trackPx: number, lengthPxMin: number, offsetPx: number): number {
  const rangePx = Math.max(0, scroll.heightPx - scroll.viewHeightPx);
  const thumb = scrollThumb({ topPx: 0, ...scroll }, trackPx, lengthPxMin);
  if (thumb === undefined) {
    return 0;
  }
  const travelPx = trackPx - thumb.lengthPx;
  if (travelPx > 0) {
    const topPx = (Math.min(travelPx, Math.max(0, offsetPx)) / travelPx) * rangePx;
    assert(topPx >= 0, 'scrollTopForThumb: never above the page');
    assert(topPx <= rangePx, 'scrollTopForThumb: never past the page');
    return topPx;
  }
  return 0;
}

// ───────────────────────────── Helpers ─────────────────────────────

function messageOfType(input: unknown, type: string): input is object {
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  return Reflect.get(input, 'type') === type;
}

/**
 * The breakpoints Chromium's bar may start from, widest first: the wider ones and the narrower ones a computer is (the Laptop
 * icon, by position in the list as the toolbar decides it, never by name). A tablet, a phone or a watch floats its scrollbar
 * over the page, so Chromium's classic bar there would show a page no such device draws. Desktop, not a breakpoint, is
 * offered between the wider and the narrower ones.
 */
export function chromiumScrollbarBreakpoints(breakpoints: readonly ResolvedBreakpoint[]): readonly ResolvedBreakpoint[] {
  assert(breakpoints.length <= BREAKPOINT_LIMITS.countMax, 'chromiumScrollbarBreakpoints: the breakpoint list is within its bound');
  const computers = breakpoints.filter((breakpoint) => breakpoint.direction === 'up' || iconFor(breakpoint, breakpoints) === 'laptop');
  const widestFirst = [...computers].sort((first, second) => second.widthPx - first.widthPx);
  assert(widestFirst.length <= breakpoints.length, 'chromiumScrollbarBreakpoints: a choice per breakpoint at most');
  return widestFirst;
}

// Desktop is not a breakpoint but the base between them: it starts one pixel past the widest narrower breakpoint
// (Laptop's 1023px, so 1024), the width its fluid frame takes in any pane wider than that. Desktop's own frame width
// in Settings is only where the side-by-side view draws it, never a query. With no narrower breakpoint, every frame
// below the wider ones is Desktop, so the narrowest frame width keeps Chromium's bar.
function desktopFromPx(breakpoints: readonly ResolvedBreakpoint[]): number {
  const narrower = breakpoints.filter((breakpoint) => breakpoint.direction === 'down');
  const widthPx = narrower.length === 0 ? BREAKPOINT_LIMITS.boundaryPxMin - 1 : Math.max(...narrower.map((breakpoint) => breakpoint.widthPx)) + 1;
  assert(narrower.length <= BREAKPOINT_LIMITS.countMax, 'desktopFromPx: the breakpoint list is within its bound');
  assert(widthPxValid(widthPx), 'desktopFromPx: a canvas width within the breakpoint bounds');
  return widthPx;
}

// A canvas width is a whole pixel count inside the bounds a breakpoint boundary keeps.
function widthPxValid(widthPx: number): boolean {
  if (!Number.isSafeInteger(widthPx)) {
    return false;
  }
  if (widthPx < BREAKPOINT_LIMITS.boundaryPxMin - 1) {
    return false;
  }
  return widthPx <= BREAKPOINT_LIMITS.boundaryPxMax;
}

// A scroll position or a height: finite, never negative, within the page bound.
function pagePx(input: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return undefined;
  }
  if (input < 0) {
    return undefined;
  }
  return input <= CANVAS_SCROLLBAR_LIMITS.pagePxMax ? input : undefined;
}
