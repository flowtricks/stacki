// Goal: the frame half of the canvas scrollbar (electron/preload/frameScrollbar.ts) hides the page's own scrollbar once
// the app says so, at every width (one behaviour, no setting), and in a canvas frame (#avb-design) before the page
// paints, through an adopted style sheet that adds nothing to the page; tells the truth about which bar is drawn
// (Chromium's until it is hidden), reports the page's scroll at most once per animation frame and only when it changed,
// follows a page that scrolls <body> instead of <html>, and scrolls when the canvas's bar asks.
// Method: the real module, bundled with esbuild, runs in a fresh jsdom window per test (its state is per page, as in a
// frame). jsdom has no layout, so the test owns the root's and the body's scroll position and heights; animation
// frames are queued and flushed by hand. Every report is read through the shared contract's parser, as the canvas
// reads it.
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

// A constructable style sheet as Chromium has one, keeping its rule as text. jsdom has neither these nor a document's
// adopted sheets, so a frame asked for them gets this stand-in; the real browser's is held by canvasScrollbarChromium.
class ConstructedSheet {
  replaceSync(text) {
    this.text = text;
  }
}

// A frame holding a page `heightPx` tall that scrolls <html>, the module loaded and reporting into `sent`. `url` is the
// frame's address: the app's canvas loads every page with #avb-design. `adoptedSheets` gives the document Chromium's
// adopted style sheets.
function frame({ heightPx, url = 'http://localhost/', adoptedSheets = false }) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url });
  const window = dom.window;
  if (adoptedSheets) {
    Object.defineProperty(window.document, 'adoptedStyleSheets', { configurable: true, writable: true, value: [] });
  }
  const root = window.document.documentElement;
  const page = { heightPx, topPx: 0 };
  Object.defineProperty(root, 'scrollTop', { configurable: true, get: () => page.topPx });
  Object.defineProperty(root, 'scrollHeight', { configurable: true, get: () => page.heightPx });
  Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => 800 });
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
    CSSStyleSheet: ConstructedSheet,
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
      window.document.dispatchEvent(new window.Event('scroll', { bubbles: true })); // A viewport scroll fires at the document.
    },
    close: () => window.close(),
  };
}

test('until the app’s word arrives, the page keeps it and every report says so', (context) => {
  const view = frame({ heightPx: 4000 });
  context.after(view.close);
  view.install();
  view.flush();
  assert.equal(view.sheet(), undefined, 'nothing is hidden before the app’s word');
  assert.deepEqual(view.reports(), [{ type: 'avb:page-scroll', topPx: 0, heightPx: 4000, viewHeightPx: 800, chromium: true }]);
});

