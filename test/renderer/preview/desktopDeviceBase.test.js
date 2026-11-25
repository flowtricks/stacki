// Goal: "Desktop" is a range, everything above the widest smaller-screen breakpoint. A pane that wide (judged by its own
// width, before any gutter) is filled at 100% with no frame, whatever its width inside the range; the page is held in the
// range, one pixel short of a wider (`up`) breakpoint. Only a narrower pane draws the project's Desktop width, exactly as
// typing it does (the same frame, scale and height). In both modes the toolbar presses Desktop and following lands on
// Base in a desktop-first component.
// Method: a table over two fixtures (desktop-first `< X` rows, mobile-first `>= X` rows). Each case runs the real
// chain the app runs: the frame width (previewFrameWidth), its fill bounds, the viewport and its scale (previewViewport),
// the device the toolbar presses (activeDeviceFor), the row following picks (followedContextKey) and the trigger icon.
// Then every pane from 300 to 2000, the exact edge pixel by pixel, custom rem and fractional `down` breakpoints, `up`
// breakpoints, no `down` at all, the CSS the frame carries, a held panel, and the negative space.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { previewFrameWidth, previewFillBounds } = loadRenderer('src/features/preview/usePreviewSizing.ts');
const { FILL_UNBOUNDED, FLUID_GUTTER_PX, fluidFrameStyle, fluidFrameWidthPx, previewViewport } = loadRenderer('src/features/preview/previewViewport.ts');
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
// One pixel past the default Laptop canvas (1023px, `width < 64rem`).
const RANGE_MIN_PX = 1024;

// What the Desktop device shows at any pane width: per fixture the row following picks and the icon.
const DESKTOP_EXPECTED = {
  desktopFirst: { key: '', icon: undefined },
  mobileFirst: { key: '@media (width >= 64rem)', icon: 'desktop' },
};
const room = (paneWidthPx, desktopFramePx = DESKTOP_WIDTH_PX) => ({ desktopFramePx, paneWidthPx });

// The chain the canvas, the toolbar and the style panel run for one device in one pane.
function canvasAt(device, panePx, contexts) {
  const width = previewFrameWidth(device, undefined, BREAKPOINT_DEFAULTS, room(panePx));
  const fill = previewFillBounds(device, BREAKPOINT_DEFAULTS);
  const viewport = previewViewport(width, { width: panePx, height: PANE_HEIGHT_PX }, undefined, fill);
  const key = followedContextKey(contexts, viewport.width, ROOT_FONT_SIZE_PX);
  const icon = canvasTriggerIcon(key, { device, widthPx: viewport.width }, BREAKPOINT_DEFAULTS);
  // The canvas hook passes the frame's own width, or the pane's less its gutters for a fluid frame (usePreviewSizing).
  return { width, viewport, key, icon, active: activeDeviceFor(device, width ?? fluidFrameWidthPx(panePx, fill), BREAKPOINT_DEFAULTS) };
}

