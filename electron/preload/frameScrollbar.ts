// The frame's half of the canvas scrollbar (shared/properties/canvasScrollbar.ts), shared by Desktop's preload
// (frameQueries.ts) and Studio's preview client: hides the page's root scrollbar where the app says, reports the
// page's vertical scroll so the canvas can draw its own bar, and scrolls when that bar is dragged.
//
// Until the app's word arrives, the page keeps Chromium's scrollbar and every report says so (`chromium: true`),
// so the canvas never draws a second bar beside a frame that still shows its own.

import { assert } from '../../shared/core/assert';
import {
  CANVAS_SCROLLBAR_LIMITS,
  canvasScrollbarCss,
  chromiumScrollbarQuery,
  pageScrollMessage,
  parseCanvasScrollbarMessage,
  parsePageScrollToMessage,
  type PageScroll,
} from '../../shared/properties/canvasScrollbar';

const STYLE_ID = 'avb-canvas-scrollbar';

/** Where Chromium keeps its bar: not yet told (`unknown`, its bar everywhere), nowhere, or from a width up. */
type ChromiumRange = { readonly kind: 'unknown' } | { readonly kind: 'query'; readonly query: MediaQueryList | undefined };

let range: ChromiumRange = { kind: 'unknown' };
let post: ((message: unknown) => void) | undefined = undefined;
let reportScheduled = false;
let lastReport: PageScroll | undefined = undefined;

/**
 * Starts reporting the page's scroll to the app through `send`: on scroll and resize, after each canvas patch, and
 * when the page's height changes. Once per frame: later calls are ignored.
 */
export function installPageScrollReport(send: (message: unknown) => void): void {
  if (post !== undefined) {
    return;
  }
  post = send;
  window.addEventListener('scroll', scheduleReport, { passive: true });
  window.addEventListener('resize', scheduleReport);
  window.addEventListener('load', scheduleReport);
  document.addEventListener('avb:morphed', scheduleReport);
  observeRootWhenReady();
  scheduleReport();
  assert(post === send, 'installPageScrollReport: reports go to the sender');
}

// A page grows without scrolling (images arriving, a patch adding a section): its height is part of the thumb, so
// <html> is observed. It exists by the time a preload runs, but not always in a frame that is still being created
// (frameDesign.ts markFrameMode); observing a missing root throws, and a throw here would stop every frame module the
// preload installs after this one. So the observer waits for the root, at the first two moments it certainly exists.
function observeRootWhenReady(): void {
  if (typeof ResizeObserver !== 'function') {
    return;
  }
  const observer = new ResizeObserver(scheduleReport);
  let observed = false;
  const observe = (): void => {
    const root = document.documentElement;
    if (observed || root === null) {
      return;
    }
    observer.observe(root);
    observed = true;
  };
  observe();
  document.addEventListener('readystatechange', observe);
  window.addEventListener('DOMContentLoaded', observe);
}

/** Applies an app message if it is one (where Chromium's bar starts, or a scroll); false when it was something else. */
export function receiveCanvasScrollbar(input: unknown): boolean {
  const scrollbar = parseCanvasScrollbarMessage(input);
  if (scrollbar !== undefined) {
    applyRange(scrollbar.chromiumFromPx);
    return true;
  }
  const scrollTo = parsePageScrollToMessage(input);
  if (scrollTo !== undefined) {
    window.scrollTo({ top: scrollTo.topPx, behavior: 'instant' });
    scheduleReport();
    return true;
  }
  return false;
}

/** The scroll the frame reports now, or undefined before the page has a root to scroll. */
export function pageScrollNow(): PageScroll | undefined {
  const root = document.scrollingElement ?? document.documentElement;
  if (root === null) {
    return undefined; // A frame still being created: its first report comes once the page exists.
  }
  const scroll = {
    topPx: clampPagePx(root.scrollTop),
    heightPx: clampPagePx(root.scrollHeight),
    viewHeightPx: clampPagePx(window.innerHeight),
    chromium: chromiumDrawsBar(),
  };
  assert(scroll.topPx >= 0, 'pageScrollNow: never above the page');
  assert(scroll.viewHeightPx >= 0, 'pageScrollNow: a view has a height');
  return scroll;
}

function applyRange(chromiumFromPx: number | undefined): void {
  const style = styleElement();
  if (style === undefined) {
    return;
  }
  const css = canvasScrollbarCss(chromiumFromPx);
  if (style.textContent !== css) {
    style.textContent = css;
  }
  if (range.kind === 'query') {
    range.query?.removeEventListener('change', scheduleReport);
  }
  const query = chromiumScrollbarQuery(chromiumFromPx);
  const list = query === undefined ? undefined : window.matchMedia(query);
  list?.addEventListener('change', scheduleReport);
  range = { kind: 'query', query: list };
  scheduleReport();
}

function chromiumDrawsBar(): boolean {
  switch (range.kind) {
    case 'unknown':
      return true;
    case 'query':
      return range.query?.matches ?? false;
    default: {
      const exhaustive: never = range;
      return exhaustive;
    }
  }
}

// The one <style> this module writes, last in <head> when made. A canvas patch keeps it: the patch only touches
// nodes the server rendered (morphPatch.ts), and a reload starts a new page that the app tells again.
function styleElement(): HTMLStyleElement | undefined {
  const existing = document.getElementById(STYLE_ID);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }
  const parent = document.head ?? document.documentElement;
  if (parent === null) {
    return undefined;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  parent.appendChild(style);
  return style;
}

function scheduleReport(): void {
  if (reportScheduled) {
    return;
  }
  reportScheduled = true;
  requestAnimationFrame(report);
}

// One report per animation frame at most, and none when nothing the canvas draws has changed.
function report(): void {
  reportScheduled = false;
  const send = post;
  if (send === undefined) {
    return;
  }
  const scroll = pageScrollNow();
  if (scroll === undefined) {
    return; // No page yet: `readystatechange` and `load` bring the first report.
  }
  if (lastReport !== undefined && sameScroll(lastReport, scroll)) {
    return;
  }
  lastReport = scroll;
  send(pageScrollMessage(scroll));
}

function sameScroll(previous: PageScroll, next: PageScroll): boolean {
  if (previous.topPx !== next.topPx) {
    return false;
  }
  if (previous.heightPx !== next.heightPx) {
    return false;
  }
  if (previous.viewHeightPx !== next.viewHeightPx) {
    return false;
  }
  return previous.chromium === next.chromium;
}

// A page past the bound is reported at the bound: the thumb is then as short as it goes, never wrong in kind.
function clampPagePx(value: number): number {
  if (Number.isFinite(value)) {
    return Math.min(CANVAS_SCROLLBAR_LIMITS.pagePxMax, Math.max(0, value));
  }
  return 0;
}
