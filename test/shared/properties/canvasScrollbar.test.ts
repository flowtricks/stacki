// Goal: the canvas scrollbar contract (shared/properties/canvasScrollbar.ts) accepts exactly what the app and the frame
// mean, and nothing that could escape it: the app's word to hide the page's bar carries nothing to choose (one
// behaviour, no setting), a scroll report is finite and bounded, and the thumb stays on its track whatever the page's
// size.
// Method: each parser takes known-good input and every known-bad shape, including values just past each bound; the
// builders' output parses back; the stylesheet text is pinned; the thumb math is checked at the edges and read
// backwards; violated preconditions throw with their message pinned.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANVAS_SCROLLBAR_CSS,
  CANVAS_SCROLLBAR_LIMITS,
  canvasScrollbarMessage,
  pageScrollMessage,
  pageScrollToMessage,
  parseCanvasScrollbarMessage,
  parsePageScrollMessage,
  parsePageScrollToMessage,
  scrollThumb,
  scrollTopForThumb,
} from '#dist/shared/properties/canvasScrollbar.js';
import * as canvasScrollbar from '#dist/shared/properties/canvasScrollbar.js';

const SCROLL = { topPx: 0, heightPx: 4000, viewHeightPx: 800, chromium: false };
// A null as it reaches a boundary: out of a parsed message, never written in our own code.
const NULL_FROM_JSON: unknown = JSON.parse('null');

test('the app’s word to the frame is one message with nothing to choose', () => {
  assert.deepEqual(canvasScrollbarMessage(), { type: 'avb:canvas-scrollbar' });
  assert.deepEqual(parseCanvasScrollbarMessage({ type: 'avb:canvas-scrollbar' }), { type: 'avb:canvas-scrollbar' });
  // An older app sent where Chromium's bar started: the width is ignored, and the bar is hidden all the same.
  assert.deepEqual(parseCanvasScrollbarMessage({ type: 'avb:canvas-scrollbar', chromiumFromPx: 1023 }), { type: 'avb:canvas-scrollbar' });
  for (const bad of [undefined, NULL_FROM_JSON, 'avb:canvas-scrollbar', 3, {}, { type: 'avb:other' }, { type: 'avb:page-scroll' }]) {
    assert.equal(parseCanvasScrollbarMessage(bad), undefined, JSON.stringify(bad));
  }
});

test('the frame’s stylesheet hides the bar of whichever root scrolls, and no width choice is left in the contract', () => {
  assert.equal(CANVAS_SCROLLBAR_CSS, 'html, body { scrollbar-width: none !important; }');
  // The breakpoint-based setting is gone for good: no export may bring a width threshold back.
  for (const removed of ['chromiumScrollbarFromPx', 'chromiumScrollbarBreakpoints', 'chromiumScrollbarQuery', 'canvasScrollbarCss']) {
    assert.equal(Reflect.has(canvasScrollbar, removed), false, removed);
  }
});

test('the frame’s scroll report is finite, never negative and bounded', () => {
  assert.deepEqual(pageScrollMessage(SCROLL), { type: 'avb:page-scroll', ...SCROLL });
  assert.deepEqual(parsePageScrollMessage({ type: 'avb:page-scroll', ...SCROLL, chromium: true }), { type: 'avb:page-scroll', ...SCROLL, chromium: true });
  const max = CANVAS_SCROLLBAR_LIMITS.pagePxMax;
  assert.equal(parsePageScrollMessage({ type: 'avb:page-scroll', ...SCROLL, heightPx: max })?.heightPx, max);
  for (const bad of [
    undefined,
    { ...SCROLL },
    { type: 'avb:page-scroll', ...SCROLL, topPx: -1 },
    { type: 'avb:page-scroll', ...SCROLL, heightPx: max + 1 },
    { type: 'avb:page-scroll', ...SCROLL, viewHeightPx: Number.POSITIVE_INFINITY },
    { type: 'avb:page-scroll', ...SCROLL, topPx: Number.NaN },
    { type: 'avb:page-scroll', ...SCROLL, topPx: '0' },
    { type: 'avb:page-scroll', ...SCROLL, chromium: 'no' },
    { type: 'avb:page-scroll', topPx: 0, heightPx: 10, chromium: false },
  ]) {
    assert.equal(parsePageScrollMessage(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(pageScrollToMessage(120), { type: 'avb:page-scroll-to', topPx: 120 });
  assert.deepEqual(parsePageScrollToMessage({ type: 'avb:page-scroll-to', topPx: 0 }), { type: 'avb:page-scroll-to', topPx: 0 });
  for (const bad of [
    { type: 'avb:page-scroll-to' },
    { type: 'avb:page-scroll-to', topPx: -5 },
    { type: 'avb:page-scroll-to', topPx: max + 1 },
    { type: 'avb:scroll-to', topPx: 5 },
  ]) {
    assert.equal(parsePageScrollToMessage(bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => pageScrollToMessage(-1), /Assertion failed: pageScrollToMessage: the message parses/);
});

test('the thumb is the visible share of its track, stays on it, and reads back to the page scroll', () => {
  // 800 of 4000 visible on an 800px track: a 160px thumb with 640px to travel over 3200px of page.
  assert.deepEqual(scrollThumb(SCROLL, 800, 24), { offsetPx: 0, lengthPx: 160 });
  assert.deepEqual(scrollThumb({ ...SCROLL, topPx: 1600 }, 800, 24), { offsetPx: 320, lengthPx: 160 });
  assert.deepEqual(scrollThumb({ ...SCROLL, topPx: 3200 }, 800, 24), { offsetPx: 640, lengthPx: 160 });
  // Scrolled past either end (an overscroll, a stale report): the thumb stays on its track.
  assert.deepEqual(scrollThumb({ ...SCROLL, topPx: 9000 }, 800, 24), { offsetPx: 640, lengthPx: 160 });
  // A page with nothing to scroll has no thumb.
  assert.equal(scrollThumb({ topPx: 0, heightPx: 800, viewHeightPx: 800 }, 800, 24), undefined);
  assert.equal(scrollThumb({ topPx: 0, heightPx: 600, viewHeightPx: 800 }, 800, 24), undefined);
  // A very long page keeps a thumb a pointer can catch, and its travel still spans the page.
  const long = { topPx: 0, heightPx: 1_000_000, viewHeightPx: 800 };
  assert.equal(scrollThumb(long, 800, 24)?.lengthPx, 24);
  assert.equal(scrollTopForThumb(long, 800, 24, 776), 999_200);
  // Read backwards, clamped to the page.
  assert.equal(scrollTopForThumb(SCROLL, 800, 24, 320), 1600);
  assert.equal(scrollTopForThumb(SCROLL, 800, 24, -50), 0);
  assert.equal(scrollTopForThumb(SCROLL, 800, 24, 5000), 3200);
  assert.equal(scrollTopForThumb({ heightPx: 800, viewHeightPx: 800 }, 800, 24, 100), 0);
  assert.throws(() => scrollThumb(SCROLL, -1, 24), /Assertion failed: scrollThumb: a track has a length/);
  assert.throws(() => scrollThumb(SCROLL, 800, -1), /Assertion failed: scrollThumb: a thumb has a length/);
});
