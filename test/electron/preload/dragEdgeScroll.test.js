// Goal: a canvas drag held near the top or bottom edge scrolls the page whether
// the document scrolls or <body> does (`html { overflow: hidden } body
// { overflow: auto; height: 100% }`). It only ever scrolled the window, so on
// such a page nothing moved. Method: the real preload drag module, bundled with
// esbuild, runs in a fresh jsdom window; jsdom has no layout, so the test owns
// each scroller's position and size, and runs animation frames by hand. The
// negative space: in the middle of the viewport, and at the end of the page,
// nothing scrolls and the loop stops.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');

const bundle = buildSync({
  stdin: {
    contents: "export * from './frameDrag';\nexport { trackCanvas } from './frameInteraction';",
    resolveDir: repoPath('electron/preload'),
    loader: 'ts',
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'FrameDragModule',
  write: false,
  logLevel: 'silent',
}).outputFiles[0].text;

const VIEW_PX = 800;
const PAGE_PX = 3000;

function scroller(element, heightPx) {
  const position = { topPx: 0 };
  const moveTo = (topPx) => {
    position.topPx = Math.max(0, Math.min(heightPx - VIEW_PX, topPx));
  };
  Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => position.topPx });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => heightPx });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => VIEW_PX });
  element.scrollTo = (options) => moveTo(options.top);
  return { position, moveTo };
}

function dragging({ bodyScrolls, y }) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div data-avb-p="0">x</div></body></html>', { pretendToBeVisual: true });
  const window = dom.window;
  const root = window.document.documentElement;
  const body = window.document.body;
  const html = scroller(root, bodyScrolls ? VIEW_PX : PAGE_PX);
  const inner = scroller(body, bodyScrolls ? PAGE_PX : VIEW_PX);
  if (bodyScrolls) {
    body.style.overflowY = 'auto';
  }
  Object.defineProperty(window.document, 'scrollingElement', { configurable: true, value: root });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW_PX });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEW_PX });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => html.position.topPx });
  window.scrollTo = (options) => html.moveTo(options.top);
  window.scrollBy = (_x, step) => html.moveTo(html.position.topPx + step);
  const box = { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 };
  window.Range.prototype.getBoundingClientRect = () => box;
  window.Range.prototype.getClientRects = () => [box];
  window.document.elementFromPoint = () => body.firstElementChild;
  window.document.elementsFromPoint = () => [body.firstElementChild];
  let queued = [];
  const context = {
    window,
    document: window.document,
    location: window.location,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLStyleElement: window.HTMLStyleElement,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback) => {
      queued.push(callback);
      return queued.length;
    },
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      observe() {}
    },
  };
  vm.runInNewContext(bundle, context);
  // The page is on the canvas, in select mode.
  context.FrameDragModule.trackCanvas();
  context.FrameDragModule.installCanvasDrag({ locate: () => ({ path: '0', occurrence: 0 }), send: () => {} });
  const pointer = (type, clientY) =>
    body.firstElementChild.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, buttons: 1, clientX: 100, clientY }));
  pointer('pointerdown', 400);
  // The first move starts the drag, the second moves it.
  pointer('pointermove', y);
  pointer('pointermove', y);
  assert.equal(context.FrameDragModule.canvasDragging(), true, 'the press became a drag');
  // Runs frames until none is asked for, or the bound.
  const run = (framesMax) => {
    for (let count = 0; count < framesMax && queued.length > 0; count += 1) {
      const callbacks = queued;
      queued = [];
      for (const callback of callbacks) {
        callback();
      }
    }
    return queued.length;
  };
  return { html: html.position, body: inner.position, run };
}

for (const bodyScrolls of [false, true]) {
  const which = bodyScrolls ? '<body>' : 'the document';

  test(`near an edge, ${which} scrolls to its end and the loop stops`, () => {
    const drag = dragging({ bodyScrolls, y: VIEW_PX - 4 });
    drag.run(3);
    const scrolled = bodyScrolls ? drag.body : drag.html;
    assert.ok(scrolled.topPx > 0, 'it scrolls down');
    assert.equal(drag.run(500), 0, 'no frame is left asked for');
    assert.equal(scrolled.topPx, PAGE_PX - VIEW_PX);
    assert.equal((bodyScrolls ? drag.html : drag.body).topPx, 0, 'the other box stays');
  });

  test(`in the middle, ${which} stays put`, () => {
    const drag = dragging({ bodyScrolls, y: 450 });
    assert.equal(drag.run(50), 0);
    assert.equal(drag.html.topPx + drag.body.topPx, 0);
  });
}
