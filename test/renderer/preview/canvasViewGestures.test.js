// Goal: on the all-breakpoints canvas (src/features/preview/CanvasView.tsx), a
// background click that does not drag leaves auto-fit on. A bare click turned
// auto-fit off for good.
// Method: the real CanvasView mounted in jsdom. jsdom has no layout, so the test
// sets the canvas's size and calls its resize observer by hand, then reads the
// zoom from the world's transform. The negative space: a real drag pans and ends
// auto-fit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor');

const directory = repoPath('node_modules/.stacki-test/canvas-view-gestures');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as CanvasView } from './src/features/preview/CanvasView.tsx';",
      "export { BREAKPOINT_DEFAULT_LIST, resolveBreakpoints } from './shared/properties/projectBreakpoints.ts';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'canvas.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'MessageEvent']) {
  Object.defineProperty(global, key, { value: dom.window[key], configurable: true, writable: true });
}
global.window = dom.window;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
let resized = () => {};
global.ResizeObserver = class {
  constructor(callback) {
    resized = callback;
  }
  observe() {}
  disconnect() {}
};
global.IS_REACT_ACT_ENVIRONMENT = true;
const size = { width: 1000 };
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => size.width });
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 100_000 });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { CanvasView, BREAKPOINT_DEFAULT_LIST, resolveBreakpoints } = require(path.join(directory, 'canvas.js'));

const view = () => {
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(document.querySelector('.canvas-world').style.transform);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
};

async function mounted(context) {
  size.width = 1000;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      React.createElement(CanvasView, {
        breakpoints: resolveBreakpoints(BREAKPOINT_DEFAULT_LIST),
        desktopFramePx: 1440,
        url: 'http://localhost:4321/',
        refreshKey: 0,
      }),
    );
  });
  return host.querySelector('.canvas-view');
}

const pointer = (target, type, x) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 10 }));
const resize = async (width) => {
  size.width = width;
  await act(async () => resized());
};

async function press(canvas, travel) {
  await act(async () => {
    pointer(canvas, 'pointerdown', 10);
  });
  await act(async () => {
    pointer(dom.window, 'pointermove', 10 + travel);
    pointer(dom.window, 'pointerup', 10 + travel);
  });
}

for (const travel of [0, 2]) {
  test(`a click that travels ${travel}px keeps auto-fit on`, async (context) => {
    const canvas = await mounted(context);
    const fitted = view();
    await press(canvas, travel);
    assert.deepEqual(view(), fitted, 'a click moves nothing');
    await resize(3000);
    await waitFor({ what: 'the canvas to fit the new size', read: () => view().scale, until: (scale) => scale > fitted.scale * 2 });
  });
}

test('a drag pans the canvas and ends auto-fit', async (context) => {
  const canvas = await mounted(context);
  const fitted = view();
  await press(canvas, 40);
  assert.equal(view().x, fitted.x + 40);
  const panned = view();
  await resize(3000);
  assert.deepEqual(view(), panned);
});
