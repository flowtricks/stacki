// Goal: the editor collapses its side panels by the width left for the canvas, not by the
// window width, and a window held near the threshold never flips the layout back and forth.
// Methodology: bundle the shared rule (src/app/shell/editorLayout.ts, which Studio vendors),
// then drive it with the screenshot that prompted it (an 825px window with a 260px Navigator
// and a 320px Style panel), with each side of both thresholds, with the user's resized panel
// widths, with a window dragged back and forth across the threshold, and with invalid widths.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test/editor-layout');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'editorLayout.cjs');
buildSync({
  entryPoints: [path.join(ROOT, 'src/app/shell/editorLayout.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { CANVAS_WIDTH_PX_HYSTERESIS, CANVAS_WIDTH_PX_MIN, editorLayoutFor } = require(output);

const RAIL = 44;
const NAVIGATOR = 260;
const INSPECTOR = 322;
const DOCKED = RAIL + NAVIGATOR + INSPECTOR;

test('the threshold is a canvas width between a landscape phone and a small tablet', () => {
  assert.equal(CANVAS_WIDTH_PX_MIN, 600);
  assert.equal(CANVAS_WIDTH_PX_HYSTERESIS, 48);
});

test('the reported 825px window collapses instead of squeezing the canvas to 375px', () => {
  assert.equal(editorLayoutFor({ previous: 'docked', viewportWidthPx: 825, dockedWidthPx: RAIL + 260 + 320 }), 'collapsed');
  for (const width of [390, 700, 900, 1100]) {
    assert.equal(editorLayoutFor({ previous: 'docked', viewportWidthPx: width, dockedWidthPx: DOCKED }), 'collapsed', `${width}px`);
  }
  assert.equal(editorLayoutFor({ previous: 'docked', viewportWidthPx: 1440, dockedWidthPx: DOCKED }), 'docked');
});

test('a docked editor collapses exactly when the canvas drops below the minimum', () => {
  const edge = DOCKED + CANVAS_WIDTH_PX_MIN;
  assert.equal(editorLayoutFor({ previous: 'docked', viewportWidthPx: edge, dockedWidthPx: DOCKED }), 'docked');
  assert.equal(editorLayoutFor({ previous: 'docked', viewportWidthPx: edge - 1, dockedWidthPx: DOCKED }), 'collapsed');
});

test('a collapsed editor docks again only past the hysteresis gap', () => {
  const edge = DOCKED + CANVAS_WIDTH_PX_MIN + CANVAS_WIDTH_PX_HYSTERESIS;
  assert.equal(editorLayoutFor({ previous: 'collapsed', viewportWidthPx: DOCKED + CANVAS_WIDTH_PX_MIN, dockedWidthPx: DOCKED }), 'collapsed');
  assert.equal(editorLayoutFor({ previous: 'collapsed', viewportWidthPx: edge - 1, dockedWidthPx: DOCKED }), 'collapsed');
  assert.equal(editorLayoutFor({ previous: 'collapsed', viewportWidthPx: edge, dockedWidthPx: DOCKED }), 'docked');
});

test('the user resized panel widths move the threshold with them', () => {
  // At 1440px the default panels leave an 814px canvas; two 600px panels leave 196px.
  assert.equal(editorLayoutFor({ previous: 'docked', viewportWidthPx: 1440, dockedWidthPx: RAIL + 600 + 600 }), 'collapsed');
  // Closing the Navigator gives its width back to the canvas: 1100 - 44 - 322 = 734px.
  assert.equal(editorLayoutFor({ previous: 'collapsed', viewportWidthPx: 1100, dockedWidthPx: RAIL + INSPECTOR }), 'docked');
  assert.equal(editorLayoutFor({ previous: 'docked', viewportWidthPx: 1100, dockedWidthPx: DOCKED }), 'collapsed');
});

test('a window dragged back and forth near the threshold switches once each way', () => {
  const edge = DOCKED + CANVAS_WIDTH_PX_MIN;
  let layout = 'docked';
  const changes = [];
  const widths = [];
  for (let step = 0; step < 40; step++) {
    // A wobble of ±20px around the collapse edge, as a hand holding a window edge makes.
    widths.push(edge + (step % 2 === 0 ? -20 : 20));
  }
  widths.push(edge + CANVAS_WIDTH_PX_HYSTERESIS + 10);
  for (const width of widths) {
    const next = editorLayoutFor({ previous: layout, viewportWidthPx: width, dockedWidthPx: DOCKED });
    if (next !== layout) {
      changes.push(next);
    }
    layout = next;
  }
  assert.deepEqual(changes, ['collapsed', 'docked']);
});

test('invalid widths are programmer errors and fail loudly', () => {
  assert.throws(() => editorLayoutFor({ previous: 'docked', viewportWidthPx: Number.NaN, dockedWidthPx: DOCKED }), /Viewport width must be finite/);
  assert.throws(() => editorLayoutFor({ previous: 'docked', viewportWidthPx: -1, dockedWidthPx: DOCKED }), /Viewport width must not be negative/);
  assert.throws(() => editorLayoutFor({ previous: 'docked', viewportWidthPx: 1440, dockedWidthPx: Infinity }), /Docked panel width must be finite/);
  assert.throws(() => editorLayoutFor({ previous: 'docked', viewportWidthPx: 1e9, dockedWidthPx: DOCKED }), /Viewport width exceeds the layout limit/);
  assert.throws(() => editorLayoutFor({ previous: 'sideways', viewportWidthPx: 1440, dockedWidthPx: DOCKED }), /unknown editor layout sideways/);
});
