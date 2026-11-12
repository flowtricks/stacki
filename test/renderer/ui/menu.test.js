// Goal: the shared Menu behaves the way its rows promise: arrows move focus between real
// buttons, a digit or letter chooses its row, Enter chooses, the check mark ends the chosen
// row, a submenu opens on Right or a click and closes on Left or Escape without closing the
// menu that owns it, a toggle flips and leaves the menu open, a choice closes every level,
// and a disabled row cannot be chosen.
// Method: the real component is bundled and mounted with React in jsdom (the popup's
// native-dialog and reduced-motion hooks come from test/helpers/popupDom.js), then driven
// with DOM keyboard and mouse events. jsdom has no layout, so placement is covered by the
// pure tests in menuModel.test.js and by the Electron render probe, not here.
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/menu');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'menu.cjs');
buildSync({
  stdin: { contents: "export { default as Menu, useMenuTrigger } from './src/ui/Menu';", resolveDir: repoPath('.'), loader: 'ts' },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
});

// One document for the whole file: React reads the global window when it loads, so a fresh
// document per test would leave it pointing at the first. Each test mounts into its own
// container and unmounts it afterwards.
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
const { Menu, useMenuTrigger } = require(bundle);
const mounted = [];
afterEach(async () => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop();
    await act(async () => root.unmount());
    container.remove();
  }
  dom.window.document.body.innerHTML = '';
});

async function mount(buildEntries) {
  const log = [];
  function Harness() {
    const trigger = useMenuTrigger();
    return React.createElement(
      React.Fragment,
      {},
      React.createElement('button', { id: 'opener', ref: trigger.ref, onClick: trigger.toggle }, 'Open'),
      React.createElement(Menu, { open: trigger.open, anchor: trigger.anchor, onClose: trigger.close, label: 'Test menu', entries: buildEntries(log) }),
    );
  }
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(React.createElement(Harness)));
  const body = dom.window.document.body;
  const all = (selector) => [...body.querySelectorAll(selector)];
  const key = (target, init) => act(async () => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
  const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const open = async () => {
    await act(async () => dom.window.document.getElementById('opener').click());
    await settle();
  };
  const focused = () => dom.window.document.activeElement;
  const names = () => all('[role="menu"]').map((menu) => menu.getAttribute('aria-label'));
  return { dom, log, all, key, settle, open, focused, names, act, body };
}

const model = (log) => [
  { kind: 'heading', id: 'h', label: 'Model' },
  { kind: 'item', id: 'opus', label: 'Opus', description: 'Most capable', numberKey: 1, checked: false, onSelect: () => log.push('opus') },
  { kind: 'item', id: 'sonnet', label: 'Sonnet', numberKey: 2, checked: true, pill: 'Recommended', onSelect: () => log.push('sonnet') },
  { kind: 'item', id: 'haiku', label: 'Haiku', numberKey: 3, checked: false, disabled: true, onSelect: () => log.push('haiku') },
  { kind: 'divider', id: 'd' },
  {
    kind: 'submenu',
    id: 'effort',
    label: 'Effort',
    value: 'Medium',
    entries: [
      { kind: 'note', id: 'n', text: 'Higher effort is slower.' },
      { kind: 'item', id: 'low', label: 'Low', numberKey: 1, checked: false, onSelect: () => log.push('low') },
      { kind: 'item', id: 'medium', label: 'Medium', numberKey: 2, checked: true, onSelect: () => log.push('medium') },
      { kind: 'toggle', id: 'ultra', label: 'Ultracode', on: false, onChange: (next) => log.push(`ultra:${next}`) },
    ],
  },
];

test('opening focuses the checked row; rows are real buttons with names, descriptions and checks', async () => {
  const view = await mount(model);
  await view.open();
  assert.deepEqual(view.names(), ['Test menu']);
  assert.equal(view.focused().textContent.startsWith('Sonnet'), true);
  const rows = view.all('[role="menuitemradio"]');
  assert.equal(rows.length, 3);
  assert.equal(rows[1].getAttribute('aria-checked'), 'true');
  assert.equal(rows[0].getAttribute('aria-checked'), 'false');
  assert.equal(rows[1].querySelectorAll('.menu-check svg').length, 1, 'the check is drawn on the chosen row only');
  assert.equal(rows[0].querySelectorAll('.menu-check svg').length, 0);
  assert.match(rows[0].textContent, /Most capable/);
  assert.match(rows[1].textContent, /Recommended/);
  assert.equal(rows[0].querySelector('.menu-key').textContent, '1');
  assert.equal(rows[2].disabled, true);
  const effort = view.all('[aria-haspopup="menu"]');
  assert.equal(effort.length, 1);
  assert.equal(effort[0].getAttribute('aria-expanded'), 'false');
  assert.match(effort[0].textContent, /Medium/);
});

test('arrows move focus, skipping the disabled row, and wrap', async () => {
  const view = await mount(model);
  await view.open();
  await view.key(view.focused(), { key: 'ArrowDown' });
  assert.match(view.focused().textContent, /^Effort/);
  await view.key(view.focused(), { key: 'ArrowDown' });
  assert.match(view.focused().textContent, /^Opus/);
  await view.key(view.focused(), { key: 'ArrowUp' });
  assert.match(view.focused().textContent, /^Effort/);
  await view.key(view.focused(), { key: 'Home' });
  assert.match(view.focused().textContent, /^Opus/);
  await view.key(view.focused(), { key: 'End' });
  assert.match(view.focused().textContent, /^Effort/);
});

