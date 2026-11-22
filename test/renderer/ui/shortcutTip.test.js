// Goal: a keyboard shortcut is never printed inside a row; it is told in the app's own tooltip after the pointer (or keyboard
// focus) has rested on the row, and the row keeps `aria-keyshortcuts` so screen readers still hear it. This holds for every
// surface that takes its rows through the shared hook (src/ui/shortcutTip.tsx): the shared Menu, the More menu and the
// project-settings root list. The tooltip waits (no flash on a quick pass), goes away on leave and blur, cannot take a click
// (it is `pointer-events: none` through `.rail-tooltip`, and sits outside the row's own text), and a row without a
// shortcut never gets one. `ariaKeyShortcuts` turns the shown glyphs into the names ARIA expects.
// Method: mount the real components in jsdom; hover is a dispatched mouseover (React derives mouseenter from it), focus is a
// real focus. The rest is driven, not waited for: once the rows are mounted the test takes over `setTimeout`
// (node:test's mock timers) and moves the clock past the shared delay, read through the product's own constant, so a
// loaded runner cannot show or hide the tip late.
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/shortcut-tip');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'shortcut-tip.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as Menu, useMenuTrigger } from './src/ui/Menu';",
      "export { default as MoreMenu } from './src/ui/MoreMenu';",
      "export { default as ProjectSettingsShell } from './src/features/projectSettings/ProjectSettingsShell';",
      "export { ariaKeyShortcuts } from './src/lib/shortcutLabel';",
      "export { TOOLTIP_DELAY_MS } from './src/ui/delayedTooltip';",
    ].join('\n'),
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
const { Menu, useMenuTrigger, MoreMenu, ProjectSettingsShell, ariaKeyShortcuts, TOOLTIP_DELAY_MS } = require(bundle);

const mounted = [];
afterEach(async () => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop();
    await act(async () => root.unmount());
    container.remove();
  }
  dom.window.document.body.innerHTML = '';
});

const tips = () => [...dom.window.document.body.querySelectorAll('.shortcut-tip[role="tooltip"]')];
// Takes over the clock once the surface is mounted (mounting and opening keep real timers), then moves it past the rest.
const driveClock = (context) => context.mock.timers.enable({ apis: ['setTimeout'] });
const rest = (context) => act(async () => context.mock.timers.tick(RESTED_MS));
const hover = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
const leave = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true })));
const RESTED_MS = TOOLTIP_DELAY_MS + 100;

async function mountElement(element) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(element));
  return container;
}

function MenuHarness() {
  const trigger = useMenuTrigger();
  const entries = [
    { kind: 'item', id: 'copy', label: 'Copy', shortcut: '⌘C', onSelect: () => undefined },
    { kind: 'item', id: 'first', label: 'First', numberKey: 1, onSelect: () => undefined },
    { kind: 'item', id: 'plain', label: 'Plain', onSelect: () => undefined },
  ];
  return React.createElement(
    React.Fragment,
    {},
    React.createElement('button', { id: 'opener', ref: trigger.ref, onClick: trigger.toggle }, 'Open'),
    React.createElement(Menu, { open: trigger.open, anchor: trigger.anchor, onClose: trigger.close, label: 'Edit', entries }),
  );
}

async function openMenu() {
  await mountElement(React.createElement(MenuHarness));
  await act(async () => dom.window.document.getElementById('opener').click());
  await act(async () => new Promise((resolve) => setImmediate(resolve)));
  const rows = [...dom.window.document.querySelectorAll('.menu-row')];
  return { copy: rows[0], first: rows[1], plain: rows[2] };
}

test('ariaKeyShortcuts names modifiers the way ARIA does and leaves plain keys alone', () => {
  assert.equal(ariaKeyShortcuts('⌥E'), 'Alt+E');
  assert.equal(ariaKeyShortcuts('⌘⇧D'), 'Meta+Shift+D');
  assert.equal(ariaKeyShortcuts('⌃K'), 'Control+K');
  assert.equal(ariaKeyShortcuts('Ctrl+Shift+C'), 'Control+Shift+C');
  assert.equal(ariaKeyShortcuts('⌫'), 'Backspace');
  assert.equal(ariaKeyShortcuts('Del'), 'Delete');
  assert.equal(ariaKeyShortcuts('1'), '1');
  assert.equal(ariaKeyShortcuts('@'), '@');
});

