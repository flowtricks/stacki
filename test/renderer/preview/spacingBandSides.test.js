// Goal: hovering any side of the Spacing box draws exactly that side's band on the canvas, from the page
// as laid out, so the band matches what the person sees. The owner's report: pointing at `margin-top`
// drew a hatched band below the heading (its margin-bottom) and nothing above it.
//
// Method: three layers, each on the real module. (1) spacingBands: for every side of margin and padding,
// the single-side hover gives one rectangle in the right place; negative margins, an empty side and the
// two collapse cases (a margin that adds nothing, a margin that is the larger of the two) are the
// negative space. (2) clipBand: a band hanging out of the frame is cut so its label stays on the part
// that can be seen. (3) The real overlays rendered to markup with a hover per side: the right element,
// class and label per side, a marker with its reason for a collapsed margin, and the exact structure
// from the report (a heading with a 20px top margin from a variable, under a sibling). Physical sides
// only: `margin-top` is the top edge in every writing mode and direction, so rtl and vertical text need
// no case of their own; a left or right band is the same arithmetic as the top one on the other axis.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/spacing-band-sides.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export { PreviewOverlays } from './src/features/preview/PreviewOverlays';\nexport { spacingBands, clipBand, marginContribution, COLLAPSE_MARKER_PX } from './src/features/preview/spacingBands';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { PreviewOverlays, spacingBands, clipBand, marginContribution, COLLAPSE_MARKER_PX } = require(output);

const BOX = { x: 100, y: 200, w: 300, h: 40 };
const SIDES = { top: 10, right: 20, bottom: 30, left: 40 };
const spacing = { margin: SIDES, padding: SIDES };

test('each side of margin is its own strip outside the box', () => {
  const want = {
    // A margin frame is the box plus its margins; each strip runs the frame's full length on its axis.
    top: { x: 60, y: 190, w: 360, h: 10 },
    bottom: { x: 60, y: 240, w: 360, h: 30 },
    left: { x: 60, y: 190, w: 40, h: 80 },
    right: { x: 400, y: 190, w: 20, h: 80 },
  };
  for (const side of Object.keys(want)) {
    const bands = spacingBands(BOX, spacing, 'margin', [side]);
    assert.equal(bands.length, 1, `${side}: one band`);
    assert.equal(bands[0].side, side);
    assert.deepEqual({ x: bands[0].x, y: bands[0].y, w: bands[0].w, h: bands[0].h }, want[side], side);
  }
});

test('each side of padding is its own strip inside the box', () => {
  const want = {
    top: { x: 100, y: 200, w: 300, h: 10 },
    bottom: { x: 100, y: 210, w: 300, h: 30 },
    left: { x: 100, y: 200, w: 40, h: 40 },
    right: { x: 380, y: 200, w: 20, h: 40 },
  };
  for (const side of Object.keys(want)) {
    const bands = spacingBands(BOX, spacing, 'padding', [side]);
    assert.equal(bands.length, 1, `${side}: one band`);
    assert.deepEqual({ x: bands[0].x, y: bands[0].y, w: bands[0].w, h: bands[0].h }, want[side], side);
  }
});

test('hovering the top never draws the bottom, and the reverse', () => {
  for (const kind of ['margin', 'padding']) {
    assert.deepEqual(
      spacingBands(BOX, spacing, kind, ['top']).map((band) => band.side),
      ['top'],
    );
    assert.deepEqual(
      spacingBands(BOX, spacing, kind, ['bottom']).map((band) => band.side),
      ['bottom'],
    );
  }
});

test('a negative margin, a zero side and no sides draw nothing', () => {
  assert.deepEqual(spacingBands(BOX, { margin: { top: -12, bottom: 0 } }, 'margin', ['top', 'bottom']), []);
  assert.deepEqual(spacingBands(BOX, spacing, 'margin', []), []);
  assert.deepEqual(spacingBands(undefined, spacing, 'margin', ['top']), []);
});

test('a margin contributes only what its adjoining margin does not already hold', () => {
  assert.equal(marginContribution(20, undefined), 20);
  assert.equal(marginContribution(20, 8), 12);
  assert.equal(marginContribution(20, 20), 0);
  assert.equal(marginContribution(20, 40), 0);
  assert.equal(marginContribution(20, 0), 20);
  assert.equal(marginContribution(20, -10), 20, 'a negative partner pulls the pair together but this margin still holds its own');
  assert.equal(marginContribution(-20, 40), -20);
});

test('a collapsed top margin is a thin marker at the box edge, naming what it collapses with', () => {
  const collapsed = { margin: { top: 20 }, collapse: { top: { partner: 'previous', margin: 40 } } };
  const [band] = spacingBands(BOX, collapsed, 'margin', ['top']);
  assert.equal(band.collapsedInto, 'previous');
  assert.deepEqual({ x: band.x, y: band.y, w: band.w, h: band.h }, { x: 100, y: 200 - COLLAPSE_MARKER_PX, w: 300, h: COLLAPSE_MARKER_PX });
  const below = spacingBands(BOX, { margin: { bottom: 20 }, collapse: { bottom: { partner: 'next', margin: 20 } } }, 'margin', ['bottom']);
  assert.equal(below[0].collapsedInto, 'next');
  assert.equal(below[0].y, 240, 'the bottom marker starts at the bottom edge');
});

test('the larger of two collapsing margins keeps its whole strip', () => {
  const larger = { margin: { top: 20 }, collapse: { top: { partner: 'previous', margin: 8 } } };
  const [band] = spacingBands(BOX, larger, 'margin', ['top']);
  assert.equal(band.collapsedInto, undefined);
  assert.equal(band.h, 20);
});

