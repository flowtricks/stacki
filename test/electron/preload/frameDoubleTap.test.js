// Goal: a double tap on a touch screen opens canvas text the way a double click does,
// because Safari on iPhone and iPad may send two clicks and no dblclick.
// Method: pin the pure rule (frameDoubleTap.ts) that frameText.ts applies to consecutive touch clicks: inside
// the time and distance bounds, at each bound, just past each, and out of order.
// Invalid taps are programmer errors and must crash with a message that names them.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { isTouchDoubleTap, DOUBLE_TAP_MS_MAX, DOUBLE_TAP_PX_MAX } = loadRenderer('electron/preload/frameDoubleTap.ts');

const first = { x: 100, y: 200, timeMs: 1000 };

test('a first tap never completes a double tap', () => {
  assert.equal(isTouchDoubleTap(undefined, first), false);
});

test('a second tap close in time and place completes one', () => {
  assert.equal(isTouchDoubleTap(first, { x: 104, y: 203, timeMs: 1200 }), true);
  assert.equal(isTouchDoubleTap(first, { x: 100, y: 200, timeMs: 1000 + DOUBLE_TAP_MS_MAX }), true);
  assert.equal(isTouchDoubleTap(first, { x: 100 + DOUBLE_TAP_PX_MAX, y: 200, timeMs: 1100 }), true);
});

test('a tap too late, too far or out of order does not', () => {
  assert.equal(isTouchDoubleTap(first, { x: 100, y: 200, timeMs: 1001 + DOUBLE_TAP_MS_MAX }), false);
  assert.equal(isTouchDoubleTap(first, { x: 100 + DOUBLE_TAP_PX_MAX + 1, y: 200, timeMs: 1100 }), false);
  assert.equal(isTouchDoubleTap(first, { x: 100, y: 200 + DOUBLE_TAP_PX_MAX + 1, timeMs: 1100 }), false);
  assert.equal(isTouchDoubleTap(first, { x: 100, y: 200, timeMs: 999 }), false);
});

test('a tap without a finite time or point is a programmer error', () => {
  assert.throws(() => isTouchDoubleTap(first, { x: 100, y: 200, timeMs: Number.NaN }), /A tap carries a finite time/);
  assert.throws(() => isTouchDoubleTap(first, { x: Number.POSITIVE_INFINITY, y: 200, timeMs: 1100 }), /A tap carries a finite x/);
  assert.throws(() => isTouchDoubleTap(first, { x: 100, y: Number.NaN, timeMs: 1100 }), /A tap carries a finite y/);
});