test('the app’s word hides the page’s own bar at every width, and the canvas draws its own', (context) => {
  const view = frame({ heightPx: 4000 });
  context.after(view.close);
  view.install();
  assert.equal(view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar' }), true);
  view.flush();
  assert.equal(view.sheet(), 'html, body { scrollbar-width: none !important; }');
  assert.equal(view.reports().at(-1).chromium, false);
  // An older app's width is ignored: the bar stays hidden, with no width to watch and no classic bar from any width up.
  assert.equal(view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar', chromiumFromPx: 1023 }), true);
  view.flush();
  assert.equal(view.sheet(), 'html, body { scrollbar-width: none !important; }');
  assert.equal(view.reports().at(-1).chromium, false);
  assert.equal(view.window.document.querySelectorAll('#avb-canvas-scrollbar').length, 1, 'one stylesheet, however often told');
});

test('a canvas frame hides the page’s bar before its first paint, without waiting for the app’s word', (context) => {
  const view = frame({ heightPx: 4000, url: 'http://localhost/about/#avb-design', adoptedSheets: true });
  context.after(view.close);
  const childrenBefore = view.window.document.querySelectorAll('*').length;
  view.install();
  // Array.from: the module's array comes from its own context, so it is copied before a strict comparison.
  assert.deepEqual(
    Array.from(view.window.document.adoptedStyleSheets, (sheet) => sheet.text),
    ['html, body { scrollbar-width: none !important; }'],
    'hidden as the module installs',
  );
  assert.equal(view.window.document.querySelectorAll('*').length, childrenBefore, 'no element added to the page, which other frame code watches');
  view.flush();
  assert.deepEqual(
    view.reports(),
    [{ type: 'avb:page-scroll', topPx: 0, heightPx: 4000, viewHeightPx: 800, chromium: false }],
    'the first report has no Chromium bar',
  );
  // The app's word still comes on load and writes the <style> element, as for any frame: the same rule.
  assert.equal(view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar' }), true);
  assert.equal(view.sheet(), 'html, body { scrollbar-width: none !important; }');
  assert.equal(view.window.document.adoptedStyleSheets.length, 1, 'adopted once');
});

test('a frame without the canvas’s mark keeps its bar until the app’s word', (context) => {
  const plain = frame({ heightPx: 4000, url: 'http://localhost/about/#section', adoptedSheets: true });
  context.after(plain.close);
  plain.install();
  plain.flush();
  assert.equal(plain.window.document.adoptedStyleSheets.length, 0, 'a page opened on its own keeps its bar');
  assert.equal(plain.sheet(), undefined);
  assert.equal(plain.reports().at(-1).chromium, true);
});

test('a canvas frame in a document without adopted style sheets waits for the app’s word', (context) => {
  const view = frame({ heightPx: 4000, url: 'http://localhost/#avb-design' });
  context.after(view.close);
  view.install();
  view.flush();
  assert.equal(view.sheet(), undefined, 'nothing written into the page');
  assert.equal(view.reports().at(-1).chromium, true, 'and the report says Chromium still draws its bar');
  assert.equal(view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar' }), true);
  view.flush();
  assert.equal(view.reports().at(-1).chromium, false);
});

test('a page that holds <html> still and scrolls <body> is read and scrolled through <body>', (context) => {
  const view = frame({ heightPx: 800 }); // <html> is exactly the view: it does not scroll.
  context.after(view.close);
  const body = view.window.document.body;
  body.style.overflowY = 'auto';
  const inner = { topPx: 0 };
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => inner.topPx });
  Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => 5000 });
  Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 760 });
  const bodyScrolls = [];
  body.scrollTo = (options) => {
    bodyScrolls.push(options.top);
    inner.topPx = options.top;
  };
  view.install();
  view.module.receiveCanvasScrollbar({ type: 'avb:canvas-scrollbar' });
  view.flush();
  assert.deepEqual(view.reports().at(-1), { type: 'avb:page-scroll', topPx: 0, heightPx: 5000, viewHeightPx: 760, chromium: false });
  // <body>'s own scroll event does not bubble: the module hears it in the capture phase.
  inner.topPx = 900;
  body.dispatchEvent(new view.window.Event('scroll', { bubbles: false }));
  view.flush();
  assert.equal(view.reports().at(-1).topPx, 900);
  view.module.receiveCanvasScrollbar({ type: 'avb:page-scroll-to', topPx: 2000 });
  assert.deepEqual(bodyScrolls, [2000]);
  assert.deepEqual(view.scrolls, [], 'the window is left alone');
  // A <body> that is taller but does not scroll (overflow visible) is not taken for the root.
  body.style.overflowY = 'visible';
  view.window.dispatchEvent(new view.window.Event('resize'));
  view.flush();
  assert.equal(view.reports().at(-1).heightPx, 800, 'back to <html>, which does not scroll');
});

test('a burst of scrolls is one report per animation frame, and an unchanged page sends none', (context) => {
  const view = frame({ heightPx: 4000 });
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
  const view = frame({ heightPx: 4000 });
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

test('anything else is not this module’s, and hides nothing', (context) => {
  const view = frame({ heightPx: 4000 });
  context.after(view.close);
  for (const input of [
    undefined,
    { type: 'avb:query' },
    { type: 'avb:canvas-scrollbars' },
    { type: 'avb:page-scroll-to', topPx: -1 },
    { type: 'avb:page-scroll-to' },
  ]) {
    assert.equal(view.module.receiveCanvasScrollbar(input), false, JSON.stringify(input));
  }
  assert.equal(view.sheet(), undefined);
  assert.deepEqual(view.scrolls, []);
});

test('a page taller than the bound is reported at the bound, never as an invalid report', (context) => {
  const view = frame({ heightPx: 50_000_000 });
  context.after(view.close);
  view.install();
  view.flush();
  assert.equal(view.reports().at(-1).heightPx, 10_000_000);
});
