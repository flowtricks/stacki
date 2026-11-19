// Goal: the Desktop device is the layout no breakpoint query applies to. The bug: Desktop filled the pane,
// so in a narrow window (an 882px pane) the page rendered at 882px, the Laptop query (`width < 64rem`)
// applied under the Desktop button, and the style panel, following the canvas, showed `< 64rem` wearing
// the Desktop icon. Desktop now draws at least the Desktop frame width from Settings (90rem, 1440px),
// scaled down to fit a narrower pane, so in a desktop-first component following lands on Base and in a
// mobile-first one on the widest `width >= X` query.
// Method: a table over two fixtures (desktop-first `< X` rows, mobile-first `>= X` rows) x the devices
// Desktop, Laptop, Tablet and Phone x pane widths 700, 882, 1100 and 1600. Each case runs the real chain
// the app runs: the frame width (previewFrameWidth, which Desktop reads from desktopCanvasWidth), the
// viewport and its scale (previewViewport), the device the toolbar presses (activeDeviceFor), the row
// following picks at the viewport width (followedContextKey) and the trigger icon (canvasTriggerIcon), and
// pins each by value. Then the boundaries (1023/1024/1025, 767/768, 479/480 at a 16px rem), a held
// (pinned) panel when Desktop is picked, and the negative space of desktopCanvasWidth: an unmeasured pane,
// a pane exactly at and one under the frame, an `up` breakpoint capping Desktop, and the assertion when no
// width is left for Desktop.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { previewFrameWidth } = loadRenderer('src/features/preview/usePreviewSizing.ts');
const { previewViewport } = loadRenderer('src/features/preview/previewViewport.ts');
const { activeDeviceFor, deviceForWidth, desktopCanvasWidth } = loadRenderer('shared/properties/breakpointIcon.ts');
const { canvasTriggerIcon } = loadRenderer('src/features/style/embed/contextRows.ts');
const { followedContextKey } = loadRenderer('src/features/style/model/followWidth.ts');
const { followBreakpoint } = loadRenderer('src/features/style/embed/followBreakpoint.ts');
const { followRetargetKey } = loadRenderer('src/features/style/embed/contextFollow.ts');
const { BREAKPOINT_DEFAULTS, resolveBreakpoints } = loadRenderer('shared/properties/projectBreakpoints.ts');

const ROOT_FONT_SIZE_PX = 16;
const DESKTOP_FRAME_PX = 1440;
const PANE_HEIGHT_PX = 800;
const BASE = { key: '', embedAtContext: '' };
const row = (query) => ({ key: query, embedAtContext: query });
const LAPTOP_DOWN = '@media (width < 64rem)';

const FIXTURES = {
  desktopFirst: [BASE, row(LAPTOP_DOWN), row('@media (width < 48rem)'), row('@media (width < 30rem)')],
  mobileFirst: [BASE, row('@media (width >= 30rem)'), row('@media (width >= 48rem)'), row('@media (width >= 64rem)')],
};

// Per fixture and device: the row following picks ('' is Base) and the trigger icon (undefined keeps the row's own).
const EXPECTED = {
  desktopFirst: {
    desktop: { key: '', icon: undefined },
    laptop: { key: LAPTOP_DOWN, icon: 'laptop' },
    tablet: { key: '@media (width < 48rem)', icon: 'tablet' },
    phone: { key: '@media (width < 30rem)', icon: 'phone' },
  },
  mobileFirst: {
    desktop: { key: '@media (width >= 64rem)', icon: 'desktop' },
    laptop: { key: '@media (width >= 48rem)', icon: 'laptop' },
    tablet: { key: '@media (width >= 30rem)', icon: 'tablet' },
    phone: { key: '', icon: undefined },
  },
};
const DEVICE_WIDTH_PX = { laptop: 1023, tablet: 767, phone: 479 };
const PANE_WIDTHS_PX = [700, 882, 1100, 1600];

