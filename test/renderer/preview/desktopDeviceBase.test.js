// Goal: the Desktop device draws the project's Desktop width. In a pane with room for it, the page fills the pane (less the
// scrollbar's two 9px gutters) at scale 1. In a narrower pane it is exactly what typing that width into the width box gives:
// the same frame width, scale and height, so the page keeps its desktop layout, the toolbar presses Desktop and following lands
// where that width does (Base in a desktop-first component). A pane that reaches a wider (`up`) breakpoint draws the Desktop
// width too, never the wider layout under the Desktop button.
// Method: a table over two fixtures (desktop-first `< X` rows, mobile-first `>= X` rows). Each case runs the real
// chain the app runs: the frame width (previewFrameWidth), the viewport and its scale (previewViewport), the
// device the toolbar presses (activeDeviceFor, fed the width the canvas draws at), the row following picks at
// the viewport width (followedContextKey) and the trigger icon (canvasTriggerIcon), and pins each by value.
// Desktop is run at panes 700 to 1600; the narrower devices stay framed at their own widths. Then every pane from 300 to 2000,
// the boundaries (1023/1024/1025, 767/768, 479/480 at a 16px rem), the pane where filling starts, another Desktop width,
// a held (pinned) panel, and the negative space: an unmeasured pane, an `up` breakpoint, a stale custom width, and
// the all-breakpoints canvas that keeps its own name at any width.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { previewFrameWidth } = loadRenderer('src/features/preview/usePreviewSizing.ts');
const { FLUID_GUTTER_PX, fluidFrameWidthPx, previewViewport } = loadRenderer('src/features/preview/previewViewport.ts');
const { activeDeviceFor, deviceForWidth } = loadRenderer('shared/properties/breakpointIcon.ts');
const { canvasTriggerIcon } = loadRenderer('src/features/style/embed/contextRows.ts');
const { followedContextKey } = loadRenderer('src/features/style/model/followWidth.ts');
const { followBreakpoint } = loadRenderer('src/features/style/embed/followBreakpoint.ts');
const { followRetargetKey } = loadRenderer('src/features/style/embed/contextFollow.ts');
const { BREAKPOINT_DEFAULTS, resolveBreakpoints } = loadRenderer('shared/properties/projectBreakpoints.ts');

const ROOT_FONT_SIZE_PX = 16;
const PANE_HEIGHT_PX = 800;
const BASE = { key: '', embedAtContext: '' };
const row = (query) => ({ key: query, embedAtContext: query });
const LAPTOP_DOWN = '@media (width < 64rem)';

const FIXTURES = {
  desktopFirst: [BASE, row(LAPTOP_DOWN), row('@media (width < 48rem)'), row('@media (width < 30rem)')],
  mobileFirst: [BASE, row('@media (width >= 30rem)'), row('@media (width >= 48rem)'), row('@media (width >= 64rem)')],
};

// Per fixture and fixed device: the row following picks ('' is Base) and the trigger icon (undefined keeps the row's own).
const FIXED_EXPECTED = {
  desktopFirst: {
    laptop: { key: LAPTOP_DOWN, icon: 'laptop' },
    tablet: { key: '@media (width < 48rem)', icon: 'tablet' },
    phone: { key: '@media (width < 30rem)', icon: 'phone' },
  },
  mobileFirst: {
    laptop: { key: '@media (width >= 48rem)', icon: 'laptop' },
    tablet: { key: '@media (width >= 30rem)', icon: 'tablet' },
    phone: { key: '', icon: undefined },
  },
};
const DEVICE_WIDTH_PX = { laptop: 1023, tablet: 767, phone: 479 };
const PANE_WIDTHS_PX = [700, 882, 1100, 1600];
const DESKTOP_WIDTH_PX = 1440;

// What the Desktop device shows at any pane width: per fixture the row following picks and the icon.
const DESKTOP_EXPECTED = {
  desktopFirst: { key: '', icon: undefined },
  mobileFirst: { key: '@media (width >= 64rem)', icon: 'desktop' },
};
const room = (paneWidthPx, desktopFramePx = DESKTOP_WIDTH_PX) => ({ desktopFramePx, paneWidthPx });

