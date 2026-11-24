// Goal: the frame half of the canvas scrollbar (electron/preload/frameScrollbar.ts) hides the page's root scrollbar
// exactly where the app says, tells the truth about which bar is drawn (Chromium's until the app's word arrives), reports
// the page's scroll at most once per animation frame and only when it changed, and scrolls when the canvas's bar asks.
// Method: the real module, bundled with esbuild, runs in a fresh jsdom window per test (its state is per page, as in a
// frame). jsdom has no layout, so the test owns the root's scroll position and height and a `matchMedia` that answers
// from a width the test sets; animation frames are queued and flushed by hand. Every report is read through the shared
// contract's parser, as the canvas reads it.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePageScrollMessage } = loadRenderer('shared/properties/canvasScrollbar.ts');

let bundle;
function moduleSource() {
  bundle ??= buildSync({
    entryPoints: [repoPath('electron/preload/frameScrollbar.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'FrameScrollbarModule',
    write: false,
    logLevel: 'silent',
  }).outputFiles[0].text;
  return bundle;
}

// A frame `widthPx` wide holding a page `heightPx` tall, the module loaded and reporting into `sent`.
function frame({ widthPx, heightPx }) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const window = dom.window;
  const root = window.document.documentElement;
  const page = { widthPx, heightPx, topPx: 0 };
  Object.defineProperty(root, 'scrollTop', { configurable: true, get: () => page.topPx });
  Object.defineProperty(root, 'scrollHeight', { configurable: true, get: () => page.heightPx });
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => 800 });
  const queries = [];
  window.matchMedia = (query) => {
    const atLeast = Number(/^\(width >= (\d+)px\)$/.exec(query)?.[1]);
    assert.ok(Number.isSafeInteger(atLeast), `a width query: ${query}`);
    const listeners = new Set();
    const list = {
      get matches() {
        return page.widthPx >= atLeast;
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      listeners,
    };
    queries.push(list);
    return list;
  };
  const scrolls = [];
  window.scrollTo = (options) => {
    scrolls.push(options);
    page.topPx = Math.max(0, Math.min(page.heightPx - 800, options.top));
  };
  let queued = [];
  const context = {
    window,
    document: window.document,
    HTMLStyleElement: window.HTMLStyleElement,
    requestAnimationFrame: (callback) => {
      queued.push(callback);
      return queued.length;
    },
    ResizeObserver: class {
      observe() {}
    },
  };
  vm.runInNewContext(moduleSource(), context);
  const module = context.FrameScrollbarModule;
  const sent = [];
  return {
    module,
    window,
    page,
    queries,
    scrolls,
    sent,
    install: () => module.installPageScrollReport((message) => sent.push(message)),
    // Runs the animation frames queued so far, as the browser would before its next paint.
    flush: () => {
      const callbacks = queued;
      queued = [];
      for (const callback of callbacks) {
        callback();
      }
    },
    sheet: () => window.document.getElementById('avb-canvas-scrollbar')?.textContent,
    // The reports sent so far, read through the shared parser as the canvas reads them.
    reports: () =>
      sent.map((message) => {
        const parsed = parsePageScrollMessage(message);
        assert.ok(parsed, `a report the canvas accepts: ${JSON.stringify(message)}`);
        return parsed;
      }),
    scroll: (topPx) => {
      page.topPx = topPx;
      window.dispatchEvent(new window.Event('scroll'));
    },
    close: () => window.close(),
  };
}

test('until the app says where Chromium’s bar starts, the page keeps it and every report says so', (context) => {
  const view = frame({ widthPx: 320, heightPx: 4000 });
  context.after(view.close);
  view.install();
  view.flush();
  assert.equal(view.sheet(), undefined, 'nothing is hidden before the app’s word');
  assert.deepEqual(view.reports(), [{ type: 'avb:page-scroll', topPx: 0, heightPx: 4000, viewHeightPx: 800, chromium: true }]);
});

