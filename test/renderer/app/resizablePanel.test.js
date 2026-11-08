// Goal: both panel edges resize within their bounds without leaking drag state.
// Methodology: mount real panels in jsdom, drive pointer and keyboard gestures,
// and verify cancellation, unmount, tab changes, persistence, and invalid stored widths.
// A probe reads the shared widths the editor layout rule uses: they change on release, not mid-drag.
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
    contents: "export * from './src/app/shell/ResizablePanel'; export { panelDragPhase } from './src/ui/panelDragPhase';",
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
const { ResizablePanel, parsePanelWidth, panelDragPhase, usePanelWidths } = require(output);

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
          React.createElement(ResizablePanel, { kind }, React.createElement('div', undefined, 'Content')),
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
    await start();
    assert.ok(document.querySelector('.panel-resize-cover'));
    assert.equal(panelDragPhase(), 'dragging', 'The canvas is told to hold its page width');
    await pointer(window, 'pointermove', 600);
    // Moves apply once per animation frame.
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    assert.equal(width(), 360, 'The handle follows the pointer');
    assert.equal(seen.at(-1), 260, 'The layout keeps the settled width mid-drag');
    await pointer(window, 'pointerup', 650);
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
