// Goal: shrinking the window never shrinks the website. The ordinary canvas (a project opened, a page switched, a
// canvas reloaded, Desktop shown without anyone choosing it) is the pane's own width at 100% and reflows as the pane
// moves. Only choosing Desktop in a pane too narrow for the desktop layout draws the Desktop width, scaled, and that is
// one look: the next resize of the pane, either way, wider or still too narrow, goes back to the pane's own width and
// the choice is over. Rounding jitter and the layout the pick itself causes are not resizes.
// Method: the real sizing hook (usePreviewSizing) in jsdom, over a pane whose width the test sets and announces
// through the ResizeObserver, as a window or panel resize does. A pick settles after a delay: the tests that need it past
// drive node:test's mock timers by the hook's own constant. Each step reads the frame's own width (undefined:
// filling), the width and scale it draws at, and the device the toolbar presses.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/desktop-pin-resize');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'pin.cjs');
buildSync({
  stdin: {
    contents: [
      "export { usePreviewSizing, usePreviewDimensions, DESKTOP_PICK_SETTLE_MS } from './src/features/preview/usePreviewSizing';",
      "export { BREAKPOINT_DEFAULTS, resolveBreakpoints } from './shared/properties/projectBreakpoints';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
})) {
  Object.defineProperty(global, name, { value, configurable: true, writable: true });
}
let paneWidthPx = 1600;
let paneHeightPx = 700;
const observers = new Set();
global.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {
    observers.add(this);
  }
  disconnect() {
    observers.delete(this);
  }
};
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => paneWidthPx });
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => paneHeightPx });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const pin = require(output);

async function mount({ widthPx, breakpoints = pin.BREAKPOINT_DEFAULTS, preview = false }) {
  paneWidthPx = widthPx;
  paneHeightPx = 700;
  const handle = {};
  function Window({ viewKey }) {
    const [device, setDevice] = React.useState('desktop');
    const dimensions = pin.usePreviewDimensions();
    const sizing = pin.usePreviewSizing(device, dimensions, breakpoints, { deviceShortcuts: true, desktopFramePx: 1440, viewKey }, setDevice);
    Object.assign(handle, { sizing, device, setDevice, dimensions });
    return React.createElement('div', { ref: sizing.wrapRef }, preview ? React.createElement(Second, { device, dimensions, setDevice }) : undefined);
  }
  // The preview mode: a second frame over a stage of its own, which only reads the pick.
  function Second({ device, dimensions, setDevice }) {
    const sizing = pin.usePreviewSizing(device, dimensions, breakpoints, { deviceShortcuts: false, desktopFramePx: 1440 }, setDevice);
    handle.second = sizing;
    return React.createElement('div', { ref: sizing.wrapRef });
  }
  const root = createRoot(document.getElementById('root'));
  const render = (viewKey) => act(async () => root.render(React.createElement(Window, { viewKey })));
  await render('site\n/\n0');
  const read = () => {
    const { sizing } = handle;
    return {
      frame: sizing.width,
      page: sizing.viewport.width,
      scale: Number(sizing.viewport.scale.toFixed(3)),
      active: sizing.activeDevice,
    };
  };
  return {
    handle,
    read,
    render,
    // Past the pick's settle window, on the test's own clock (driveClock).
    settle: (context) => act(async () => context.mock.timers.tick(pin.DESKTOP_PICK_SETTLE_MS)),
    resize: (next, height = paneHeightPx) =>
      act(async () => {
        paneHeightPx = height;
        paneWidthPx = next;
        for (const observer of observers) {
          observer.callback([]);
        }
      }),
    run: (action) => act(async () => action(handle)),
    unmount: () => act(async () => root.unmount()),
  };
}

// Before the canvas mounts, so the hook's settle timer is the test's to run.
const driveClock = (context) => context.mock.timers.enable({ apis: ['setTimeout'] });

const filling = (page, active) => ({ frame: undefined, page, scale: 1, active });
const framed = (panePx) => ({ frame: 1440, page: 1440, scale: Number(((panePx - 24) / 1440).toFixed(3)), active: 'desktop' });

test('after opening, shrinking the window reflows the page and never scales it', async () => {
  const canvas = await mount({ widthPx: 1600 });
  assert.deepEqual(canvas.read(), filling(1582, 'desktop'));
  for (const [panePx, page, active] of [
    [1100, 1082, 'desktop'],
    [1024, 1024, 'desktop'],
    [900, 882, 'laptop'],
    [700, 682, 'tablet'],
    [420, 402, 'phone'],
    [900, 882, 'laptop'],
  ]) {
    await canvas.resize(panePx);
    assert.deepEqual(canvas.read(), filling(page, active), `${panePx}px`);
  }
  await canvas.unmount();
});

test('a project opened in a narrow window opens at the window’s width', async () => {
  const canvas = await mount({ widthPx: 900 });
  assert.deepEqual(canvas.read(), filling(882, 'laptop'));
  await canvas.unmount();
});