test('padding never collapses, whatever the measurement says', () => {
  const [band] = spacingBands(BOX, { padding: { top: 20 }, collapse: { top: { partner: 'previous', margin: 40 } } }, 'padding', ['top']);
  assert.equal(band.collapsedInto, undefined);
  assert.equal(band.h, 20);
});

test('a flex or grid item, which the frame reports no collapse for, draws the whole strip', () => {
  const [band] = spacingBands(BOX, { margin: { top: 20 } }, 'margin', ['top']);
  assert.equal(band.h, 20);
  assert.equal(band.collapsedInto, undefined);
});

test('a band is cut to the frame and one wholly outside it is dropped', () => {
  const frame = { w: 800, h: 600 };
  const above = { side: 'top', x: 0, y: -15, w: 300, h: 20 };
  assert.deepEqual(clipBand(above, frame), { side: 'top', x: 0, y: 0, w: 300, h: 5 });
  assert.equal(clipBand({ ...above, y: -40 }, frame), undefined);
  assert.equal(clipBand({ side: 'bottom', x: 0, y: 600, w: 10, h: 10 }, frame), undefined);
  assert.deepEqual(clipBand(above, undefined), above, 'a frame of unknown size cuts nothing');
});

// --- the overlays ---------------------------------------------------------------------------------

const INFO = {
  label: 'Heading',
  kind: 'component',
  tag: undefined,
  astroAsset: false,
  dynamicTag: false,
  nodeKind: 'component',
  isLayout: false,
  bound: false,
};

function render({ box, measured, hover, viewport }) {
  return renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: { 0.2: [box] },
      spacing: { 0.2: [measured] },
      scale: 1,
      selPath: '0.2',
      selOcc: 0,
      hoverPath: undefined,
      hoverOcc: undefined,
      focusPath: undefined,
      focusWhole: false,
      overlayInfo: () => INFO,
      spacingHover: hover,
      viewport,
    }),
  );
}
const bandsIn = (markup) =>
  [...markup.matchAll(/<div class="spacing-band ([^"]*)" style="([^"]*)"><span class="spacing-band-label">([^<]*)<\/span><\/div>/g)].map((found) => ({
    classes: found[1],
    style: found[2],
    label: found[3],
  }));

test('hovering each side draws that side only, with its own label', () => {
  const labels = { top: 'var(--top)', right: 'var(--right)', bottom: 'var(--bottom)', left: 'var(--left)' };
  for (const kind of ['margin', 'padding']) {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const bands = bandsIn(render({ box: BOX, measured: spacing, hover: { kind, sides: [side], labels } }));
      assert.equal(bands.length, 1, `${kind} ${side}`);
      assert.equal(bands[0].label, labels[side], `${kind} ${side} label`);
      assert.ok(bands[0].classes.includes(`is-${kind}`));
    }
  }
});

// The report: a Heading with a margin-top of 20px (from a variable) and a margin-bottom, under another element.
const HEADING = { x: 40, y: 120, w: 520, h: 48 };
const heading = (collapse) => ({
  margin: { top: 20, right: 0, bottom: 16, left: 0 },
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  ...(collapse ? { collapse } : {}),
});
const labels = { top: 'var(--_layout---spacing--margin-md)', bottom: 'var(--_layout---spacing--margin-xs)' };

test('the reported heading: pointing at margin-top draws the band above it, not the one below', () => {
  const bands = bandsIn(render({ box: HEADING, measured: heading(), hover: { kind: 'margin', sides: ['top'], labels } }));
  assert.equal(bands.length, 1);
  assert.equal(bands[0].label, labels.top);
  assert.match(bands[0].style, /top:100px/);
  assert.match(bands[0].style, /height:20px/);
});

test('the reported heading under a sibling whose margin is larger: a marker names the collapse', () => {
  const measured = heading({ top: { partner: 'previous', margin: 24 } });
  const bands = bandsIn(render({ box: HEADING, measured, hover: { kind: 'margin', sides: ['top'], labels } }));
  assert.equal(bands.length, 1, 'something is drawn: not nothing');
  assert.ok(bands[0].classes.includes('is-collapsed'));
  assert.equal(bands[0].label, 'Margin collapses with the previous element');
  assert.match(bands[0].style, /height:2px/);
});

test('a first child whose margin passes through its parent says so', () => {
  const measured = heading({ top: { partner: 'parent', margin: 40 } });
  const bands = bandsIn(render({ box: HEADING, measured, hover: { kind: 'margin', sides: ['top'], labels } }));
  assert.equal(bands[0].label, 'Margin collapses with the parent&#x27;s margin', 'as markup escapes the apostrophe');
});

test('a band hanging above the top of the frame is cut to it and its label stays on the visible part', () => {
  const box = { x: 40, y: 8, w: 520, h: 48 };
  const bands = bandsIn(render({ box, measured: heading(), hover: { kind: 'margin', sides: ['top'], labels }, viewport: { w: 800, h: 600 } }));
  assert.equal(bands.length, 1, 'still drawn although part of it is above the page');
  assert.match(bands[0].style, /top:0;/);
  assert.match(bands[0].style, /height:8px/);
  const gone = bandsIn(
    render({ box: { ...box, y: -30 }, measured: heading(), hover: { kind: 'margin', sides: ['top'], labels }, viewport: { w: 800, h: 600 } }),
  );
  assert.equal(gone.length, 0, 'wholly above the frame: nothing to show');
});

test('both sides under Alt: each keeps its own label', () => {
  const bands = bandsIn(render({ box: HEADING, measured: heading(), hover: { kind: 'margin', sides: ['top', 'bottom'], labels } }));
  assert.deepEqual(bands.map((band) => band.label).sort(), [labels.bottom, labels.top].sort());
});
