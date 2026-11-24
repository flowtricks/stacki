// Goal: every frame of the all-breakpoints canvas (src/features/preview/CanvasView.tsx) gets the same full-width page and
// outside scrollbar as a sized frame: each page is told to hide its own bar on load, and a frame whose page scrolls (one
// taller than a canvas frame may grow) draws the canvas's bar beside that frame and no other. Before this, the canvas
// never told its frames, so on a computer with classic scrollbars each lost about 15px of its breakpoint's width.
// Method: the real CanvasView, bundled with esbuild, is mounted in jsdom with the default breakpoints. jsdom has no
// layout, so the canvas fits at its smallest zoom; only the frames' DOM and messages are read. What the canvas posts to
// each iframe is captured; a frame's scroll report is a MessageEvent whose source is that iframe's window, as in the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/canvas-view-scrollbar');
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

function installDOM() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLIFrameElement',
    'Element',
    'Node',
    'MutationObserver',
    'CustomEvent',
    'MessageEvent',
  ]) {
    global[key] = key === 'window' ? window : window[key];
  }
  global.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  global.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

test('each all-breakpoints frame is told to hide its own bar, and draws the canvas bar beside it when its page scrolls', async (context) => {
  const dom = installDOM();
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { CanvasView, BREAKPOINT_DEFAULT_LIST, resolveBreakpoints } = require(path.join(directory, 'canvas.js'));
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const breakpoints = resolveBreakpoints(BREAKPOINT_DEFAULT_LIST);
  await act(async () => {
    root.render(React.createElement(CanvasView, { breakpoints, desktopFramePx: 1440, url: 'http://localhost:4321/', refreshKey: 0 }));
  });
  const frames = [...document.querySelectorAll('.canvas-frame')];
  assert.ok(frames.length >= 2, `one frame per breakpoint and Desktop, drawn: ${frames.length}`);
  const posted = new Map();
  for (const frame of frames) {
    const iframe = frame.querySelector('iframe');
    assert.ok(iframe, 'each frame holds its page');
    posted.set(frame, []);
    iframe.contentWindow.postMessage = (message) => posted.get(frame).push(message);
  }
  // Each page load is told to hide its own bar, as a sized frame is.
  await act(async () => {
    for (const frame of frames) {
      frame.querySelector('iframe').dispatchEvent(new window.Event('load'));
    }
  });
  for (const frame of frames) {
    assert.ok(
      posted.get(frame).some((message) => message.type === 'avb:canvas-scrollbar'),
      `told: ${JSON.stringify(posted.get(frame))}`,
    );
  }
  // No frame draws a bar before its page reports, nor for a page its frame has grown to hold.
  assert.equal(document.querySelectorAll('.canvas-scrollbar').length, 0);
  const [first, second] = frames;
  const report = (frame, data) =>
    act(async () => {
      window.dispatchEvent(new window.MessageEvent('message', { data, source: frame.querySelector('iframe').contentWindow }));
    });
  await report(second, { type: 'avb:page-scroll', topPx: 0, heightPx: 900, viewHeightPx: 900, chromium: false });
  assert.equal(document.querySelectorAll('.canvas-scrollbar').length, 0, 'a page that fits its grown frame does not scroll');
  // A page taller than a frame may grow scrolls inside it: that frame, and only that one, draws the canvas's bar.
  await report(first, { type: 'avb:page-scroll', topPx: 0, heightPx: 40_000, viewHeightPx: 20_000, chromium: false });
  assert.equal(document.querySelectorAll('.canvas-scrollbar').length, 1);
  assert.ok(first.querySelector(':scope > .canvas-scrollbar'), 'beside the frame whose page scrolls');
  assert.equal(second.querySelector('.canvas-scrollbar') ?? undefined, undefined);
});
