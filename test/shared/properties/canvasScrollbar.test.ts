// Goal: the canvas scrollbar contract (shared/properties/canvasScrollbar.ts) accepts exactly what the app, the frame
// and the settings file mean, and nothing that could escape it: a preference is `off` or a breakpoint id, a width is a
// whole canvas width inside the breakpoint bounds, a scroll report is finite and bounded, and the thumb stays on its
// track whatever the page's size.
// Method: each parser takes known-good input and every known-bad shape, including values just past each bound; the
// builders' output parses back; the stylesheet and query text are pinned; the thumb math is checked at the edges and
// read backwards; violated preconditions throw with their message pinned.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CANVAS_SCROLLBAR_DEFAULT, canvasScrollbarPreferenceText, parseCanvasScrollbarPreference } from '#dist/shared/properties/canvasScrollbarChoice.js';
import {
  CANVAS_SCROLLBAR_LIMITS,
  canvasScrollbarCss,
  canvasScrollbarMessage,
  chromiumScrollbarBreakpoints,
  chromiumScrollbarFromPx,
  chromiumScrollbarQuery,
  pageScrollMessage,
  pageScrollToMessage,
  parseCanvasScrollbarMessage,
  parsePageScrollMessage,
  parsePageScrollToMessage,
  scrollThumb,
  scrollTopForThumb,
} from '#dist/shared/properties/canvasScrollbar.js';
import { BREAKPOINT_DEFAULT_LIST, resolveBreakpoints } from '#dist/shared/properties/projectBreakpoints.js';

const SCROLL = { topPx: 0, heightPx: 4000, viewHeightPx: 800, chromium: false };
// A null as it reaches a boundary: out of a parsed message, never written in our own code.
const NULL_FROM_JSON: unknown = JSON.parse('null');

test('the preference is off or a breakpoint id, and its stored text reads back', () => {
  assert.deepEqual(parseCanvasScrollbarPreference('off'), { kind: 'off' });
  assert.deepEqual(parseCanvasScrollbarPreference('laptop'), { kind: 'from', breakpointId: 'laptop' });
  assert.deepEqual(parseCanvasScrollbarPreference('bp-12'), { kind: 'from', breakpointId: 'bp-12' });
  assert.deepEqual(CANVAS_SCROLLBAR_DEFAULT, { kind: 'off' });
  for (const stored of ['off', 'laptop', 'bp-12', 'a'.repeat(24)]) {
    assert.equal(canvasScrollbarPreferenceText(parseCanvasScrollbarPreference(stored)), stored);
  }
  for (const bad of [undefined, NULL_FROM_JSON, true, 3, {}, '', 'Laptop', '3bp', '-x', 'bp_1', 'laptop;', 'laptop ', 'a'.repeat(25)]) {
    assert.throws(() => parseCanvasScrollbarPreference(bad), /canvasScrollbar/, JSON.stringify(bad));
  }
});

test('a computer breakpoint and every wider frame keep Chromium from that breakpoint’s canvas width', () => {
  const breakpoints = resolveBreakpoints(BREAKPOINT_DEFAULT_LIST);
  assert.equal(chromiumScrollbarFromPx({ kind: 'off' }, breakpoints), undefined);
  assert.equal(chromiumScrollbarFromPx({ kind: 'from', breakpointId: 'laptop' }, breakpoints), 1023); // width < 64rem
  // A tablet or a phone floats its bar over the page: never offered, and a saved one acts as Off.
  assert.equal(chromiumScrollbarFromPx({ kind: 'from', breakpointId: 'tablet' }, breakpoints), undefined);
  assert.equal(chromiumScrollbarFromPx({ kind: 'from', breakpointId: 'phone' }, breakpoints), undefined);
  // A breakpoint this project does not have: the canvas's bar everywhere, as Off.
  assert.equal(chromiumScrollbarFromPx({ kind: 'from', breakpointId: 'bp-9' }, breakpoints), undefined);
  assert.equal(chromiumScrollbarFromPx({ kind: 'from', breakpointId: 'laptop' }, []), undefined);
});

