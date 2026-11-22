// Goal: every custom tooltip is always fully inside the window, whatever the control's position: centred on the
// control along the edge it faces when there is room, shifted off the left, right, top and bottom edges (keeping the
// margin), flipped to the opposite side when the preferred one lacks room, with its arrow still pointing at the
// control's centre. Right to left needs no case of its own because placement works in physical viewport
// coordinates; the rail passes `left` as the preferred side when mirrored and that case is pinned here.
// A second part renders the real rail with jsdom and a mocked layout and checks that the tip of a button at the foot
// of the window (the rail's bottom icons) is shifted up, never cut off, and that the arrow follows the button.
// Method: the pure `fitTooltip` is called with plain boxes (no DOM); the render test mounts FittedTooltip itself.
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/tooltip-fit');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'fit.cjs');
buildSync({
  stdin: {
    contents:
      "export { fitTooltip, TOOLTIP_EDGE_MARGIN_PX } from './src/ui/delayedTooltip'; export { default as FittedTooltip } from './src/ui/FittedTooltip';",
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client'],
});
const { fitTooltip, TOOLTIP_EDGE_MARGIN_PX } = require(bundle);

const viewport = { width: 600, height: 800 };
const tip = { width: 280, height: 90 };
const anchorAt = (left, top = 100, width = 24, height = 24) => ({ left, width, top, bottom: top + height });
const fit = (anchor, preferred, size = tip, window = viewport) => fitTooltip({ anchor, tip: size, viewport: window, preferred });
const inside = (result, size = tip, window = viewport) => {
  assert.ok(result.left >= TOOLTIP_EDGE_MARGIN_PX, 'clears the left edge');
  assert.ok(result.top >= TOOLTIP_EDGE_MARGIN_PX, 'clears the top edge');
  assert.ok(result.left + size.width <= window.width - TOOLTIP_EDGE_MARGIN_PX, 'clears the right edge');
  assert.ok(result.top + size.height <= window.height - TOOLTIP_EDGE_MARGIN_PX, 'clears the bottom edge');
};

test('below: centred under the control when there is room on both sides', () => {
  const result = fit(anchorAt(288), 'below');
  assert.equal(result.side, 'below');
  assert.equal(result.left, 300 - 140);
  assert.equal(result.top, 100 + 24 + 8);
  assert.equal(result.arrowOffset, 140);
});

test('below: wider than the space on the left, shifted right to the margin, arrow still at the control', () => {
  const result = fit(anchorAt(113), 'below');
  assert.equal(result.left, TOOLTIP_EDGE_MARGIN_PX);
  assert.equal(result.arrowOffset, 113 + 12 - TOOLTIP_EDGE_MARGIN_PX);
  inside(result);
});

test('below: wider than the space on the right, shifted left to the margin', () => {
  const result = fit(anchorAt(560), 'below');
  assert.equal(result.left + tip.width, viewport.width - TOOLTIP_EDGE_MARGIN_PX);
  assert.equal(result.arrowOffset, 560 + 12 - result.left);
  inside(result);
});

test('below: near the bottom edge flips above, ending above the control', () => {
  const result = fit(anchorAt(288, 740), 'below');
  assert.equal(result.side, 'above');
  assert.equal(result.top + tip.height + 8, 740);
  inside(result);
});

test('above: near the top edge flips below', () => {
  const result = fit(anchorAt(288, 20), 'above');
  assert.equal(result.side, 'below');
  inside(result);
});

test('a tall tip with no room above or below stays on the preferred side rather than flipping into less room', () => {
  const tall = { width: 280, height: 900 };
  assert.equal(fit(anchorAt(288, 20), 'below', tall).side, 'below');
  assert.equal(fit(anchorAt(288, 700), 'above', tall).side, 'above');
});

test('right: beside the control, level with its centre, arrow at the centre', () => {
  const result = fit(anchorAt(20, 400, 40, 40), 'right');
  assert.equal(result.side, 'right');
  assert.equal(result.left, 20 + 40 + 10);
  assert.equal(result.top, 420 - 45);
  assert.equal(result.arrowOffset, 45);
});

test('right: a button at the foot of the window is shifted up to the bottom margin and the arrow follows the button', () => {
  const result = fit(anchorAt(20, 770, 40, 24), 'right');
  assert.equal(result.side, 'right');
  assert.equal(result.top + tip.height, viewport.height - TOOLTIP_EDGE_MARGIN_PX);
  // The arrow stays 14px inside the tip's rounded corners, so it stops at the tip's foot instead of following the centre further.
  assert.equal(result.arrowOffset, tip.height - 14);
  inside(result);
});

test('right: a button at the top of the window is shifted down to the top margin', () => {
  const result = fit(anchorAt(20, 0, 40, 24), 'right');
  assert.equal(result.top, TOOLTIP_EDGE_MARGIN_PX);
  assert.equal(result.arrowOffset, 14, 'the arrow keeps clear of the tip corner');
});

test('right: no room on the right flips to the left; left (mirrored rail) with no room on the left flips to the right', () => {
  const nearRight = fit(anchorAt(540, 300, 40, 40), 'right');
  assert.equal(nearRight.side, 'left');
  assert.equal(nearRight.left + tip.width + 10, 540);
  const mirrored = fit(anchorAt(10, 300, 40, 40), 'left');
  assert.equal(mirrored.side, 'right');
  assert.equal(mirrored.left, 60);
});

test('a tip wider or taller than the window keeps its start edge at the margin', () => {
  const small = { width: 300, height: 200 };
  const wide = fit(anchorAt(100), 'below', { width: 400, height: 50 }, small);
  assert.equal(wide.left, TOOLTIP_EDGE_MARGIN_PX);
  const tall = fit(anchorAt(20, 100, 40, 24), 'right', { width: 100, height: 300 }, small);
  assert.equal(tall.top, TOOLTIP_EDGE_MARGIN_PX);
});

test('invalid input crashes loudly', () => {
  assert.throws(() => fit(anchorAt(0), 'below', { width: -1, height: 1 }), /tip width/);
  assert.throws(() => fit(anchorAt(0), 'below', { width: 1, height: -1 }), /tip height/);
  assert.throws(() => fit(anchorAt(0), 'below', tip, { width: 0, height: 10 }), /viewport has a width/);
  assert.throws(() => fit(anchorAt(0), 'below', tip, { width: 10, height: 0 }), /viewport has a height/);
});

// The rendered part: the component measures its own box and writes the fitted place before paint.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { FittedTooltip } = require(bundle);

let mounted;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

test('rendered rail tip: a bottom icon of a 800px-high window gets a tip that stays inside, arrow at the icon', async () => {
  dom.window.innerWidth = 1000;
  dom.window.innerHeight = 800;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    // The test window has no layout (jsdom): the tip is 120 wide and 32 high, wherever it sits.
    return { left: 0, top: 0, right: 120, bottom: 32, width: 120, height: 32 };
  };
  const container = document.getElementById('root');
  mounted = createRoot(container);
  await act(async () => {
    mounted.render(React.createElement(FittedTooltip, { anchor: { left: 12, width: 40, top: 780, bottom: 804 }, preferred: 'right' }, 'Settings'));
  });
  const element = container.querySelector('.rail-tooltip');
  assert.ok(element, 'the tip is drawn');
  assert.equal(element.dataset.side, 'right');
  assert.equal(element.style.left, '62px', 'ten pixels right of the icon');
  assert.equal(element.style.top, '760px', 'shifted up so its bottom keeps the margin (800 - 8 - 32)');
  assert.equal(
    element.style.getPropertyValue('--tip-arrow'),
    '18px',
    'the arrow follows the icon centre (792 - 760 = 32) but stops 14px inside the tip foot (32 - 14)',
  );
});
