// The page's scrollbar in a canvas frame, and the messages between the app and the frame.
//
// A canvas frame scrolls inside itself. Chromium's own scrollbar there takes about 15px from the page on a
// computer that draws classic scrollbars (macOS "Show scroll bars: Automatic" with a mouse, Windows, most Linux
// desktops), so a 320px phone frame laid its content out in 305px while its media queries and `vw` units still
// read 320, and text wrapped where it never wraps on a phone. A phone or a tablet floats its scrollbar over the
// page and takes no width.
//
// So the frame draws no root scrollbar of its own, and the page gets the frame's whole width at every breakpoint.
// The canvas draws a thin scrollbar of its own beside the frame instead (CanvasScrollbar.tsx): always visible, so
// the person sees where they are in the page, and draggable. There is one behaviour and no setting: a classic bar
// at some widths only would make the canvas lay a page out narrower than the breakpoint it claims to show.
//
// Messages:
//   app → frame  `avb:canvas-scrollbar` {}  sent on every page load: hide the page's own scrollbar.
//   frame → app  `avb:page-scroll` { topPx, heightPx, viewHeightPx, chromium }  the page's vertical scroll.
//   app → frame  `avb:page-scroll-to` { topPx }  a drag or a click on the canvas's scrollbar.
// Only the page's scrolling root is touched (<html>, or <body> on a page that scrolls its body): the page's own
// inner scroll areas (a menu, a carousel) keep theirs.

import { assert } from '../core/assert';

export const CANVAS_SCROLLBAR_MESSAGE = 'avb:canvas-scrollbar';
export const PAGE_SCROLL_MESSAGE = 'avb:page-scroll';
export const PAGE_SCROLL_TO_MESSAGE = 'avb:page-scroll-to';

export const CANVAS_SCROLLBAR_LIMITS = {
  /** The tallest page a scroll report describes, in CSS pixels (a 1000-screen page fits with room). */
  pagePxMax: 10_000_000,
  /** The shortest thumb, in screen pixels: a long page keeps a thumb a pointer can catch. */
  thumbScreenPxMin: 24,
} as const satisfies Record<string, number>;

/**
 * The stylesheet a frame applies once told: no scrollbar on the page's scrolling root. `scrollbar-width: none` takes
 * the bar out of the layout with its gutter (`scrollbar-gutter: stable`, `overflow-y: scroll`) and outranks
 * `::-webkit-scrollbar` styles; `!important` keeps it above the page's own `scrollbar-width`. <body> is named too, for
 * a page whose <html> does not scroll and whose <body> does; on a <body> that does not scroll, the rule changes nothing.
 */
export const CANVAS_SCROLLBAR_CSS = 'html, body { scrollbar-width: none !important; }';

// ───────────────────────────── App → frame: hide the page's bar ─────────────────────────────

export interface CanvasScrollbarMessage {
  readonly type: typeof CANVAS_SCROLLBAR_MESSAGE;
}

export function canvasScrollbarMessage(): CanvasScrollbarMessage {
  const message: CanvasScrollbarMessage = { type: CANVAS_SCROLLBAR_MESSAGE };
  assert(parseCanvasScrollbarMessage(message) !== undefined, 'canvasScrollbarMessage: the message parses');
  return message;
}

/** The message if `input` is one; undefined for anything else. Other fields are ignored (an older app sent a width). */
export function parseCanvasScrollbarMessage(input: unknown): CanvasScrollbarMessage | undefined {
  if (messageOfType(input, CANVAS_SCROLLBAR_MESSAGE)) {
    return { type: CANVAS_SCROLLBAR_MESSAGE };
  }
  return undefined;
}

// ───────────────────────────── Frame → app: the page's scroll ─────────────────────────────

/** Where the page is scrolled, in the frame's CSS pixels. */
export interface PageScroll {
  readonly topPx: number;
  readonly heightPx: number;
  readonly viewHeightPx: number;
  /** The frame still draws Chromium's own scrollbar (the app's word has not arrived yet): the canvas draws none. */
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
