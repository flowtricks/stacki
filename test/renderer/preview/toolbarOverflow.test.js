// Goal: a toolbar action that overflows into the "More" popover keeps its toolbar control:
// the same element, classes, grouping and pressed state, never a restyled menu row.
// Methodology: mount the shared ToolbarOverflow in jsdom with controls shaped like the
// preview toolbar's, force every action to overflow by stubbing layout widths, open the
// popover, and compare each overflowed control's markup with its toolbar copy. Pressing a
// control marked `close` dismisses the popover; one marked `stay` keeps it open. Last, a
// toolbar wide enough for every control overflows them once the breadcrumb's room is reserved.
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
const directory = repoPath('node_modules/.stacki-test/toolbar-overflow');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'overflow.cjs');
buildSync({
  entryPoints: [path.join(ROOT, 'src/features/preview/ToolbarOverflow.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});

test('overflowed toolbar controls render unchanged inside the More popover', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(global, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLDialogElement: window.HTMLDialogElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  window.matchMedia = global.matchMedia;
  global.ResizeObserver = window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  // Every control is wider than the toolbar, so all of them overflow.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 80 });
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 60 });
  const { ToolbarOverflow } = require(output);
  const pressed = [];
  const devices = React.createElement(
    'div',
    { className: 'device-btns', role: 'group', 'aria-label': 'Preview device' },
    React.createElement('button', { className: 'on', 'aria-pressed': true, 'aria-label': 'Phone', onClick: () => pressed.push('phone') }),
  );
  const sizing = React.createElement(
    'div',
    { className: 'preview-size-controls' },
    React.createElement('button', { onClick: () => pressed.push('fit') }, 'Fit'),
  );
  const style = React.createElement('button', { className: 'preview-toolbar-action', onClick: () => pressed.push('style') }, 'Style');
  const items = [
    { id: 'sizing', priority: 20, content: sizing, afterPress: 'stay' },
    { id: 'devices', priority: 90, content: devices, afterPress: 'close' },
    { id: 'style', priority: 100, content: style, afterPress: 'close' },
  ];
  const root = createRoot(document.getElementById('root'));
  const toolbarControl = (id) => document.querySelector(`.preview-toolbar > [data-toolbar-item="${id}"]`);
  const menu = () => document.querySelector('.preview-toolbar-menu');
  const menuControl = (id) => menu().querySelector(`[data-toolbar-item="${id}"]`);
  // Popup motion runs on timers; let it finish inside act so React sees every update.
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  // Reduced motion finishes a closing popup on a microtask, so clicks run in an async act.
  const click = (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  const openMenu = async () => {
    await click(document.querySelector('.preview-toolbar-more'));
    await settle();
    assert.ok(menu(), 'More opens the popover');
  };
  try {
    await act(() => root.render(React.createElement(ToolbarOverflow, { items, childrenWidthPxMin: 0 }, React.createElement('div', { className: 'crumbs' }))));
    await act(() => root.render(React.createElement(ToolbarOverflow, { items, childrenWidthPxMin: 0 }, React.createElement('div', { className: 'crumbs' }))));
    for (const { id } of items) {
      assert.match(toolbarControl(id).className, /is-overflow/, `${id} overflows`);
    }
    await openMenu();
    for (const { id } of items) {
      const inToolbar = toolbarControl(id);
      const inMenu = menuControl(id);
      assert.ok(inMenu, `${id} is in the popover`);
      assert.equal(inMenu.className, 'preview-toolbar-item', 'The popover wraps a control as the toolbar does');
      assert.equal(inMenu.innerHTML, inToolbar.innerHTML, `${id} keeps its toolbar markup, classes and state`);
    }
    assert.equal(menu().querySelector('.preview-toolbar-menu-item, .preview-toolbar-menu-control') === null, true, 'No restyled menu rows');
    await click(menuControl('sizing').querySelector('button'));
    await settle();
    assert.deepEqual(pressed, ['fit']);
    assert.equal(document.querySelector('.preview-toolbar-more').getAttribute('aria-expanded'), 'true', 'A stay control keeps the popover open');
    await click(menuControl('devices').querySelector('button'));
    assert.deepEqual(pressed, ['fit', 'phone']);
    await settle();
    assert.equal(document.querySelector('.preview-toolbar-more').getAttribute('aria-expanded'), 'false', 'A close control dismisses the popover');
    // 300px holds three 80px controls; reserving 120px for the breadcrumb leaves room for one.
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
    const shown = (id) => !/is-overflow/.test(toolbarControl(id).className);
    const crumbs = React.createElement('div', { className: 'crumbs' });
    await act(() => root.render(React.createElement(ToolbarOverflow, { items: [...items], childrenWidthPxMin: 0 }, crumbs)));
    assert.deepEqual(
      items.map(({ id }) => shown(id)),
      [true, true, true],
      'Without a reserve every control stays',
    );
    await act(() => root.render(React.createElement(ToolbarOverflow, { items: [...items], childrenWidthPxMin: 120 }, crumbs)));
    assert.deepEqual(
      items.map(({ id }) => shown(id)),
      [false, false, true],
      'The breadcrumb keeps its room; the top priority stays',
    );
  } finally {
    await act(() => root.unmount());
    window.close();
  }
});
