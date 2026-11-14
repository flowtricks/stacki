// Goal: the style panel's Base and query picks move the canvas in one committed frame, through
// the same state the toolbar's device buttons use. Base with no single query convention is the
// desktop device button exactly (the same state afterwards, compared whole); Base with
// mobile-first queries lands one pixel under the smallest; a query pick lands on its boundary;
// and in no case does a commit show the new device at the old width (the readout and the frame a
// step behind the toolbar), which the old effect-applied width request did.
// Method: mount the app's real window state (useWindowState), the preview's sizing
// (usePreviewSizing) and its width-request hook (useCanvasWidthRequest) together in jsdom, record
// device, active device icon and viewport width on every commit (a layout effect), and drive the
// actions the panel's host calls: requestCanvasWidth and showDesktopCanvas, and setDevice for the
// toolbar's own button. The Base width comes from the real baseCanvasTarget.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/base-canvas-frame');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'frame.cjs');
buildSync({
  stdin: {
    contents: [
      "export { useWindowState } from './src/app/state/appState';",
      "export { usePreviewSizing, usePreviewDimensions, useCanvasWidthRequest } from './src/features/preview/usePreviewSizing';",
      "export { baseCanvasTarget } from './src/features/style/model/baseWidth';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'empty', '.svg': 'text' },
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(global, name, { value, configurable: true, writable: true });
}
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = Observer;
dom.window.ResizeObserver = Observer;
// The canvas has room for the desktop preset, as a wide window does.
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1600 });
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 });
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const frame = require(output);

const MOBILE_FIRST = ['', '@media (width >= 30rem)', '@media (width >= 48rem)', '@media (width >= 64rem)', '@media (prefers-reduced-motion: reduce)'];

async function mountCanvas() {
  const commits = [];
  const handle = {};
  function Canvas() {
    const windowState = frame.useWindowState();
    const dimensions = frame.usePreviewDimensions();
    const sizing = frame.usePreviewSizing(windowState.device, dimensions, windowState.setDevice);
    frame.useCanvasWidthRequest(windowState.canvasWidthRequest, dimensions.setCustomWidth);
    handle.windowState = windowState;
    const state = { device: windowState.device, active: sizing.activeDevice, width: sizing.viewport.width ?? 'fluid' };
    React.useLayoutEffect(() => {
      commits.push(state);
    });
    return React.createElement('div', { ref: sizing.wrapRef, 'data-width': String(state.width) });
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Canvas)));
  const run = async (action) => {
    const start = commits.length;
    await act(async () => action(handle.windowState));
    return commits.slice(start);
  };
  return { run, last: () => commits[commits.length - 1], unmount: () => act(async () => root.unmount()) };
}

test('Base with no convention is the desktop button: the same state, in one commit', async () => {
  const viaBase = await mountCanvas();
  await viaBase.run((state) => state.setDevice('phone'));
  await viaBase.run((state) => state.requestCanvasWidth(480));
  const target = frame.baseCanvasTarget(['', '@media (prefers-reduced-motion: reduce)'], 16);
  assert.deepEqual(target, { kind: 'desktop' });
  const baseCommits = await viaBase.run((state) => state.showDesktopCanvas());
  const afterBase = viaBase.last();
  // A follow-up commit may tidy state nobody sees; every commit already draws the end state.
  assert.ok(
    baseCommits.every((commit) => JSON.stringify(commit) === JSON.stringify(afterBase)),
    `every commit is the desktop state: ${JSON.stringify(baseCommits)}`,
  );
  await viaBase.unmount();

  const viaButton = await mountCanvas();
  await viaButton.run((state) => state.setDevice('phone'));
  await viaButton.run((state) => state.requestCanvasWidth(480));
  await viaButton.run((state) => state.setDevice('desktop'));
  assert.deepEqual(afterBase, viaButton.last(), 'Base and the desktop button leave the same state');
  assert.equal(afterBase.device, 'desktop');
  assert.equal(afterBase.active, 'desktop', 'the desktop icon is the active one');
  await viaButton.unmount();
});

test('mobile-first Base lands under the smallest query, and each move is one commit at its width', async () => {
  const canvas = await mountCanvas();
  await canvas.run((state) => state.setDevice('phone'));
  const pick = await canvas.run((state) => state.requestCanvasWidth(480));
  assert.ok(
    pick.every((commit) => commit.device === 'custom' && commit.width === 480),
    `the query pick never shows the custom device at the phone width: ${JSON.stringify(pick)}`,
  );
  const target = frame.baseCanvasTarget(MOBILE_FIRST, 16);
  assert.deepEqual(target, { kind: 'width', widthPx: 479 });
  const base = await canvas.run((state) => state.requestCanvasWidth(target.widthPx));
  assert.ok(
    base.every((commit) => commit.width === 479),
    `Base goes straight to 479: ${JSON.stringify(base)}`,
  );
  const back = await canvas.run((state) => state.requestCanvasWidth(480));
  assert.ok(
    back.every((commit) => commit.width === 480),
    `and the query again straight to its boundary: ${JSON.stringify(back)}`,
  );
  const desktop = await canvas.run((state) => state.setDevice('desktop'));
  assert.ok(
    desktop.every((commit) => commit.device === 'desktop' && commit.width !== 480),
    `the desktop button never draws a frame at the old custom width: ${JSON.stringify(desktop)}`,
  );
  await canvas.unmount();
});
