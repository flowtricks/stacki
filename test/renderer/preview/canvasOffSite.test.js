// Goal: a canvas frame in interact mode that leaves the site anyway (a page
// script, a form, a browser without the frame's Navigation API guard) never keeps
// the old page's outlines over what replaced it, and is taken back to the page
// the editor has open. A frame that lands on one of the site's pages stays.
// Hosts that refuse those navigations up front (Desktop) opt out.
// Method: mount useCanvasInteraction in a small harness with a real <iframe>,
// deliver the frame's messages as the preview clients send them, fire its load
// event, and read what the hook did: the overlays cleared and the frame's src.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/canvas-off-site');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: "export { useCanvasInteraction, CANVAS_RETURN_WAIT_MS } from './src/features/preview/useCanvasInteraction.ts';",
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: path.join(directory, 'hook.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const PAGE_URL = 'http://localhost:4321/demo/site/about/#avb-design';
const ORIGIN = 'http://localhost:4321';

async function mount(options) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://studio.localhost/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { useCanvasInteraction, CANVAS_RETURN_WAIT_MS } = require(path.join(directory, 'hook.js'));
  const loads = new Set();
  const cleared = [];
  let toggle;
  function Harness() {
    const frame = React.useRef(null);
    const interaction = useCanvasInteraction({
      projectKey: 'site',
      url: PAGE_URL,
      available: true,
      frame,
      post: () => {},
      subscribeLoad: React.useCallback((listener) => {
        loads.add(listener);
        return () => loads.delete(listener);
      }, []),
      editRoute: () => {},
      ...(options.offSite ? { offSite: { clearOverlays: () => cleared.push(true) } } : {}),
    });
    toggle = interaction.toggle;
    return React.createElement('iframe', { ref: frame, src: PAGE_URL });
  }
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => toggle());
  const frame = document.querySelector('iframe');
  // Frames do not load in `jsdom`; the src assignment is what returning does.
  frame.removeAttribute('src');
  const send = (data) =>
    React.act(async () => window.dispatchEvent(new dom.window.MessageEvent('message', { source: frame.contentWindow, origin: ORIGIN, data })));
  const load = () =>
    React.act(async () => {
      for (const listener of loads) {
        listener();
      }
    });
  const wait = (waitMs) => React.act(() => new Promise((resolve) => setTimeout(resolve, waitMs)));
  const close = async () => {
    await React.act(async () => root.unmount());
    dom.window.close();
  };
  return { frame, cleared, send, load, wait, close, returnWaitMs: CANVAS_RETURN_WAIT_MS };
}

test('a frame that left the site clears its outlines at once and goes back to the open page', async () => {
  const canvas = await mount({ offSite: true });
  try {
    await canvas.send({ type: 'avb:leaving' });
    assert.equal(canvas.cleared.length, 1, 'the outlines go as the document leaves');
    // Another site, or the browser's "refused to connect" page: it loads and says nothing.
    await canvas.load();
    await canvas.wait(canvas.returnWaitMs + 100);
    assert.equal(canvas.frame.getAttribute('src'), PAGE_URL, 'back to the page the editor has open');
    assert.equal(canvas.cleared.length, 2);
  } finally {
    await canvas.close();
  }
});

test('a frame that lands on a page of the site stays there', async () => {
  const canvas = await mount({ offSite: true });
  try {
    await canvas.send({ type: 'avb:leaving' });
    await canvas.send({ type: 'avb:navigated', path: '/demo/site/docs/' });
    await canvas.load();
    await canvas.wait(canvas.returnWaitMs + 100);
    assert.equal(canvas.frame.hasAttribute('src'), false, 'the frame was not sent anywhere');
  } finally {
    await canvas.close();
  }
});

test('a host that refuses those navigations itself opts out', async () => {
  const canvas = await mount({ offSite: false });
  try {
    await canvas.send({ type: 'avb:leaving' });
    await canvas.load();
    await canvas.wait(canvas.returnWaitMs + 100);
    assert.equal(canvas.cleared.length, 0);
    assert.equal(canvas.frame.hasAttribute('src'), false);
  } finally {
    await canvas.close();
  }
});
