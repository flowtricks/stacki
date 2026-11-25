// Goal: both panel edges resize within their bounds without leaking drag state.
// Methodology: mount real panels in jsdom, drive pointer and keyboard gestures,
// and verify cancellation, unmount, tab changes, persistence, and invalid stored widths.
// A probe reads the shared widths the editor layout rule uses: they change on release, not mid-drag.
// A React Profiler around the panel counts commits: a drag writes the panel's width straight to its
// style each frame, widening and narrowing, with no commit until release, and stores the width once.
// A held width request (a docked app's manifest width) shows in place of the user's width, takes
// the user's resize into itself, and on release restores the user's untouched stored width.
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
const directory = repoPath('node_modules/.stacki-test/panel-resize');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'panel.cjs');
buildSync({
  // One bundle, so the panel and the test share the drag phase the canvas reads.
  stdin: {
    contents:
      "export * from './src/app/shell/ResizablePanel'; export { panelDragPhase } from './src/ui/panelDragPhase';" +
      " export { requestPanelWidth } from './src/ui/panelWidthRequests';",
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const { ResizablePanel, parsePanelWidth, panelDragPhase, usePanelWidths, requestPanelWidth } = require(output);

test('stored widths reject malformed values and enforce each panel minimum', () => {
  for (const [kind, minimum] of [
    ['left', 260],
    ['right', 322],
    ['code', 360],
  ]) {
    assert.equal(parsePanelWidth(String(minimum), kind), minimum);
    assert.equal(parsePanelWidth('600', kind), 600);
    for (const invalid of [undefined, {}, 400, '', 'NaN', 'Infinity', '400.5', '601', '-1', String(minimum - 1), ' '.repeat(1000)]) {
      assert.equal(parsePanelWidth(invalid, kind), undefined);
    }
  }
});

test('panel gestures clamp, persist, isolate code widths, and clean up', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const root = createRoot(document.getElementById('root'));
  const seen = [];
  let commits = 0;
  const Probe = () => {
    seen.push(usePanelWidths().left);
    return undefined;
  };
  const render = (kind) =>
    act(() =>
      root.render(
        React.createElement(
          React.Fragment,
          undefined,
          React.createElement(
            React.Profiler,
            { id: 'panel', onRender: () => (commits += 1) },
            React.createElement(ResizablePanel, { kind }, React.createElement('div', undefined, 'Content')),
          ),
          React.createElement(Probe),
        ),
      ),
    );
  const handle = () => document.querySelector('[role="separator"]');
  const panel = () => handle().parentElement;
  const width = () => Number(handle().getAttribute('aria-valuenow'));
  const pointer = (target, type, x, extra = {}) =>
    act(() => {
      const event = new window.MouseEvent(type, { bubbles: true, clientX: x, button: 0, ...extra });
      Object.defineProperty(event, 'pointerId', { value: extra.pointerId ?? 1 });
      target.dispatchEvent(event);
    });
  const key = (value) => act(() => handle().dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: value })));
  const start = () => {
    const value = width();
    panel().getBoundingClientRect = () => ({ width: value });
    return pointer(handle(), 'pointerdown', 500);
  };
  try {
    await render('left');
    assert.equal(width(), 260);
    const stores = [];
    // Storage keeps assigned properties as items, so the spy goes on the prototype.
    const storage = window.Storage.prototype;
    const setItem = storage.setItem;
    storage.setItem = function (name, value) {
      stores.push(name);
      return setItem.call(this, name, value);
    };
    const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const commitsBefore = commits;
    await start();
    assert.ok(document.querySelector('.panel-resize-cover'));
    assert.ok(handle().classList.contains('on'), 'The handle shows it is held');
    assert.equal(panelDragPhase(), 'dragging', 'The canvas is told the drag began');
    await pointer(window, 'pointermove', 600);
    // Moves apply once per animation frame.
    await frame();
    assert.equal(width(), 360, 'The handle follows the pointer');
    assert.equal(panel().style.width, '360px', 'The panel widens live');
    await pointer(window, 'pointermove', 650);
    await frame();
    assert.equal(panel().style.width, '410px');
    await pointer(window, 'pointermove', 560);
    await frame();
    assert.equal(panel().style.width, '320px', 'The panel narrows live');
    await pointer(window, 'pointermove', 100);
    await frame();
    assert.equal(panel().style.width, '260px', 'A live width keeps the minimum');
    await pointer(window, 'pointermove', 2000);
    await frame();
    assert.equal(panel().style.width, '600px', 'A live width keeps the maximum');
    assert.equal(seen.at(-1), 260, 'The layout keeps the settled width mid-drag');
    assert.equal(commits, commitsBefore, 'A drag commits nothing between pointerdown and pointerup');
    assert.deepEqual(stores, [], 'Nothing is stored mid-drag');
    await pointer(window, 'pointerup', 650);
    assert.deepEqual(stores, ['stacki.panel.width.left'], 'Release stores the width once');
    assert.ok(commits > commitsBefore, 'Release commits the width');
    assert.equal(handle().classList.contains('on'), false);
    storage.setItem = setItem;
    assert.equal(seen.at(-1), 410, 'Release shares the new width with the layout');
    assert.equal(panelDragPhase(), 'idle', 'Release lets the canvas apply its real width');
    assert.equal(width(), 410);
    assert.equal(localStorage.getItem('stacki.panel.width.left'), '410');
    assert.equal(document.body.style.cursor, '');
    assert.equal(document.querySelector('.panel-resize-cover') === null, true);
    await start();
    await pointer(window, 'pointerup', 2000);
    assert.equal(width(), 600);
    await start();
    await pointer(window, 'pointerup', -2000);
    assert.equal(width(), 260);
    await key('ArrowRight');
    assert.equal(width(), 270);
    await key('End');
    assert.equal(width(), 600);
    await render('code');
    assert.equal(width(), 360);
    await key('End');
    await render('left');
    assert.equal(width(), 600);
    await render('right');
    assert.equal(width(), 322);
    await start();
    await pointer(window, 'pointerup', 350);
    assert.equal(width(), 472, 'Right panel grows when dragged left');
    await key('ArrowLeft');
    assert.equal(width(), 482);
    await key('Home');
    assert.equal(width(), 322);
    await pointer(handle(), 'pointerdown', 500, { button: 2 });
    assert.equal(document.querySelector('.panel-resize-cover') === null, true);
    await start();
    await pointer(window, 'pointerup', 0, { pointerId: 2 });
    assert.ok(document.querySelector('.panel-resize-cover'), 'Other pointer cannot end the drag');
    await act(() => window.dispatchEvent(new window.Event('blur')));
    assert.equal(document.querySelector('.panel-resize-cover') === null, true);
    await start();
    await pointer(window, 'pointermove', 300);
    await pointer(window, 'pointercancel', 300);
    assert.equal(width(), 522);
    await start();
    await act(() => root.render(undefined));
    assert.equal(document.body.style.cursor, '');
    assert.equal(panelDragPhase(), 'idle', 'Unmounting mid-drag releases the canvas hold');
    await pointer(window, 'pointermove', 0);
    await render('right');
    assert.equal(width(), 522, 'Saved width survives remount');
    await act(() => root.render(undefined));
    localStorage.setItem('stacki.panel.width.right', '900');
    await render('right');
    assert.equal(width(), 322, 'Invalid storage falls back to the minimum');
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

test('a width request shows over the user width, takes resizes, and releases to the user width', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  localStorage.setItem('stacki.panel.width.left', '300');
  const root = createRoot(document.getElementById('root'));
  const width = () => Number(document.querySelector('[role="separator"]').getAttribute('aria-valuenow'));
  const key = (value) =>
    act(() => document.querySelector('[role="separator"]').dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: value })));
  const resized = [];
  try {
    await act(() => root.render(React.createElement(ResizablePanel, { kind: 'left' }, 'App')));
    assert.equal(width(), 300, 'The user width shows before any request');
    let release;
    await act(() => {
      release = requestPanelWidth('left', { widthPx: 420, onResize: (value) => resized.push(value) });
    });
    assert.equal(width(), 420, 'The requested width shows');
    await key('ArrowRight');
    assert.equal(width(), 430, 'A resize while the request holds moves the request');
    assert.deepEqual(resized, [430], 'The request owner hears the resize, to remember it');
    assert.equal(localStorage.getItem('stacki.panel.width.left'), '300', "The user's stored width is untouched");
    await act(() => release());
    assert.equal(width(), 300, "Release restores the user's width");
    await act(() => release());
    assert.equal(width(), 300, 'A second release is a no-op');
    // Requests clamp to the panel's own bounds, and a stale release cannot drop a newer request.
    let stale;
    await act(() => {
      stale = requestPanelWidth('left', { widthPx: 1600, onResize: () => undefined });
    });
    assert.equal(width(), 600, 'A wide request clamps to the panel maximum');
    let latest;
    await act(() => {
      latest = requestPanelWidth('left', { widthPx: 240, onResize: () => undefined });
    });
    assert.equal(width(), 260, 'A narrow request clamps to the panel minimum');
    await act(() => stale());
    assert.equal(width(), 260, "A replaced request's release leaves the newer one");
    await act(() => latest());
    assert.equal(width(), 300);
    await key('ArrowRight');
    assert.equal(localStorage.getItem('stacki.panel.width.left'), '310', 'Without a request, resizes store the user width');
    assert.throws(() => requestPanelWidth('left', { widthPx: Number.NaN, onResize: () => undefined }), /must be finite/);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});
