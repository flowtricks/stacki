// Goal: every row of the Components panel, in every layout (flat, grouped under folder headers, search results, rows
// with zero instances), has a "…" button; it opens a menu with Show instances and, when the project has roles, a
// Roles submenu that lists every role, admin included, with a switch for whether that role may add the component.
// Flipping a switch asks for the right component-level rule (off writes a hide, on over a folder's hide writes a show
// override); a component hidden by a folder shows off with "hidden by folder …"; a folder header's submenu is
// three-state in words ("1 of 2 visible") and flips the whole folder; and the switches follow the roles the panel is
// given, so a change saved from Settings → Roles reaches an open menu. A viewer who cannot edit roles sees them disabled.
// Method: bundle the real panel and the pure submenu builder, mount in jsdom with generated components and a stub
// that records each requested change, open the menu with a click and the submenu with the Right key, and read rows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'component-role-menu.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as PalettePanel } from './src/features/palette/PalettePanel';",
      "export { setActualRole } from './src/lib/currentRole';",
      "export { useComponentRoleRules } from './src/app/roles/componentRoleRules';",
      "export { parseProjectRoles, ADMIN_VIEW } from './shared/properties/projectRoles';",
    ].join('\n'),
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
});
const lib = require(output);

const component = (name, folder, instances) => ({
  name,
  folder,
  path: `/p/src/components/${folder ? folder + '/' : ''}${name}.astro`,
  file: `src/components/${folder ? folder + '/' : ''}${name}.astro`,
  ...(instances === undefined ? {} : { instances }),
});
const FLAT = [component('Accordion', '', 4), component('Avatar', '', 0), component('Border', '', undefined)];
const GROUPED = [component('Modal', 'interactive', 2), component('Tabs', 'interactive', 1), component('Button', 'ui', 0)];

const rolesFile = (rules) =>
  lib.parseProjectRoles({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'client', componentRules: rules },
      { id: 'writer', name: 'Writer' },
    ],
  });

// One document for the whole file: React reads the global window when it loads, so a fresh one per test would leave it on the first.
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.localStorage = dom.window.localStorage;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

async function mount(components, rules, overrides = {}) {
  document.body.innerHTML = '<div id="root"></div>';
  global.IS_REACT_ACT_ENVIRONMENT = true;

  dom.window.cancelAnimationFrame = (handle) => clearTimeout(handle);
  global.requestAnimationFrame = dom.window.requestAnimationFrame;
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  lib.setActualRole(lib.ADMIN_VIEW);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const changes = [];
  const props = (roleRules) => ({
    components,
    trailingSlash: 'ignore',
    devUrl: 'http://localhost:4321',
    createFrom: { kind: 'unavailable', reason: '' },
    onInsert() {},
    onCreateComponent() {},
    onUsage: async () => ({ files: [] }),
    roleRules,
  });
  const rulesFor = (file) => ({ roles: file, editable: true, setVisibility: (...args) => changes.push(args), ...overrides });
  await React.act(async () => root.render(React.createElement(lib.PalettePanel, props(rules === undefined ? undefined : rulesFor(rolesFile(rules))))));
  const act = (run) => React.act(async () => run());
  return {
    changes,
    act,
    rerender: (next) => act(() => root.render(React.createElement(lib.PalettePanel, props(rulesFor(rolesFile(next)))))),
    buttons: () => [...document.querySelectorAll('.palette-row-menu')],
    async open(button) {
      await act(() => button.click());
    },
    async openRoles() {
      const row = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.startsWith('Roles'));
      assert.ok(row, 'the menu has a Roles row');
      await act(() => row.focus());
      await act(() => row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
      return [...document.querySelectorAll('[role="menuitemcheckbox"]')];
    },
    async unmount() {
      await React.act(async () => root.unmount());
    },
  };
}