// The chain the canvas, the toolbar and the style panel run for one device in one pane.
function canvasAt(device, panePx, contexts) {
  const width = previewFrameWidth(device, undefined, BREAKPOINT_DEFAULTS, panePx, DESKTOP_FRAME_PX);
  const viewport = previewViewport(width, { width: panePx, height: PANE_HEIGHT_PX }, undefined, device === 'desktop' ? 'flush' : 'framed');
  const key = followedContextKey(contexts, viewport.width, ROOT_FONT_SIZE_PX);
  const icon = canvasTriggerIcon(key, { device, widthPx: viewport.width }, BREAKPOINT_DEFAULTS);
  return { width, viewport, key, icon, active: activeDeviceFor(device, viewport.width, BREAKPOINT_DEFAULTS) };
}

for (const [fixture, contexts] of Object.entries(FIXTURES)) {
  for (const device of ['desktop', 'laptop', 'tablet', 'phone']) {
    for (const panePx of PANE_WIDTHS_PX) {
      test(`${fixture}: ${device} in a ${panePx}px pane`, () => {
        const canvas = canvasAt(device, panePx, contexts);
        const expected = EXPECTED[fixture][device];
        if (device === 'desktop') {
          const frameWidthPx = Math.max(DESKTOP_FRAME_PX, panePx);
          assert.equal(canvas.viewport.width, frameWidthPx, 'Desktop draws at least the frame width');
          assert.ok(canvas.viewport.width >= 1024, 'Desktop is never inside the Laptop query');
        } else {
          assert.equal(canvas.viewport.width, DEVICE_WIDTH_PX[device]);
        }
        assert.ok(canvas.viewport.scale <= 1, 'the canvas never scales a page up');
        assert.ok(canvas.viewport.scale > 0);
        if (canvas.width !== undefined) {
          assert.equal(canvas.viewport.scale, Math.min(1, (panePx - (device === 'desktop' ? 0 : 24)) / canvas.width), 'a fixed frame scales to fit the pane');
        }
        assert.equal(canvas.active, device, 'the toolbar presses the device picked');
        assert.equal(canvas.key, expected.key, 'following picks the query in effect at the canvas width');
        assert.equal(canvas.icon, expected.icon, 'the trigger icon');
      });
    }
  }
}

test('desktop-first: the Desktop device never follows a narrower breakpoint, at any pane width', () => {
  for (const panePx of PANE_WIDTHS_PX) {
    const canvas = canvasAt('desktop', panePx, FIXTURES.desktopFirst);
    assert.equal(followBreakpoint(FIXTURES.desktopFirst, canvas.viewport.width, BREAKPOINT_DEFAULTS), undefined);
  }
  // The 882px pane of the report, before the fix, drew the page at 882: that width is Laptop's.
  assert.equal(followBreakpoint(FIXTURES.desktopFirst, 882, BREAKPOINT_DEFAULTS)?.breakpointId, 'laptop');
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
  });
}

test('picking Desktop: following moves to Base, a held panel stays, and the page is drawn at Desktop either way', () => {
  const canvas = canvasAt('desktop', 882, FIXTURES.desktopFirst);
  assert.equal(canvas.viewport.width, DESKTOP_FRAME_PX);
  const following = followRetargetKey({ following: true, settled: true, matchedKey: canvas.key, context: LAPTOP_DOWN });
  assert.equal(following, '', 'following moves the panel from `< 64rem` to Base');
  const held = followRetargetKey({ following: false, settled: true, matchedKey: canvas.key, context: LAPTOP_DOWN });
  assert.equal(held, undefined, 'a held panel stays on `< 64rem`');
  const heldIcon = canvasTriggerIcon(LAPTOP_DOWN, { device: 'desktop', widthPx: canvas.viewport.width }, BREAKPOINT_DEFAULTS);
  assert.equal(heldIcon, undefined, 'the held query misses the canvas, so it wears its own Laptop icon, never Desktop');
});