test('a digit chooses that row and closes the menu; a disabled row does nothing', async () => {
  const view = await mount(model);
  await view.open();
  await view.key(view.focused(), { key: '3' });
  assert.deepEqual(view.log, []);
  assert.equal(view.names().length, 1, 'still open');
  await view.key(view.focused(), { key: '1' });
  assert.deepEqual(view.log, ['opus']);
  await view.settle(10);
  assert.equal(view.names().length, 0, 'closed after the choice');
});

test('Enter chooses the focused row', async () => {
  const view = await mount(model);
  await view.open();
  await view.key(view.focused(), { key: 'Enter' });
  assert.deepEqual(view.log, ['sonnet']);
});

test('Right opens the submenu and focuses its checked row; Left closes just the submenu', async () => {
  const view = await mount(model);
  await view.open();
  await view.key(view.focused(), { key: 'ArrowDown' });
  await view.key(view.focused(), { key: 'ArrowRight' });
  await view.settle();
  assert.equal(view.names().length, 2, 'the submenu is a second menu');
  assert.match(view.focused().textContent, /^Medium/, 'focus is on the checked row inside');
  assert.equal(view.all('[aria-haspopup="menu"]')[0].getAttribute('aria-expanded'), 'true');
  await view.key(view.focused(), { key: 'ArrowLeft' });
  await view.settle();
  assert.equal(view.names().length, 1);
  assert.match(view.focused().textContent, /^Effort/, 'focus returns to the row that opened it');
});

test('Escape closes the submenu first, then the menu', async () => {
  const view = await mount(model);
  await view.open();
  await view.key(view.focused(), { key: 'ArrowDown' });
  await view.key(view.focused(), { key: 'Enter' });
  await view.settle();
  assert.equal(view.names().length, 2);
  await view.act(async () =>
    view.dom.window.document.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  );
  await view.settle(10);
  assert.equal(view.names().length, 1, 'only the submenu closed');
  await view.act(async () =>
    view.dom.window.document.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  );
  await view.settle(10);
  assert.equal(view.names().length, 0);
});

test('choosing inside a submenu closes every level', async () => {
  const view = await mount(model);
  await view.open();
  await view.key(view.focused(), { key: 'ArrowDown' });
  await view.key(view.focused(), { key: 'ArrowRight' });
  await view.settle();
  await view.key(view.focused(), { key: '1' });
  assert.deepEqual(view.log, ['low']);
  await view.settle(10);
  assert.equal(view.names().length, 0);
});

test('a toggle flips on Space and leaves the menu open', async () => {
  const view = await mount(model);
  await view.open();
  await view.key(view.focused(), { key: 'ArrowDown' });
  await view.key(view.focused(), { key: 'ArrowRight' });
  await view.settle();
  await view.key(view.focused(), { key: 'End' });
  assert.match(view.focused().textContent, /^Ultracode/);
  assert.equal(view.focused().getAttribute('role'), 'menuitemcheckbox');
  await view.key(view.focused(), { key: ' ' });
  assert.deepEqual(view.log, ['ultra:true']);
  assert.equal(view.names().length, 2, 'still open');
});

test('clicking a submenu row opens it and clicking an item chooses it', async () => {
  const view = await mount(model);
  await view.open();
  await view.act(async () => view.all('[aria-haspopup="menu"]')[0].click());
  await view.settle();
  assert.equal(view.names().length, 2);
  await view.act(async () => view.all('[role="menuitemradio"]')[0].click());
  assert.deepEqual(view.log, ['opus']);
});

test('hovering a submenu row opens it after a short delay and hovering another row closes it', async () => {
  const view = await mount(model);
  await view.open();
  const hover = (element) =>
    view.act(
      async () =>
        element.dispatchEvent(new view.dom.window.MouseEvent('mouseover', { bubbles: true })) &&
        element.dispatchEvent(new view.dom.window.MouseEvent('mouseenter', { bubbles: false })),
    );
  await hover(view.all('[aria-haspopup="menu"]')[0]);
  assert.equal(view.names().length, 1, 'not instantly');
  await view.settle(200);
  assert.equal(view.names().length, 2);
  assert.match(view.focused().textContent, /^Effort/, 'focus stays on the parent row for a hover');
  await hover(view.all('[role="menuitemradio"]')[0]);
  await view.settle(260);
  assert.equal(view.names().length, 1);
});

test('Tab closes the menu instead of moving focus into the page', async () => {
  const view = await mount(model);
  await view.open();
  await view.key(view.focused(), { key: 'Tab' });
  await view.settle(10);
  assert.equal(view.names().length, 0);
});

test('a duplicate id is refused when the menu draws', async () => {
  const failing = () =>
    mount((log) => [
      { kind: 'item', id: 'x', label: 'a', onSelect: () => log.push(1) },
      { kind: 'item', id: 'x', label: 'b', onSelect: () => log.push(2) },
    ]);
  await assert.rejects(failing, /duplicate entry id x/);
});