for (const [fixture, contexts] of Object.entries(FIXTURES)) {
  for (const panePx of PANE_WIDTHS_PX) {
    test(`${fixture}: desktop in a ${panePx}px pane draws the Desktop width`, () => {
      const canvas = canvasAt('desktop', panePx, contexts);
      const pane = { width: panePx, height: PANE_HEIGHT_PX };
      if (panePx >= RANGE_MIN_PX) {
        assert.equal(canvas.width, undefined, 'a pane in the desktop range is filled, unframed');
        assert.equal(canvas.viewport.width, Math.max(RANGE_MIN_PX, panePx - FLUID_GUTTER_PX.side), 'the pane less its gutters, never out of range');
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

test('every pane draws a desktop width: its own inside the range, the Desktop width under it', () => {
  // Bounded: 300 to 2000 in steps of 10 is 171 panes.
  for (let panePx = 300; panePx <= 2000; panePx += 10) {
    for (const contexts of Object.values(FIXTURES)) {
      const canvas = canvasAt('desktop', panePx, contexts);
      const expected = panePx < RANGE_MIN_PX ? DESKTOP_WIDTH_PX : Math.max(RANGE_MIN_PX, panePx - FLUID_GUTTER_PX.side);
      assert.equal(canvas.viewport.width, expected, `${panePx}px`);
      assert.equal(canvas.active, 'desktop', `${panePx}px: the toolbar presses Desktop`);
      assert.equal(canvas.width === undefined, panePx >= RANGE_MIN_PX, `${panePx}px: framed only under the range`);
    }
  }
});

test('the edge, pixel by pixel: the pane is judged before its gutters', () => {
  const at = (panePx) => canvasAt('desktop', panePx, FIXTURES.desktopFirst);
  assert.equal(at(1023).width, DESKTOP_WIDTH_PX, '1023px is the Laptop canvas: framed');
  for (const panePx of [1024, 1025, 1033, 1041, 1042]) {
    assert.equal(at(panePx).width, undefined, `${panePx}px fills`);
    assert.equal(at(panePx).viewport.width, RANGE_MIN_PX, `${panePx}px: the gutters give way, the page stays Desktop`);
    assert.equal(at(panePx).viewport.scale, 1);
    assert.equal(at(panePx).key, '', `${panePx}px: Base`);
  }
  assert.equal(at(1043).viewport.width, 1025, 'past the gutters the page grows with the pane');
  assert.equal(at(1098).viewport.width, 1080);
});

// [the widest `down` boundary, the first pane that fills]: a `width < X` canvas ends on the last whole pixel inside X.
for (const [setting, firstFillPx] of [
  [{ value: 62.5, unit: 'rem' }, 1000],
  [{ value: 64.01, unit: 'rem' }, 1025],
  [{ value: 900, unit: 'px' }, 900],
  [{ value: 75, unit: 'rem' }, 1200],
]) {
  test(`a custom widest breakpoint of ${setting.value}${setting.unit} moves the edge to ${firstFillPx}px`, () => {
    const resolved = resolveBreakpoints([{ id: 'bp-1', name: 'Small', direction: 'down', setting }]);
    assert.equal(previewFrameWidth('desktop', undefined, resolved, room(firstFillPx - 1)), DESKTOP_WIDTH_PX);
    assert.equal(previewFrameWidth('desktop', undefined, resolved, room(firstFillPx)), undefined);
    assert.equal(fluidFrameWidthPx(firstFillPx, previewFillBounds('desktop', resolved)), firstFillPx);
  });
}

test('the project’s own Desktop width is the one a narrow pane draws; with no smaller breakpoint nothing is narrow', () => {
  assert.equal(previewFrameWidth('desktop', undefined, BREAKPOINT_DEFAULTS, room(850, 1280)), 1280);
  assert.equal(previewFrameWidth('desktop', undefined, BREAKPOINT_DEFAULTS, room(1100, 1280)), undefined);
  assert.equal(previewFrameWidth('desktop', undefined, resolveBreakpoints([]), room(400)), undefined);
  assert.throws(() => previewFrameWidth('desktop', undefined, BREAKPOINT_DEFAULTS, room(850, 0)), {
    message: 'Assertion failed: The Desktop width is positive',
  });
});

test('the frame’s CSS holds the same bounds, and only Desktop has any', () => {
  assert.deepEqual(fluidFrameStyle(previewFillBounds('desktop', BREAKPOINT_DEFAULTS)), {
    width: 'calc(100% - 18px)',
    minWidth: 'min(100%, 1024px)',
  });
  assert.deepEqual(previewFillBounds('canvas', BREAKPOINT_DEFAULTS), FILL_UNBOUNDED);
  assert.deepEqual(fluidFrameStyle(FILL_UNBOUNDED), { width: 'calc(100% - 18px)' });
  assert.throws(() => fluidFrameStyle({ widthPxMin: 100, widthPxMax: 99 }), { message: 'Assertion failed: fluidFrameStyle: the bounds are ordered' });
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

test('a pane that reaches a wider (`up`) breakpoint stays Desktop, flush, one pixel short of it', () => {
  const wide = { id: 'bp-1', name: 'Wide', direction: 'up', setting: { value: 100, unit: 'rem' } };
  const resolved = resolveBreakpoints([wide, ...BREAKPOINT_DEFAULTS]);
  const bounds = previewFillBounds('desktop', resolved);
  assert.deepEqual(bounds, { widthPxMin: 1024, widthPxMax: 1599 });
  for (const [panePx, drawnPx] of [
    [1500, 1482],
    [1617, 1599],
    [1618, 1599],
    [2400, 1599],
  ]) {
    assert.equal(previewFrameWidth('desktop', undefined, resolved, room(panePx)), undefined, `${panePx}px is never framed`);
    assert.equal(fluidFrameWidthPx(panePx, bounds), drawnPx, `${panePx}px`);
    assert.equal(activeDeviceFor('desktop', drawnPx, resolved), 'desktop');
  }
  assert.equal(fluidFrameStyle(bounds).maxWidth, '1599px');
});

test('other devices keep their own widths and a custom width stays custom', () => {
  assert.equal(previewFrameWidth('custom', 900, BREAKPOINT_DEFAULTS, room(850)), 900);
  assert.equal(previewFrameWidth('canvas', undefined, BREAKPOINT_DEFAULTS, room(850)), undefined);
  assert.equal(previewFrameWidth('desktop', 900, BREAKPOINT_DEFAULTS, room(1100)), undefined, 'a stale custom width is never read on Desktop');
  assert.equal(previewFrameWidth('desktop', 900, BREAKPOINT_DEFAULTS, room(850)), DESKTOP_WIDTH_PX);
  assert.equal(previewFrameWidth('laptop', 900, BREAKPOINT_DEFAULTS, room(850)), 1023, 'a stale custom width is never read on a device');
});

// A fluid frame fills the pane's height at scale 1 and keeps 9px each side for the scrollbar; a fixed width keeps the
// framed 24px and 32px gutters. An unmeasured or tiny pane never gives a negative width.
test('previewViewport: a fluid frame fills the pane less the scrollbar’s gutters, a fixed one leaves its gutter', () => {
  const pane = { width: 800, height: 600 };
  const fluid = previewViewport(undefined, pane, undefined);
  assert.deepEqual(fluid, { width: 782, height: 600, scale: 1 });
  assert.equal(fluidFrameWidthPx(800, FILL_UNBOUNDED), 782);
  assert.equal(fluidFrameWidthPx(10, FILL_UNBOUNDED), 0);
  assert.equal(fluidFrameWidthPx(0, FILL_UNBOUNDED), 0);
  assert.equal(previewViewport(undefined, { width: 10, height: 600 }, undefined).width, 1, 'a frame keeps at least a pixel');
  const fixed = previewViewport(1440, pane, undefined);
  assert.equal(fixed.scale, (800 - 24) / 1440);
  assert.equal(Math.round(fixed.height * fixed.scale), 600 - 32);
});