test('Desktop and every wider frame keep Chromium from one pixel past the widest narrower breakpoint, whatever the list', () => {
  const desktop = parseCanvasScrollbarPreference('desktop');
  assert.deepEqual(desktop, { kind: 'from', breakpointId: 'desktop' });
  assert.equal(canvasScrollbarPreferenceText(desktop), 'desktop');
  // The default list: Laptop is `width < 64rem` (up to 1023), so Desktop starts at 1024, past Laptop's own 1023.
  assert.equal(chromiumScrollbarFromPx(desktop, resolveBreakpoints(BREAKPOINT_DEFAULT_LIST)), 1024);
  // A wider (`up`) breakpoint never moves where Desktop starts; the narrower ones do, whatever their number and names.
  const large = { id: 'bp-1', name: 'Large', direction: 'up' as const, setting: { value: 160, unit: 'rem' as const } };
  const small = { id: 'bp-2', name: 'Small laptop', direction: 'down' as const, setting: { value: 1200, unit: 'px' as const } };
  assert.equal(chromiumScrollbarFromPx(desktop, resolveBreakpoints([large, ...BREAKPOINT_DEFAULT_LIST])), 1024);
  assert.equal(chromiumScrollbarFromPx(desktop, resolveBreakpoints([large, small, ...BREAKPOINT_DEFAULT_LIST])), 1200);
  assert.equal(chromiumScrollbarFromPx({ kind: 'from', breakpointId: 'bp-1' }, resolveBreakpoints([large, ...BREAKPOINT_DEFAULT_LIST])), 2560);
  // The choices, widest first, whatever the list: every wider breakpoint and the computer-sized narrower ones, by
  // position and width, never by name; a narrower one in a tablet's or a phone's range is left out.
  const tabletSized = { id: 'bp-3', name: 'Big tablet', direction: 'down' as const, setting: { value: 860, unit: 'px' as const } };
  // In list order, strictly decreasing: 2560, 1200, 1024 (Laptop), 860, 768 (Tablet), 480 (Phone).
  const [laptop, tablet, phone] = BREAKPOINT_DEFAULT_LIST;
  assert.ok(laptop !== undefined && tablet !== undefined && phone !== undefined);
  const list = resolveBreakpoints([large, small, laptop, tabletSized, tablet, phone]);
  assert.deepEqual(
    chromiumScrollbarBreakpoints(list).map((breakpoint) => breakpoint.id),
    ['bp-1', 'bp-2', 'laptop'],
  );
  assert.equal(chromiumScrollbarFromPx({ kind: 'from', breakpointId: 'bp-2' }, list), 1199);
  assert.equal(chromiumScrollbarFromPx({ kind: 'from', breakpointId: 'bp-3' }, list), undefined);
  assert.deepEqual(chromiumScrollbarBreakpoints([]), []);
  // No narrower breakpoint: every frame below the wider ones is Desktop, so every frame keeps Chromium's bar.
  assert.equal(chromiumScrollbarFromPx(desktop, resolveBreakpoints([large])), 280);
  assert.equal(chromiumScrollbarFromPx(desktop, []), 280);
});

test('the app’s word to the frame carries a bounded canvas width or none', () => {
  assert.deepEqual(canvasScrollbarMessage(undefined), { type: 'avb:canvas-scrollbar' });
  assert.deepEqual(canvasScrollbarMessage(1023), { type: 'avb:canvas-scrollbar', chromiumFromPx: 1023 });
  for (const good of [280, 1023, 7681]) {
    assert.deepEqual(parseCanvasScrollbarMessage({ type: 'avb:canvas-scrollbar', chromiumFromPx: good }), {
      type: 'avb:canvas-scrollbar',
      chromiumFromPx: good,
    });
  }
  for (const bad of [
    undefined,
    'avb:canvas-scrollbar',
    { type: 'avb:other', chromiumFromPx: 1023 },
    { type: 'avb:canvas-scrollbar', chromiumFromPx: '1023' },
    { type: 'avb:canvas-scrollbar', chromiumFromPx: 1023.5 },
    { type: 'avb:canvas-scrollbar', chromiumFromPx: 279 },
    { type: 'avb:canvas-scrollbar', chromiumFromPx: 7682 },
    { type: 'avb:canvas-scrollbar', chromiumFromPx: Number.NaN },
    { type: 'avb:canvas-scrollbar', chromiumFromPx: NULL_FROM_JSON },
  ]) {
    assert.equal(parseCanvasScrollbarMessage(bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => canvasScrollbarMessage(12), /Assertion failed: canvasScrollbarMessage: the message parses/);
});

test('the frame’s stylesheet hides the root bar everywhere or below the width, and the query names the rest', () => {
  assert.equal(canvasScrollbarCss(undefined), 'html { scrollbar-width: none !important; }');
  assert.equal(canvasScrollbarCss(1023), '@media (width < 1023px) { html { scrollbar-width: none !important; } }');
  assert.equal(chromiumScrollbarQuery(undefined), undefined);
  assert.equal(chromiumScrollbarQuery(1023), '(width >= 1023px)');
  assert.throws(() => canvasScrollbarCss(12), /Assertion failed: canvasScrollbarCss: a canvas width within the breakpoint bounds/);
  assert.throws(() => chromiumScrollbarQuery(1023.5), /Assertion failed: chromiumScrollbarQuery: a canvas width within the breakpoint bounds/);
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