test('choosing Desktop where it fits leaves nothing behind: shrinking afterwards reflows', async () => {
  const canvas = await mount({ widthPx: 1300 });
  await canvas.run(({ sizing }) => sizing.pickDevice('desktop'));
  assert.deepEqual(canvas.read(), filling(1282, 'desktop'));
  await canvas.resize(900);
  assert.deepEqual(canvas.read(), filling(882, 'laptop'));
  await canvas.unmount();
});

test('choosing Desktop in a narrow pane is one look: the next resize goes back to the pane’s own width', async (context) => {
  driveClock(context);
  const canvas = await mount({ widthPx: 900 });
  for (const [panePx, page, active, what] of [
    [860, 842, 'laptop', 'narrower'],
    [940, 922, 'laptop', 'wider, still too narrow'],
    [1100, 1082, 'desktop', 'wide enough'],
    [700, 682, 'tablet', 'much narrower'],
  ]) {
    await canvas.resize(900);
    await canvas.run(({ sizing }) => sizing.pickDevice('desktop'));
    await canvas.settle(context);
    assert.deepEqual(canvas.read(), framed(900), 'as typing 1440 would, every time it is chosen');
    await canvas.resize(panePx);
    assert.deepEqual(canvas.read(), filling(page, active), what);
    assert.equal(canvas.handle.dimensions.desktopPick, 'none', what);
  }
  await canvas.resize(900);
  assert.deepEqual(canvas.read(), filling(882, 'laptop'), 'the pick does not come back');
  await canvas.unmount();
});

test('a change of height alone is a resize too', async (context) => {
  driveClock(context);
  const canvas = await mount({ widthPx: 900 });
  await canvas.run(({ sizing }) => sizing.pickDevice('desktop'));
  await canvas.settle(context);
  await canvas.resize(900, 640);
  assert.deepEqual(canvas.read(), filling(882, 'laptop'));
  await canvas.unmount();
});

test('jitter, and the layout the pick itself causes, keep the look', async (context) => {
  driveClock(context);
  const canvas = await mount({ widthPx: 900 });
  await canvas.run(({ sizing }) => sizing.pickDevice('desktop'));
  await canvas.resize(884);
  assert.deepEqual(canvas.read(), framed(884), 'the pane moving right after the click is the click’s own layout');
  await canvas.settle(context);
  await canvas.resize(887, 697);
  assert.deepEqual(canvas.read(), framed(887), 'a few pixels either way');
  await canvas.resize(889);
  assert.deepEqual(canvas.read(), filling(871, 'laptop'), 'small steps add up from the size held');
  await canvas.unmount();
});

test('the device key is a pick too, and another device ends it', async () => {
  const canvas = await mount({ widthPx: 900 });
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1', bubbles: true })));
  assert.deepEqual(canvas.read(), framed(900));
  await canvas.run(({ sizing }) => sizing.pickDevice('phone'));
  assert.equal(canvas.read().page, 479);
  await canvas.run(({ setDevice }) => setDevice('desktop'));
  assert.deepEqual(canvas.read(), filling(882, 'laptop'), 'a view restored by code is not a pick');
  await canvas.unmount();
});

test('a page switch or a reload opens on the ordinary canvas; a resize alone is neither', async () => {
  const canvas = await mount({ widthPx: 900 });
  await canvas.run(({ sizing }) => sizing.pickDevice('desktop'));
  await canvas.render('site\n/\n0');
  assert.deepEqual(canvas.read(), framed(900), 'the same view keeps the pick');
  await canvas.render('site\n/about\n0');
  assert.deepEqual(canvas.read(), filling(882, 'laptop'), 'another page');
  await canvas.run(({ sizing }) => sizing.pickDevice('desktop'));
  await canvas.render('site\n/about\n1');
  assert.deepEqual(canvas.read(), filling(882, 'laptop'), 'a reload');
  await canvas.unmount();
});

test('past a wider breakpoint: the ordinary canvas shows it, a pick of Desktop stops short until the next resize', async (context) => {
  driveClock(context);
  const wide = { id: 'bp-1', name: 'Wide', direction: 'up', setting: { value: 100, unit: 'rem' } };
  const canvas = await mount({ widthPx: 1800, breakpoints: pin.resolveBreakpoints([wide, ...pin.BREAKPOINT_DEFAULTS]) });
  assert.deepEqual(canvas.read(), filling(1782, 'bp-1'), 'the real width');
  await canvas.run(({ sizing }) => sizing.pickDevice('desktop'));
  assert.deepEqual(canvas.read(), filling(1599, 'desktop'));
  await canvas.settle(context);
  await canvas.resize(2000);
  assert.deepEqual(canvas.read(), filling(1982, 'bp-1'), 'the real width again');
  await canvas.unmount();
});

test('the preview mode reads the pick and never ends it with its own wider stage', async () => {
  const canvas = await mount({ widthPx: 900, preview: true });
  await canvas.run(({ sizing }) => sizing.pickDevice('desktop'));
  assert.equal(canvas.handle.dimensions.desktopPick, 'narrow');
  assert.equal(canvas.handle.second.width, canvas.handle.sizing.width, 'both frames draw by their own pane');
  await canvas.unmount();
});