test('desktopCanvasWidth: the pane against the Desktop range', () => {
  assert.deepEqual(desktopCanvasWidth(0, BREAKPOINT_DEFAULTS, DESKTOP_FRAME_PX), { kind: 'fill' }, 'an unmeasured pane fills');
  assert.deepEqual(desktopCanvasWidth(Number.NaN, BREAKPOINT_DEFAULTS, DESKTOP_FRAME_PX), { kind: 'fill' });
  assert.deepEqual(desktopCanvasWidth(1440, BREAKPOINT_DEFAULTS, DESKTOP_FRAME_PX), { kind: 'fill' }, 'a pane exactly the frame fills');
  assert.deepEqual(desktopCanvasWidth(1439, BREAKPOINT_DEFAULTS, DESKTOP_FRAME_PX), { kind: 'fixed', widthPx: 1440 });
  assert.deepEqual(desktopCanvasWidth(4000, BREAKPOINT_DEFAULTS, DESKTOP_FRAME_PX), { kind: 'fill' }, 'with no wider breakpoint Desktop fills any pane');
  // A Desktop frame set under Laptop's boundary still draws past it (Settings forbids it; the floor holds regardless).
  assert.deepEqual(desktopCanvasWidth(700, BREAKPOINT_DEFAULTS, 1000), { kind: 'fixed', widthPx: 1024 });
});

test('desktopCanvasWidth: a wider (`up`) breakpoint caps Desktop one pixel under it', () => {
  const wide = { id: 'bp-1', name: 'Wide', direction: 'up', setting: { value: 100, unit: 'rem' } };
  const resolved = resolveBreakpoints([wide, ...BREAKPOINT_DEFAULTS]);
  assert.deepEqual(desktopCanvasWidth(1599, resolved, DESKTOP_FRAME_PX), { kind: 'fill' });
  assert.deepEqual(desktopCanvasWidth(1600, resolved, DESKTOP_FRAME_PX), { kind: 'fixed', widthPx: 1599 });
  assert.equal(previewFrameWidth('desktop', undefined, resolved, 2000, DESKTOP_FRAME_PX), 1599);
  assert.equal(followedContextKey([BASE, row('@media (width >= 100rem)')], 1599, ROOT_FONT_SIZE_PX), '', 'the wider query misses Desktop');
});

test('desktopCanvasWidth: no width left for Desktop is a programmer error', () => {
  const narrow = { id: 'bp-1', name: 'Wide', direction: 'up', setting: { value: 70, unit: 'rem' } };
  const resolved = resolveBreakpoints([narrow, ...BREAKPOINT_DEFAULTS]);
  assert.throws(() => desktopCanvasWidth(800, resolved, DESKTOP_FRAME_PX), {
    message: 'Assertion failed: desktopCanvasWidth: Desktop has a width no breakpoint query applies at',
  });
  assert.throws(() => desktopCanvasWidth(800, BREAKPOINT_DEFAULTS, 1440.5), {
    message: 'Assertion failed: desktopCanvasWidth: the Desktop frame is whole pixels',
  });
});

test('other devices keep their own widths and a custom width stays custom', () => {
  assert.equal(previewFrameWidth('custom', 900, BREAKPOINT_DEFAULTS, 700, DESKTOP_FRAME_PX), 900);
  assert.equal(previewFrameWidth('canvas', undefined, BREAKPOINT_DEFAULTS, 700, DESKTOP_FRAME_PX), undefined);
  assert.equal(previewFrameWidth('laptop', 900, BREAKPOINT_DEFAULTS, 700, DESKTOP_FRAME_PX), 1023, 'a stale custom width is never read on a device');
});

// Desktop covers the whole canvas: the page keeps its 1440px width for media queries and is scaled to the pane's width, with no
// gutter reserved for the side handles; a narrower device keeps the framed 24px and 32px gutters.
test('previewViewport: flush covers the pane, framed leaves its gutter', () => {
  const pane = { width: 800, height: 600 };
  const flush = previewViewport(1440, pane, undefined, 'flush');
  assert.equal(flush.width, 1440);
  assert.equal(flush.scale, 800 / 1440, 'the pane width is the whole scale');
  assert.equal(flush.height * flush.scale, 600, 'the page height fills the pane height');
  const framed = previewViewport(1440, pane, undefined, 'framed');
  assert.equal(framed.scale, (800 - 24) / 1440);
  assert.equal(Math.round(framed.height * framed.scale), 600 - 32);
});