test('a "…" button is on every row in every layout, folder headers included', async () => {
  const flat = await mount(FLAT, undefined);
  assert.equal(flat.buttons().length, 3, 'flat list, with or without instances and with no roles file');
  await flat.unmount();
  const grouped = await mount(GROUPED, []);
  assert.equal(document.querySelectorAll('.palette-item').length, 3);
  assert.equal(document.querySelectorAll('.palette-folder').length, 2);
  assert.equal(grouped.buttons().length, 5, 'one per component and one per folder header');
  assert.equal(document.querySelectorAll('.palette-folder .palette-row-menu').length, 2);
  const { Simulate } = require('react-dom/test-utils');
  await grouped.act(() => {
    const input = document.querySelector('input');
    input.value = 'tabs';
    Simulate.change(input);
  });
  assert.equal(grouped.buttons().length, 2, 'search results keep it: the matching row and its folder');
  await grouped.unmount();
});

test('the menu lists Show instances and a Roles submenu with every role, admin included', async () => {
  const view = await mount(FLAT, []);
  await view.open(view.buttons()[0]);
  assert.ok([...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === 'Show instances'));
  const toggles = await view.openRoles();
  assert.deepEqual(
    toggles.map((item) => item.textContent),
    ['Admin', 'Client', 'Writer'],
  );
  assert.ok(
    toggles.every((item) => item.getAttribute('aria-checked') === 'true'),
    'every component starts enabled for every role',
  );
  await view.unmount();
});

test('flipping a role switch asks for a component-level rule; a folder-hidden component shows its reason and gets a show override', async () => {
  const view = await mount(GROUPED, [{ kind: 'folder', path: 'src/components/interactive' }]);
  const modal = view.buttons().find((button) => button.getAttribute('aria-label') === 'Options for Modal');
  await view.open(modal);
  const toggles = await view.openRoles();
  const client = toggles.find((item) => item.textContent.startsWith('Client'));
  assert.equal(client.getAttribute('aria-checked'), 'false');
  assert.match(client.textContent, /hidden by folder src\/components\/interactive/);
  await view.act(() => client.click());
  assert.deepEqual(view.changes.at(-1), ['client', { kind: 'component', path: 'src/components/interactive/Modal.astro' }, 'visible']);
  const admin = toggles.find((item) => item.textContent.startsWith('Admin'));
  assert.equal(admin.getAttribute('aria-checked'), 'true');
  await view.act(() => admin.click());
  assert.deepEqual(view.changes.at(-1), ['admin', { kind: 'component', path: 'src/components/interactive/Modal.astro' }, 'hidden']);
  await view.unmount();
});

test('a folder header flips the whole folder and says when only some of it is visible', async () => {
  const view = await mount(GROUPED, [{ kind: 'component', path: 'src/components/interactive/Tabs.astro' }]);
  const folder = document.querySelector('.palette-folder .palette-row-menu');
  await view.open(folder);
  const toggles = await view.openRoles();
  const client = toggles.find((item) => item.textContent.startsWith('Client'));
  assert.equal(client.getAttribute('aria-checked'), 'false');
  assert.match(client.textContent, /1 of 2 visible/);
  await view.act(() => client.click());
  assert.deepEqual(view.changes.at(-1), ['client', { kind: 'folder', path: 'src/components/interactive' }, 'visible'], 'mixed turns the whole folder on');
  const writer = toggles.find((item) => item.textContent.startsWith('Writer'));
  await view.act(() => writer.click());
  assert.deepEqual(view.changes.at(-1), ['writer', { kind: 'folder', path: 'src/components/interactive' }, 'hidden']);
  await view.unmount();
});

test('the switches follow the roles the panel is given, and are disabled for a viewer who cannot edit roles', async () => {
  const view = await mount(FLAT, []);
  await view.open(view.buttons()[0]);
  let toggles = await view.openRoles();
  assert.equal(toggles.find((item) => item.textContent === 'Client').getAttribute('aria-checked'), 'true');
  await view.rerender([{ kind: 'component', path: 'src/components/Accordion.astro' }]);
  toggles = [...document.querySelectorAll('[role="menuitemcheckbox"]')];
  assert.equal(toggles.find((item) => item.textContent === 'Client').getAttribute('aria-checked'), 'false', 'a change saved elsewhere shows in the open menu');
  await view.unmount();
  const readOnly = await mount(FLAT, [], { editable: false });
  await readOnly.open(readOnly.buttons()[0]);
  const locked = await readOnly.openRoles();
  assert.ok(locked.every((item) => item.getAttribute('aria-disabled') === 'true' || item.disabled));
  await readOnly.unmount();
});

