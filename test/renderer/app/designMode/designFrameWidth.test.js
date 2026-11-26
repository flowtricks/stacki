// Goal: the arithmetic of a Design mode frame's width: a drag of either side keeps the other where it is, a width
// stays within the editor's canvas limits, and the shown frame and the editor's canvas stay one width: the canvas
// is asked for the frame's, the page is pictured once it has taken it, and a width the canvas is given by anything
// else (a media query picked in the style panel, Base) becomes the frame's. A frame never given a width is left
// alone, and nothing is asked or adopted while no frame is settled or the canvas is not measured.
//
// Method: the real modules, bundled by test/helpers/rendererModule.js, with the sync driven one step at a time as
// the hook drives it.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../../helpers/rendererModule');

const { clampFrameWidth, frameWidthPx, resizedFrame, syncFrameWidth, EMPTY_FRAME } = load('src/app/designMode/designFrameWidth.ts');
const { PREVIEW_WIDTH_LIMITS } = load('src/features/preview/previewViewport.ts');

test("a frame's limits are the editor's canvas limits", () => {
  assert.equal(clampFrameWidth(1), PREVIEW_WIDTH_LIMITS.minimum);
  assert.equal(clampFrameWidth(100_000), PREVIEW_WIDTH_LIMITS.maximum);
  assert.equal(clampFrameWidth(390.4), 390);
  assert.throws(() => clampFrameWidth(Number.NaN), /number/);
});

test('a frame is as wide as it was given, else as its picture, else an empty frame', () => {
  assert.equal(frameWidthPx({ widthPx: 390 }, { viewportWidthPx: 1200 }), 390);
  assert.equal(frameWidthPx({}, { viewportWidthPx: 1200 }), 1200);
  assert.equal(frameWidthPx({}, { viewportWidthPx: 0 }), EMPTY_FRAME.widthPx);
  assert.equal(frameWidthPx({}, undefined), EMPTY_FRAME.widthPx);
});

test('a dragged side moves and the other one stays', () => {
  const start = { widthPx: 1000, at: { x: 100, y: 20 } };
  assert.deepEqual(resizedFrame(start, 'e', -400), { widthPx: 600, at: { x: 100, y: 20 } });
  assert.deepEqual(resizedFrame(start, 'e', 250.6), { widthPx: 1251, at: { x: 100, y: 20 } });
  assert.deepEqual(resizedFrame(start, 'w', 400), { widthPx: 600, at: { x: 500, y: 20 } });
  assert.deepEqual(resizedFrame(start, 'w', -200), { widthPx: 1200, at: { x: -100, y: 20 } });
  // At a limit the other side still stays: the right edge was at 1100.
  assert.deepEqual(resizedFrame(start, 'w', 5000), { widthPx: 280, at: { x: 820, y: 20 } });
  assert.deepEqual(resizedFrame(start, 'e', -5000), { widthPx: 280, at: { x: 100, y: 20 } });
});

/** The sync, one step at a time; each call answers with what it asked for. */
function driver() {
  let held;
  return (id, widthPx, canvasPx) => {
    const { next, action } = syncFrameWidth(held, { shown: id === undefined ? undefined : { id, widthPx }, canvasPx });
    held = next;
    return action;
  };
}

const NONE = { kind: 'none' };
const PICTURE = { kind: 'picture' };
const ask = (widthPx) => ({ kind: 'request', widthPx });
const adopt = (widthPx) => ({ kind: 'adopt', widthPx });

test('a frame never given a width leaves the canvas alone, whatever the canvas does', () => {
  const step = driver();
  assert.deepEqual(step('f1', undefined, 1100), NONE);
  assert.deepEqual(step('f1', undefined, 390), NONE);
});

test("a resize asks the canvas for the frame's width once, then pictures the page that took it", () => {
  const step = driver();
  assert.deepEqual(step('f1', 390, 1100), ask(390));
  assert.deepEqual(step('f1', 390, 1100), NONE, 'asked once while the canvas has not moved');
  assert.deepEqual(step('f1', 390, 390), PICTURE);
  assert.deepEqual(step('f1', 390, 390), NONE);
  assert.deepEqual(step('f1', 768, 390), ask(768));
  assert.deepEqual(step('f1', 768, 768), PICTURE);
});

test('a width given to the canvas by something else becomes the shown frame’s', () => {
  const step = driver();
  step('f1', 390, 390);
  assert.deepEqual(step('f1', 390, 767), adopt(767));
  assert.deepEqual(step('f1', 767, 767), NONE, 'adopting already pictures it');
  // A canvas narrower than a frame may be is held at the limit, once.
  assert.deepEqual(step('f1', 767, 200), adopt(280));
  assert.deepEqual(step('f1', 280, 200), NONE, 'the two are left as they are rather than fought over');
});

test('a canvas still on its way is asked again rather than followed', () => {
  const step = driver();
  assert.deepEqual(step('f1', 390, 1440), ask(390));
  assert.deepEqual(step('f1', 390, 900), ask(390), 'a pane measured meanwhile is not the frame’s width');
  assert.deepEqual(step('f1', 390, 390), PICTURE);
});

test('showing another frame asks for its width, never taking the width of the one left', () => {
  const step = driver();
  step('f1', 390, 390);
  assert.deepEqual(step(undefined, undefined, 390), NONE, 'no frame is settled while the copy is rewritten');
  assert.deepEqual(step('f2', 1200, 390), ask(1200));
  assert.deepEqual(step('f2', 1200, 1200), PICTURE);
  assert.deepEqual(step('f2', 1200, undefined), NONE);
  assert.deepEqual(step('f2', 1200, 900), ask(1200), 'after the canvas was gone it is asked again');
});
