// Goal: the info mark on a menu row (the "Max" effort row's (i)) explains the row in the app's own tip:
// it appears after the usual rest when the pointer is on the mark and at once on keyboard focus, is
// portalled to the body (so no scroll container clips it), carries the tooltip role and the row's text,
// sits at the side of the menu (right when there is room, left when not) level with the mark, draws above
// the menu layers, goes away on leave and blur, and the native `title` (which never showed) is gone.
// Method: mount the real Menu in jsdom; getBoundingClientRect is mocked because jsdom has no layout;
// pointer events are dispatched on the mark, and :focus-visible is stubbed for the keyboard case.
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/menu-info-tip');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'menu.cjs');
buildSync({
  stdin: {
    contents: "export { default as Menu, useMenuTrigger } from './src/ui/Menu'; export { placeInfoTip } from './src/ui/menuModel';",
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
});

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { Menu, useMenuTrigger, placeInfoTip } = require(bundle);
const mounted = [];
afterEach(async () => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop();
    await act(async () => root.unmount());
    container.remove();
  }
  dom.window.document.body.innerHTML = '';
});

const TEXT = 'Maximum reasoning: the most thorough and slowest setting.';

async function mountMenu() {
  function Harness() {
    const trigger = useMenuTrigger();
    const entries = [
      { kind: 'item', id: 'high', label: 'High', checked: false, onSelect: () => undefined },
      { kind: 'item', id: 'max', label: 'Max', checked: false, info: TEXT, onSelect: () => undefined },
    ];
    return React.createElement(
      React.Fragment,
      {},
      React.createElement('button', { id: 'opener', ref: trigger.ref, onClick: trigger.toggle }, 'Open'),
      React.createElement(Menu, { open: trigger.open, anchor: trigger.anchor, onClose: trigger.close, label: 'Effort', entries }),
    );
  }
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => dom.window.document.getElementById('opener').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const surface = dom.window.document.querySelector('.menu-surface');
  const mark = dom.window.document.querySelector('.menu-info');
  // Layout is jsdom-less: the menu is 100 to 300 wide; the mark is a 12px square at y 200.
  surface.getBoundingClientRect = () => ({ left: 100, right: 300, top: 150, bottom: 260, width: 200, height: 110 });
  mark.getBoundingClientRect = () => ({ left: 260, right: 272, top: 194, bottom: 206, width: 12, height: 12 });
  return { surface, mark, row: mark.closest('button') };
}

const tips = () => [...dom.window.document.body.querySelectorAll('[role="tooltip"]')];
const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

test('hovering the mark shows the tip after the rest, portalled to the body, beside the menu', async () => {
  dom.window.innerWidth = 1000;
  const { mark, surface } = await mountMenu();
  assert.equal(mark.hasAttribute('title'), false, 'no native title: the OS tip never showed');
  await act(async () => mark.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
  assert.equal(tips().length, 0, 'not before the rest');
  await wait(600);
  const [tip] = tips();
  assert.ok(tip, 'the tip is shown');
  assert.equal(tip.textContent, TEXT);
  assert.equal(tip.parentElement, dom.window.document.body, 'portalled to the body');
  assert.equal(surface.contains(tip), false, 'outside the menu, so its overflow cannot clip it');
  assert.ok(tip.classList.contains('menu-info-tip'));
  assert.equal(tip.dataset.side, 'right');
  assert.equal(tip.style.left, '310px', 'ten pixels right of the menu edge');
  assert.equal(tip.style.top, '200px', 'level with the mark');
  await act(async () => mark.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true })));
  assert.equal(tips().length, 0, 'gone on leave');
});

test('leaving before the rest shows nothing', async () => {
  const { mark } = await mountMenu();
  await act(async () => mark.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
  await act(async () => mark.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true })));
  await wait(600);
  assert.equal(tips().length, 0);
});

test('keyboard focus on the row shows the tip at once, and blur hides it', async () => {
  dom.window.innerWidth = 1000;
  const { row } = await mountMenu();
  const original = dom.window.Element.prototype.matches;
  dom.window.Element.prototype.matches = function matches(selector) {
    return selector === ':focus-visible' ? true : original.call(this, selector);
  };
  try {
    await act(async () => row.focus());
    assert.equal(tips().length, 1, 'no wait for the keyboard');
    assert.equal(tips()[0].textContent, TEXT);
    await act(async () => row.blur());
    assert.equal(tips().length, 0);
  } finally {
    dom.window.Element.prototype.matches = original;
  }
});

test('the tip flips to the left of the menu when the window has no room on the right', async () => {
  dom.window.innerWidth = 400;
  const { mark } = await mountMenu();
  await act(async () => mark.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
  await wait(600);
  const [tip] = tips();
  assert.equal(tip.dataset.side, 'left');
  assert.ok(tip.classList.contains('is-left'));
  assert.equal(tip.style.left, '90px');
});

test('placeInfoTip: the side, the point, and the preconditions', () => {
  assert.deepEqual(placeInfoTip({ left: 10, right: 110 }, { top: 40, height: 10 }, 800), { side: 'right', left: 120, top: 45 });
  assert.deepEqual(placeInfoTip({ left: 500, right: 700 }, { top: 40, height: 10 }, 800), { side: 'left', left: 490, top: 45 });
  assert.throws(() => placeInfoTip({ left: 10, right: 5 }, { top: 0, height: 0 }, 800), /a menu has a width/);
  assert.throws(() => placeInfoTip({ left: 0, right: 5 }, { top: 0, height: 0 }, 0), /a window has a width/);
});