test('the hover card stays away while a row menu is open, and the menu layer is above the card and outside the panel', async () => {
  const { Simulate } = require('react-dom/test-utils');
  const view = await mount(FLAT, []);
  const item = () => document.querySelector('.palette-item');
  await view.act(() => Simulate.mouseEnter(item()));
  assert.ok(document.querySelector('.comp-preview'), 'hovering a row shows its card');
  await view.act(() => Simulate.mouseLeave(document.querySelector('.panel-body')));
  assert.equal(document.querySelector('.comp-preview') === null, true);
  await view.open(view.buttons()[0]);
  await view.act(() => Simulate.mouseEnter(item()));
  assert.equal(document.querySelector('.comp-preview') === null, true, 'no card while the menu is open');
  const menu = document.querySelector('[role="menu"]');
  assert.ok(menu, 'the menu is open');
  assert.equal(menu.closest('.panel-section') === null, true, 'the menu is portalled out of the panel, so its overflow cannot clip it');
  await view.open(view.buttons()[0]);
  await view.act(() => Simulate.mouseEnter(item()));
  assert.ok(document.querySelector('.comp-preview'), 'the card returns once the menu is closed');
  await view.unmount();

  // Jsdom computes no layout from the stylesheets, so the layer order is read from them: the open row menu's
  // surface (the submenu's too) is above the card.
  const card = /\.comp-preview \{[^}]*z-index: (\d+)/.exec(fs.readFileSync(repoPath('src/app/styles.css'), 'utf8'));
  const menuCss = fs.readFileSync(repoPath('src/features/palette/roleMenu.css'), 'utf8');
  const layer = /--layer-palette-menu: (\d+)/.exec(menuCss);
  assert.ok(card && layer, 'both layers are declared');
  assert.ok(Number(layer[1]) > Number(card[1]), 'the row menu layer is above the hover card');
  assert.match(menuCss, /:root:has\(\.palette-row-menu\.is-open\) \.menu-surface \{\s*z-index: var\(--layer-palette-menu\)/);
});

test('the real panel wired as the app wires it offers Show instances and Roles in a project with no roles file, and the first flip creates the file', async () => {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const writes = [];
  window.avb = {
    projectMetadata: async () => ({ ok: true, value: {} }),
    writeProjectMetadata: async (input) => {
      writes.push(input.write);
      return { ok: true, value: { source: input.write.source } };
    },
    rolesIdentity: async () => ({ login: 'owner' }),
    onFsChanged: () => () => undefined,
  };
  lib.setActualRole(lib.ADMIN_VIEW);
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root'));
  function Wired() {
    const roleRules = lib.useComponentRoleRules('/project', (failure) => {
      throw failure;
    });
    return React.createElement(lib.PalettePanel, {
      components: GROUPED,
      trailingSlash: 'ignore',
      createFrom: { kind: 'unavailable', reason: '' },
      onInsert() {},
      onCreateComponent() {},
      roleRules,
    });
  }
  await React.act(async () => root.render(React.createElement(Wired)));
  const button = document.querySelector('.palette-item .palette-row-menu');
  assert.ok(button, 'the row has its button');
  await React.act(async () => button.click());
  assert.deepEqual(
    [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ['Show instances', 'Roles'],
    'the one menu of this row holds every item, with no roles file too',
  );
  const row = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.startsWith('Roles'));
  await React.act(async () => row.focus());
  await React.act(async () => row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
  const toggles = [...document.querySelectorAll('[role="menuitemcheckbox"]')];
  assert.deepEqual(
    toggles.map((item) => item.textContent),
    ['Admin', 'Client'],
  );
  await React.act(async () => toggles[1].click());
  await React.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(writes.length, 1, 'the first flip creates the roles file');
  const file = JSON.parse(writes[0].source);
  assert.deepEqual(file.roles[0].members, ['owner'], 'the signed-in account is its first admin');
  assert.deepEqual(file.roles[1].componentRules, [{ kind: 'component', path: 'src/components/interactive/Modal.astro' }]);
  await React.act(async () => root.unmount());
});
