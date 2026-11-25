// Goal: the Desktop device draws the page at the canvas pane's own width less the scrollbar's two 9px gutters, never
// scaled or shrunk. In a narrow window the page renders at that width, so its media queries switch to the laptop, tablet or phone layout
// (as in a browser window that size). The toolbar and the style panel tell the truth about it: a pane narrower
// than the Laptop canvas reads as Laptop (or Tablet, Phone), so no `< 64rem` row ever wears the Desktop icon,
// and following lands on the query in effect at the pane's width.
// Method: a table over two fixtures (desktop-first `< X` rows, mobile-first `>= X` rows). Each case runs the real
// chain the app runs: the frame width (previewFrameWidth), the viewport and its scale (previewViewport), the
// device the toolbar presses (activeDeviceFor, fed the width the canvas draws at), the row following picks at
// the viewport width (followedContextKey) and the trigger icon (canvasTriggerIcon), and pins each by value.
// Desktop is run at panes 300 to 2000; the narrower devices stay framed at their own widths. Then the boundaries
// (1023/1024/1025, 767/768, 479/480 at a 16px rem), a held (pinned) panel, and the negative space: an unmeasured
// pane, the exact boundary widths, a wider (`up`) breakpoint taking over a wide pane, a stale custom width, and
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

// What the Desktop device shows in each pane: the device the width belongs to, and per fixture the row and the icon.
const DESKTOP_EXPECTED = {
  700: {
    device: 'tablet',
    desktopFirst: { key: '@media (width < 48rem)', icon: 'tablet' },
    mobileFirst: { key: '@media (width >= 30rem)', icon: 'tablet' },
  },
  882: { device: 'laptop', desktopFirst: { key: LAPTOP_DOWN, icon: 'laptop' }, mobileFirst: { key: '@media (width >= 48rem)', icon: 'laptop' } },
  1100: { device: 'desktop', desktopFirst: { key: '', icon: undefined }, mobileFirst: { key: '@media (width >= 64rem)', icon: 'desktop' } },
  1600: { device: 'desktop', desktopFirst: { key: '', icon: undefined }, mobileFirst: { key: '@media (width >= 64rem)', icon: 'desktop' } },
};

// The chain the canvas, the toolbar and the style panel run for one device in one pane.
function canvasAt(device, panePx, contexts) {
  const width = previewFrameWidth(device, undefined, BREAKPOINT_DEFAULTS);
  const viewport = previewViewport(width, { width: panePx, height: PANE_HEIGHT_PX }, undefined);
  const key = followedContextKey(contexts, viewport.width, ROOT_FONT_SIZE_PX);
  const icon = canvasTriggerIcon(key, { device, widthPx: viewport.width }, BREAKPOINT_DEFAULTS);
  // The canvas hook passes the frame's own width, or the pane's less its gutters for a fluid frame (usePreviewSizing).
  return { width, viewport, key, icon, active: activeDeviceFor(device, width ?? fluidFrameWidthPx(panePx), BREAKPOINT_DEFAULTS) };
}

for (const [fixture, contexts] of Object.entries(FIXTURES)) {
  for (const panePx of PANE_WIDTHS_PX) {
    test(`${fixture}: desktop in a ${panePx}px pane is drawn at the pane width, scale 1`, () => {
      const canvas = canvasAt('desktop', panePx, contexts);
      const expected = DESKTOP_EXPECTED[panePx];
      assert.equal(canvas.width, undefined, 'Desktop is a fluid frame: it has no width of its own');
      assert.equal(canvas.viewport.width, panePx - FLUID_GUTTER_PX.side, 'the page is as wide as the pane less the scrollbar’s gutters');
      assert.equal(canvas.viewport.scale, 1, 'never scaled or shrunk');
      assert.equal(canvas.viewport.height, PANE_HEIGHT_PX, 'the page is as tall as the pane');
      assert.equal(canvas.active, expected.device, 'the toolbar presses the device the pane width belongs to');
      assert.equal(canvas.key, expected[fixture].key, 'following picks the query in effect at the pane width');
      assert.equal(canvas.icon, expected[fixture].icon, 'the trigger icon');
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

test('the Desktop icon is never worn at a width inside a narrower breakpoint, at any pane width', () => {
  // Bounded: 300 to 2000 in steps of 10 is 171 panes.
  for (let panePx = 300; panePx <= 2000; panePx += 10) {
    for (const contexts of Object.values(FIXTURES)) {
      const canvas = canvasAt('desktop', panePx, contexts);
      assert.equal(canvas.viewport.scale, 1, `${panePx}px: Desktop never scales`);
      assert.equal(canvas.viewport.width, panePx - FLUID_GUTTER_PX.side, `${panePx}px: Desktop is drawn at the pane width less its gutters`);
      if (canvas.viewport.width < 1024) {
        assert.notEqual(canvas.active, 'desktop', `${panePx}px is inside a narrower breakpoint, so the bar cannot say Desktop`);
        assert.notEqual(canvas.icon, 'desktop', `${panePx}px: no row wears the Desktop icon`);
      } else {
        assert.equal(canvas.active, 'desktop', `${panePx}px is Desktop's own width`);
      }
    }
  }
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
    assert.equal(activeDeviceFor('desktop', widthPx, BREAKPOINT_DEFAULTS), device, 'Desktop fills the pane, so it reads as the width does');
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
  assert.equal(unmeasured.active, 'desktop');
  assert.equal(unmeasured.viewport.scale, 1);
});

test('a wider (`up`) breakpoint takes over a pane at its own width', () => {
  const wide = { id: 'bp-1', name: 'Wide', direction: 'up', setting: { value: 100, unit: 'rem' } };
  const resolved = resolveBreakpoints([wide, ...BREAKPOINT_DEFAULTS]);
  assert.equal(previewFrameWidth('desktop', undefined, resolved), undefined, 'Desktop still fills the pane');
  assert.equal(activeDeviceFor('desktop', 1599, resolved), 'desktop');
  assert.equal(activeDeviceFor('desktop', 1600, resolved), 'bp-1', 'the pane is drawn at 1600px, where the wider query holds');
  assert.equal(followedContextKey([BASE, row('@media (width >= 100rem)')], 1599, ROOT_FONT_SIZE_PX), '', 'the wider query misses just under it');
});

test('other devices keep their own widths and a custom width stays custom', () => {
  assert.equal(previewFrameWidth('custom', 900, BREAKPOINT_DEFAULTS), 900);
  assert.equal(previewFrameWidth('canvas', undefined, BREAKPOINT_DEFAULTS), undefined);
  assert.equal(previewFrameWidth('desktop', 900, BREAKPOINT_DEFAULTS), undefined, 'a stale custom width is never read on Desktop');
  assert.equal(previewFrameWidth('laptop', 900, BREAKPOINT_DEFAULTS), 1023, 'a stale custom width is never read on a device');
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
