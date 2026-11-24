// Goal: a frame's next page is told to hide its own scrollbar even when its load arrives while the previous
// page is still held on screen (PreviewFrame keeps it until the new one is ready, and takes `load` as ready
// when no `avb:canvas-ready` came first). Before this, the canvas looked only at the first iframe, the previous
// one, so the new page was never told and kept Chromium's bar inside the breakpoint's width.
// Method: the real PreviewFrame and CanvasScrollbar, bundled with esbuild, are mounted in jsdom as every
// sized frame holds them. What the canvas posts to each iframe is captured; the second page fires `load` with
// no ready message. The previous page loading again (it navigated itself while held) must be told nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/canvas-scrollbar-swap');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { PreviewFrame } from './src/features/preview/PreviewFrame.tsx';",
      "export { CanvasScrollbar } from './src/features/preview/CanvasScrollbar.tsx';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'frame.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

test('a page that loads while the previous one is still held is told to hide its bar', async (context) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const { window } = dom;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'MessageEvent']) {
    global[key] = key === 'window' ? window : window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { PreviewFrame, CanvasScrollbar } = require(path.join(directory, 'frame.js'));
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const holder = React.createRef();
  const draw = (url) =>
    act(async () =>
      root.render(
        React.createElement(
          'div',
          { ref: holder },
          React.createElement(PreviewFrame, { url, refreshKey: 0, title: 'page', onLoad: () => undefined }),
          React.createElement(CanvasScrollbar, { frameRef: holder, scale: 1 }),
        ),
      ),
    );
  const told = new Map();
  const listen = (iframe) => {
    told.set(iframe, []);
    iframe.contentWindow.postMessage = (message) => told.get(iframe).push(message.type);
  };
  const load = (iframe) => act(async () => void iframe.dispatchEvent(new window.Event('load')));

  await draw('http://localhost:4321/');
  const first = document.querySelector('iframe');
  listen(first);
  await load(first);
  assert.deepEqual(told.get(first), ['avb:canvas-scrollbar']);

  await draw('http://localhost:4321/about');
  const frames = [...document.querySelectorAll('iframe')];
  assert.equal(frames.length, 2, 'the previous page is held while the next one loads');
  const next = frames.find((iframe) => iframe !== first);
  listen(next);
  told.set(first, []);
  await load(first);
  assert.deepEqual(told.get(first), [], 'the held page is told nothing more');
  await load(next);
  assert.deepEqual(told.get(next), ['avb:canvas-scrollbar']);
});