test('Off hides the root bar at every width, and the canvas draws its own', (context) => {
  const view = frame({ widthPx: 1440, heightPx: 4000 });
  context.after(view.close);
  view.install();
  assert.equal(view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar' }), true);
  view.flush();
  assert.equal(view.sheet(), 'html { scrollbar-width: none !important; }');
  assert.equal(view.reports().at(-1).chromium, false);
  assert.equal(view.queries.length, 0, 'no width to watch');
});

test('from a breakpoint, a frame below it hides the root bar and one at or past it keeps Chromium’s, as it is dragged', (context) => {
  const view = frame({ widthPx: 320, heightPx: 4000 });
  context.after(view.close);
  view.install();
  view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar', chromiumFromPx: 1023 });
  view.flush();
  assert.equal(view.sheet(), '@media (width < 1023px) { html { scrollbar-width: none !important; } }');
  assert.equal(view.reports().at(-1).chromium, false, 'a phone frame: the canvas draws the bar');
  // The frame is dragged to the Laptop width: the media query changes and the frame says so without a message.
  view.page.widthPx = 1023;
  for (const listener of view.queries[0].listeners) {
    listener();
  }
  view.flush();
  assert.equal(view.reports().at(-1).chromium, true, 'Laptop and wider: Chromium draws its own');
  // Turned off again: the old width is no longer watched.
  view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar' });
  view.flush();
  assert.equal(view.queries[0].listeners.size, 0, 'the previous query is let go');
  assert.equal(view.sheet(), 'html { scrollbar-width: none !important; }');
  assert.equal(view.reports().at(-1).chromium, false);
});

test('a burst of scrolls is one report per animation frame, and an unchanged page sends none', (context) => {
  const view = frame({ widthPx: 320, heightPx: 4000 });
  context.after(view.close);
  view.install();
  view.install(); // A second install is ignored: one listener, one report per change.
  view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar' });
  view.flush();
  const before = view.sent.length;
  view.scroll(100);
  view.scroll(200);
  view.scroll(300);
  view.flush();
  assert.equal(view.sent.length, before + 1, 'three scrolls in one frame: one report');
  assert.equal(view.reports().at(-1).topPx, 300);
  view.scroll(300);
  view.flush();
  assert.equal(view.sent.length, before + 1, 'the same scroll again: nothing new to draw');
  // The page grows under a canvas patch, with no scroll: the morph's event is enough for a new report.
  view.page.heightPx = 6000;
  view.window.document.dispatchEvent(new view.window.Event('avb:morphed'));
  view.flush();
  assert.equal(view.sent.length, before + 2);
  assert.equal(view.reports().at(-1).heightPx, 6000);
});

test('the canvas’s bar scrolls the page, and the new position is reported', (context) => {
  const view = frame({ widthPx: 320, heightPx: 4000 });
  context.after(view.close);
  view.install();
  view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar' });
  view.flush();
  assert.equal(view.module.receiveCanvasScrollbar({ type: 'avb:page-scroll-to', topPx: 1600 }), true);
  // The options were made in the frame's own realm: compared by their fields, not their prototype.
  assert.equal(view.scrolls.length, 1);
  assert.equal(view.scrolls[0].top, 1600);
  assert.equal(view.scrolls[0].behavior, 'instant', 'instant: a smooth-scroll library on the page does not trail the thumb');
  view.flush();
  assert.equal(view.reports().at(-1).topPx, 1600);
});

test('anything else is not this module’s, and a malformed width hides nothing', (context) => {
  const view = frame({ widthPx: 320, heightPx: 4000 });
  context.after(view.close);
  for (const input of [
    undefined,
    { type: 'avb:query' },
    { type: 'avb:canvas-scrollbar', chromiumFromPx: 12 },
    { type: 'avb:canvas-scrollbar', chromiumFromPx: '1023' },
    { type: 'avb:page-scroll-to', topPx: -1 },
    { type: 'avb:page-scroll-to' },
  ]) {
    assert.equal(view.module.receiveCanvasScrollbar(input), false, JSON.stringify(input));
  }
  assert.equal(view.sheet(), undefined);
  assert.deepEqual(view.scrolls, []);
});

test('a page taller than the bound is reported at the bound, never as an invalid report', (context) => {
  const view = frame({ widthPx: 320, heightPx: 50_000_000 });
  context.after(view.close);
  view.install();
  view.flush();
  assert.equal(view.reports().at(-1).heightPx, 10_000_000);
});