// The chain the canvas, the toolbar and the style panel run for one device in one pane.
function canvasAt(device, panePx, contexts) {
  const width = previewFrameWidth(device, undefined, BREAKPOINT_DEFAULTS, room(panePx));
  const viewport = previewViewport(width, { width: panePx, height: PANE_HEIGHT_PX }, undefined);
  const key = followedContextKey(contexts, viewport.width, ROOT_FONT_SIZE_PX);
  const icon = canvasTriggerIcon(key, { device, widthPx: viewport.width }, BREAKPOINT_DEFAULTS);
  // The canvas hook passes the frame's own width, or the pane's less its gutters for a fluid frame (usePreviewSizing).
  return { width, viewport, key, icon, active: activeDeviceFor(device, width ?? fluidFrameWidthPx(panePx), BREAKPOINT_DEFAULTS) };
}

for (const [fixture, contexts] of Object.entries(FIXTURES)) {
  for (const panePx of PANE_WIDTHS_PX) {
    test(`${fixture}: desktop in a ${panePx}px pane draws the Desktop width`, () => {
      const canvas = canvasAt('desktop', panePx, contexts);
      const pane = { width: panePx, height: PANE_HEIGHT_PX };
      const fills = panePx - FLUID_GUTTER_PX.side >= DESKTOP_WIDTH_PX;
      if (fills) {
        assert.equal(canvas.width, undefined, 'a pane with room is filled');
        assert.equal(canvas.viewport.width, panePx - FLUID_GUTTER_PX.side, 'the page is as wide as the pane less the scrollbar’s gutters');
        assert.equal(canvas.viewport.scale, 1);
      } else {
        const typed = previewViewport(previewFrameWidth('custom', DESKTOP_WIDTH_PX, BREAKPOINT_DEFAULTS, room(panePx)), pane, undefined);
        assert.deepEqual(canvas.viewport, typed, 'the same frame as typing the Desktop width');
        assert.equal(canvas.viewport.width, DESKTOP_WIDTH_PX);
        assert.equal(canvas.viewport.scale, (panePx - 24) / DESKTOP_WIDTH_PX, 'scaled to fit');
      }
      assert.equal(canvas.active, 'desktop', 'the toolbar presses Desktop');
      assert.equal(canvas.key, DESKTOP_EXPECTED[fixture].key, 'following picks the query in effect at the drawn width');
      assert.equal(canvas.icon, DESKTOP_EXPECTED[fixture].icon, 'the trigger icon');
    });
    for (const device of ['laptop', 'tablet', 'phone']) {
      test(`${fixture}: ${device} in a ${panePx}px pane stays framed`, () => {
        const canvas = canvasAt(device, panePx, contexts);
        const expected = FIXED_EXPECTED[fixture][device];
        assert.equal(canvas.viewport.width, DEVICE_WIDTH_PX[device]);
        assert.equal(canvas.viewport.scale, Math.min(1, (panePx - 24) / DEVICE_WIDTH_PX[device]), 'a fixed frame scales to fit the pane less its gutter');
        assert.ok(canvas.viewport.scale <= 1, 'the canvas never scales a page up');
        assert.equal(canvas.active, device, 'the toolbar presses the device picked');
        assert.equal(canvas.key, expected.key, 'following picks the query in effect at the canvas width');
        assert.equal(canvas.icon, expected.icon, 'the trigger icon');
      });
    }
  }
}

test('Desktop draws a desktop width at every pane width, and fills only where it has room', () => {
  // Bounded: 300 to 2000 in steps of 10 is 171 panes.
  for (let panePx = 300; panePx <= 2000; panePx += 10) {
    for (const contexts of Object.values(FIXTURES)) {
      const canvas = canvasAt('desktop', panePx, contexts);
      assert.equal(canvas.viewport.width, Math.max(DESKTOP_WIDTH_PX, panePx - FLUID_GUTTER_PX.side), `${panePx}px`);
      assert.equal(canvas.active, 'desktop', `${panePx}px: the toolbar presses Desktop`);
      assert.ok(canvas.viewport.scale <= 1, `${panePx}px: never scaled up`);
    }
  }
});

