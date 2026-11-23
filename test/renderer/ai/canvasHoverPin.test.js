// Goal: a capture of the window (AI screenshot or recording) shows the hover outline the person pointed at, though the pointer
// has left the canvas for the screenshot button, and nothing else about hovering changes.
// Method, two layers. (1) The pin store (src/ui/canvasHoverPin.ts) is pinned with literal times: remembered while free, stale
// after its bound, frozen while pinned, released exactly once, bounded. (2) The real `usePreviewRuntime` is mounted in jsdom with
// an iframe standing in for the canvas: the frame posts `avb:hover-node` for a node, then the pointer leaves (a hover with no
// path); a pin brings the node back as `hoverPath`, the frame's later reports are ignored while pinned, and the release ends
// the hover. Negative space: no remembered hover pins nothing, an old one pins nothing, a reload forgets the memory.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/canvas-hover-pin');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'pin.cjs');
buildSync({
  stdin: {
    contents: ["export * from './src/ui/canvasHoverPin';", "export { usePreviewRuntime } from './src/features/preview/previewRuntime';"].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const pin = require(output);
const HOVER = { path: '0.2', pseudo: undefined, occurrence: 1, deep: undefined };

test('a hover is remembered while free, and a remembered hover too old is not pinned', () => {
  pin.forgetCanvasHover();
  assert.equal(pin.rememberedCanvasHover(0), undefined, 'nothing remembered pins nothing');
  pin.rememberCanvasHover(HOVER, 1000);
  assert.deepEqual(pin.rememberedCanvasHover(1000 + pin.HOVER_MEMORY_MS_MAX), HOVER);
  assert.equal(pin.rememberedCanvasHover(1001 + pin.HOVER_MEMORY_MS_MAX), undefined, 'one millisecond past the bound');
  assert.throws(() => pin.rememberCanvasHover({ ...HOVER, path: '' }, 0), /has a path/);
  assert.throws(() => pin.rememberCanvasHover(HOVER, Number.NaN), /finite time/);
});

test('while pinned the memory is frozen; the last release unpins, and releasing twice is harmless', () => {
  pin.forgetCanvasHover();
  pin.rememberCanvasHover(HOVER, 10);
  const first = pin.pinCanvasHover();
  const second = pin.pinCanvasHover();
  assert.equal(pin.canvasHoverPinned(), true);
  pin.rememberCanvasHover({ ...HOVER, path: '9' }, 11);
  pin.forgetCanvasHover();
  assert.equal(pin.rememberedCanvasHover(12).path, '0.2', 'neither a new report nor a reload moves a pinned hover');
  first();
  first();
  assert.equal(pin.canvasHoverPinned(), true, 'the second pin still holds');
  second();
  assert.equal(pin.canvasHoverPinned(), false);
  const held = [];
  assert.throws(() => {
    for (let count = 0; count < 9; count += 1) {
      held.push(pin.pinCanvasHover());
    }
  }, /released after each capture/);
  assert.equal(held.length, 8, 'eight pins are the bound');
  held.forEach((release) => release());
  assert.equal(pin.canvasHoverPinned(), false);
});

test('the preview runtime keeps the last hovered node outlined for a capture and frees it afterwards', async () => {
  pin.forgetCanvasHover();
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(global, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MessageEvent: window.MessageEvent,
  });
  const frame = window.document.createElement('iframe');
  window.document.body.append(frame);
  let runtime;
  function Probe() {
    runtime = pin.usePreviewRuntime({ selPath: undefined, device: 'desktop', judgeEvent: () => ({ tag: 'current' }), onCanvasNotice: () => {} }, undefined);
    React.useEffect(() => {
      runtime.iframeRef.current = frame;
    });
    return undefined;
  }
  const root = createRoot(window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(Probe)));
  runtime.iframeRef.current = frame;
  const say = (data) =>
    act(async () => {
      window.dispatchEvent(new window.MessageEvent('message', { data, source: frame.contentWindow }));
    });
  await say({ type: 'avb:hover-node', path: '0.2', occurrence: 1 });
  assert.equal(runtime.hoverPath, '0.2', 'the frame says the pointer is on the node');
  await say({ type: 'avb:hover-node', path: undefined, occurrence: 0 });
  assert.equal(runtime.hoverPath, undefined, 'the pointer leaves for the screenshot button: the outline is gone');
  let release;
  await act(async () => {
    release = pin.pinCanvasHover();
  });
  assert.equal(runtime.hoverPath, '0.2', 'pinned: the last hovered node is outlined again');
  assert.equal(runtime.hoverOcc, 1);
  await say({ type: 'avb:hover-node', path: '0.5', occurrence: 0 });
  await say({ type: 'avb:hover-node', path: undefined, occurrence: 0 });
  assert.equal(runtime.hoverPath, '0.2', 'the frame cannot move or clear a pinned hover');
  await act(async () => release());
  assert.equal(runtime.hoverPath, undefined, 'released: the outline follows the pointer again');
  await act(async () => root.unmount());
});

test('with nothing hovered a pin draws no outline', async () => {
  pin.forgetCanvasHover();
  assert.equal(pin.rememberedCanvasHover(Date.now()), undefined);
});