test('a menu row prints no shortcut; the tip names it after the rest and goes on leave', async (context) => {
  const { copy } = await openMenu();
  driveClock(context);
  assert.equal(copy.textContent, 'Copy', 'the key is not in the row text');
  assert.equal(copy.getAttribute('aria-keyshortcuts'), 'Meta+C', 'screen readers still hear it');
  await hover(copy);
  assert.equal(tips().length, 0, 'not before the rest');
  await rest(context);
  assert.equal(tips().length, 1, 'shown after the rest');
  assert.equal(tips()[0].textContent, 'Copy (⌘C)');
  assert.equal(copy.textContent, 'Copy', 'the row text is unchanged while the tip shows');
  await leave(copy);
  assert.equal(tips().length, 0, 'gone on leave');
});

test('a quick pass over a row shows nothing', async (context) => {
  const { copy } = await openMenu();
  driveClock(context);
  await hover(copy);
  await leave(copy);
  await rest(context);
  assert.equal(tips().length, 0);
});

test('a digit that chooses a row is told the same way; a row with no key gets no tip', async (context) => {
  const { first, plain } = await openMenu();
  driveClock(context);
  assert.equal(first.textContent, 'First');
  assert.equal(first.getAttribute('aria-keyshortcuts'), '1');
  await hover(first);
  await rest(context);
  assert.equal(tips()[0].textContent, 'First (1)');
  await leave(first);
  assert.equal(plain.hasAttribute('aria-keyshortcuts'), false);
  await hover(plain);
  await rest(context);
  assert.equal(tips().length, 0, 'no shortcut, no tip');
});

test('keyboard focus shows the tip after the rest and blur hides it', async (context) => {
  const { copy } = await openMenu();
  driveClock(context);
  await act(async () => copy.blur());
  await act(async () => copy.focus());
  await rest(context);
  assert.equal(tips().length, 1);
  await act(async () => copy.blur());
  assert.equal(tips().length, 0);
});

test('the tip is the app tooltip, outside the menu, and cannot take a click', async (context) => {
  const { copy } = await openMenu();
  driveClock(context);
  await hover(copy);
  await rest(context);
  const [tip] = tips();
  assert.ok(tip.classList.contains('rail-tooltip'), 'it is the app tooltip, which has pointer-events none, so it cannot block a click');
  assert.equal(tip.getAttribute('aria-hidden'), 'true', 'the row already carries the shortcut for screen readers');
  assert.equal(tip.parentElement, dom.window.document.body, 'portalled out of the menu so its scroll and clip never cut it');
});

test('the More menu row prints no shortcut and tells it in the tip', async (context) => {
  await mountElement(
    React.createElement(MoreMenu, {
      title: 'Options',
      items: [{ label: 'Settings', shortcut: '⌥S', onSelect: () => undefined }, { label: 'Other' }],
    }),
  );
  await act(async () => dom.window.document.querySelector('.more-menu-button').click());
  await act(async () => new Promise((resolve) => setImmediate(resolve)));
  const row = [...dom.window.document.querySelectorAll('.more-menu-item')].find((element) => element.textContent === 'Settings');
  assert.ok(row !== undefined, 'the row text is the label alone');
  assert.equal(dom.window.document.querySelector('.more-menu-shortcut') === null, true);
  assert.equal(row.getAttribute('aria-keyshortcuts'), 'Alt+S');
  driveClock(context);
  await hover(row);
  await rest(context);
  assert.equal(tips()[0].textContent, 'Settings (⌥S)');
});

test('the settings root list prints no chord and tells it in the tip', async (context) => {
  await mountElement(
    React.createElement(ProjectSettingsShell, {
      projectKey: 'shortcut-tip-test',
      views: ['secrets', 'mcp'],
      renderView: () => undefined,
      refreshable: false,
      shortcuts: { secrets: '⌥E', mcp: '⌥M' },
    }),
  );
  const rows = [...dom.window.document.querySelectorAll('.settings-link')];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.doesNotMatch(row.textContent, /⌥/, 'no chord inline');
  }
  assert.equal(rows[0].getAttribute('aria-keyshortcuts'), 'Alt+E');
  driveClock(context);
  await hover(rows[0]);
  assert.equal(tips().length, 0);
  await rest(context);
  assert.equal(tips().length, 1);
  assert.match(tips()[0].textContent, /\(⌥E\)$/);
});