test('filling starts at the pane that holds the Desktop width and its gutters', () => {
  const edgePx = DESKTOP_WIDTH_PX + FLUID_GUTTER_PX.side;
  assert.equal(previewFrameWidth('desktop', undefined, BREAKPOINT_DEFAULTS, room(edgePx - 1)), DESKTOP_WIDTH_PX);
  assert.equal(previewFrameWidth('desktop', undefined, BREAKPOINT_DEFAULTS, room(edgePx)), undefined);
});

test('the project’s own Desktop width is the one drawn', () => {
  assert.equal(previewFrameWidth('desktop', undefined, BREAKPOINT_DEFAULTS, room(850, 1280)), 1280);
  assert.equal(previewFrameWidth('desktop', undefined, BREAKPOINT_DEFAULTS, room(1298, 1280)), undefined);
  assert.throws(() => previewFrameWidth('desktop', undefined, BREAKPOINT_DEFAULTS, room(850, 0)), {
    message: 'Assertion failed: The Desktop width is positive',
  });
});

test('desktop-first: following lands on the breakpoint a narrow Desktop pane is inside', () => {
  assert.equal(followBreakpoint(FIXTURES.desktopFirst, 882, BREAKPOINT_DEFAULTS)?.breakpointId, 'laptop');
  assert.equal(followBreakpoint(FIXTURES.desktopFirst, 700, BREAKPOINT_DEFAULTS)?.breakpointId, 'tablet');
  assert.equal(followBreakpoint(FIXTURES.desktopFirst, 1440, BREAKPOINT_DEFAULTS), undefined, 'a wide pane is Base');
});

// [width, desktop-first row, mobile-first row, the device the width belongs to].
const BOUNDARIES = [
  [1025, '', '@media (width >= 64rem)', 'desktop'],
  [1024, '', '@media (width >= 64rem)', 'desktop'],
  [1023, LAPTOP_DOWN, '@media (width >= 48rem)', 'laptop'],
  [768, LAPTOP_DOWN, '@media (width >= 48rem)', 'laptop'],
  [767, '@media (width < 48rem)', '@media (width >= 30rem)', 'tablet'],
  [480, '@media (width < 48rem)', '@media (width >= 30rem)', 'tablet'],
  [479, '@media (width < 30rem)', '', 'phone'],
];

for (const [widthPx, desktopFirstKey, mobileFirstKey, device] of BOUNDARIES) {
  test(`boundary: ${widthPx}px at a 16px rem`, () => {
    assert.equal(followedContextKey(FIXTURES.desktopFirst, widthPx, ROOT_FONT_SIZE_PX), desktopFirstKey);
    assert.equal(followedContextKey(FIXTURES.mobileFirst, widthPx, ROOT_FONT_SIZE_PX), mobileFirstKey);
    assert.equal(deviceForWidth(widthPx, BREAKPOINT_DEFAULTS), device);
    assert.equal(activeDeviceFor('custom', widthPx, BREAKPOINT_DEFAULTS), device, 'a width reads as the device it belongs to');
  });
}

test('a held panel on `< 64rem` stays when the pane is wide, and wears its own icon', () => {
  const canvas = canvasAt('desktop', 1600, FIXTURES.desktopFirst);
  const following = followRetargetKey({ following: true, settled: true, matchedKey: canvas.key, context: LAPTOP_DOWN });
  assert.equal(following, '', 'following moves the panel from `< 64rem` to Base');
  const held = followRetargetKey({ following: false, settled: true, matchedKey: canvas.key, context: LAPTOP_DOWN });
  assert.equal(held, undefined, 'a held panel stays on `< 64rem`');
  const heldIcon = canvasTriggerIcon(LAPTOP_DOWN, { device: 'desktop', widthPx: canvas.viewport.width }, BREAKPOINT_DEFAULTS);
  assert.equal(heldIcon, undefined, 'the held query misses the canvas, so it wears its own Laptop icon, never Desktop');
});

test('negative space: an unmeasured pane, the all-breakpoints canvas and a bad width keep their own names', () => {
  assert.equal(activeDeviceFor('desktop', 0, BREAKPOINT_DEFAULTS), 'desktop', 'an unmeasured pane keeps Desktop pressed');
  assert.equal(activeDeviceFor('desktop', Number.NaN, BREAKPOINT_DEFAULTS), 'desktop');
  assert.equal(activeDeviceFor('canvas', 500, BREAKPOINT_DEFAULTS), 'canvas', 'the all-breakpoints canvas keeps its name at any width');
  assert.equal(activeDeviceFor('canvas', 2000, BREAKPOINT_DEFAULTS), 'canvas');
  assert.throws(() => activeDeviceFor('', 800, BREAKPOINT_DEFAULTS), { message: 'Assertion failed: activeDeviceFor: a device is named' });
  const unmeasured = canvasAt('desktop', 0, FIXTURES.desktopFirst);
  assert.equal(unmeasured.width, undefined, 'an unmeasured pane fills until its first measure');
  assert.equal(unmeasured.active, 'desktop');
  assert.equal(unmeasured.viewport.scale, 1);
});

test('a pane that reaches a wider (`up`) breakpoint keeps the Desktop layout', () => {
  const wide = { id: 'bp-1', name: 'Wide', direction: 'up', setting: { value: 100, unit: 'rem' } };
  const resolved = resolveBreakpoints([wide, ...BREAKPOINT_DEFAULTS]);
  assert.equal(previewFrameWidth('desktop', undefined, resolved, room(1617)), undefined, '1599px filled is still Desktop');
  assert.equal(previewFrameWidth('desktop', undefined, resolved, room(1618)), DESKTOP_WIDTH_PX, '1600px filled would be the wider layout');
  assert.equal(previewFrameWidth('desktop', undefined, resolved, room(2400)), DESKTOP_WIDTH_PX);
  assert.equal(followedContextKey([BASE, row('@media (width >= 100rem)')], DESKTOP_WIDTH_PX, ROOT_FONT_SIZE_PX), '');
});

test('other devices keep their own widths and a custom width stays custom', () => {
  assert.equal(previewFrameWidth('custom', 900, BREAKPOINT_DEFAULTS, room(850)), 900);
  assert.equal(previewFrameWidth('canvas', undefined, BREAKPOINT_DEFAULTS, room(850)), undefined);
  assert.equal(previewFrameWidth('desktop', 900, BREAKPOINT_DEFAULTS, room(1600)), undefined, 'a stale custom width is never read on Desktop');
  assert.equal(previewFrameWidth('desktop', 900, BREAKPOINT_DEFAULTS, room(850)), DESKTOP_WIDTH_PX);
  assert.equal(previewFrameWidth('laptop', 900, BREAKPOINT_DEFAULTS, room(850)), 1023, 'a stale custom width is never read on a device');
});

// A fluid frame fills the pane's height at scale 1 and keeps 9px each side for the scrollbar; a fixed width keeps the
// framed 24px and 32px gutters. An unmeasured or tiny pane never gives a negative width.
test('previewViewport: a fluid frame fills the pane less the scrollbar’s gutters, a fixed one leaves its gutter', () => {
  const pane = { width: 800, height: 600 };
  const fluid = previewViewport(undefined, pane, undefined);
  assert.deepEqual(fluid, { width: 782, height: 600, scale: 1 });
  assert.equal(fluidFrameWidthPx(800), 782);
  assert.equal(fluidFrameWidthPx(10), 0);
  assert.equal(fluidFrameWidthPx(0), 0);
  assert.equal(previewViewport(undefined, { width: 10, height: 600 }, undefined).width, 1, 'a frame keeps at least a pixel');
  const fixed = previewViewport(1440, pane, undefined);
  assert.equal(fixed.scale, (800 - 24) / 1440);
  assert.equal(Math.round(fixed.height * fixed.scale), 600 - 32);
});
