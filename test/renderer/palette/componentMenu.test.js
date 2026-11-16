// Goal: the "…" menu on a Components panel row offers Edit settings, Show instances, (Roles), Duplicate and Delete in that
// order for a component, and Duplicate and Delete (after Roles) on a folder header; Delete is disabled, with the number of
// places as its reason, while anything uses what it would remove; choosing a row hands the host the right target (component or
// folder, its project-relative path, how many components it holds); a host with no management (Studio) and a role without the
// rights get none of these rows; the folder rows count every component under the folder.
// Method: bundle the real PalettePanel, mount it in jsdom with generated components and a stub management that records calls,
// open the real "…" button with a click, read the menu rows, and choose rows with clicks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'component-menu.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as PalettePanel } from './src/features/palette/PalettePanel';",
      "export { setActualRole } from './src/lib/currentRole';",
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

async function mount(components, { management = true, role = lib.ADMIN_VIEW } = {}) {
  document.body.innerHTML = '<div id="root"></div>';
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.cancelAnimationFrame = (handle) => clearTimeout(handle);
  global.requestAnimationFrame = dom.window.requestAnimationFrame;
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  lib.setActualRole(role);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  const stub = {
    editSettings: (item) => calls.push(['settings', item.name]),
    duplicate: (item) => calls.push(['duplicate', item]),
    remove: (item) => calls.push(['remove', item]),
  };
  await React.act(async () =>
    root.render(
      React.createElement(lib.PalettePanel, {
        components,
        trailingSlash: 'ignore',
        devUrl: 'http://localhost:4321',
        createFrom: { kind: 'unavailable', reason: '' },
        onInsert() {},
        onCreateComponent() {},
        onUsage: async () => ({ files: [] }),
        ...(management ? { management: stub } : {}),
      }),
    ),
  );
  const act = (run) => React.act(async () => run());
  return {
    calls,
    act,
    buttons: () => [...document.querySelectorAll('.palette-row-menu')],
    rows: () => [...document.querySelectorAll('[role="menuitem"]')].map((row) => ({ label: row.textContent.replace(/\s+$/, ''), disabled: row.disabled, row })),
    async open(button) {
      await act(() => button.click());
    },
    async unmount() {
      await React.act(async () => root.unmount());
    },
  };
}

test('a component row menu lists Edit settings, Show instances, Duplicate, Delete, in that order', async () => {
  const view = await mount([component('Avatar', '', 0)]);
  await view.open(view.buttons()[0]);
  assert.deepEqual(
    view.rows().map((row) => row.label),
    ['Edit settings', 'Show instances', 'Duplicate', 'Delete'],
  );
  assert.equal(view.rows().find((row) => row.label === 'Delete').disabled, false, 'an unused component can be deleted');
  await view.unmount();
});

test('choosing Edit settings, Duplicate and Delete tells the host which component', async () => {
  const view = await mount([component('Avatar', 'ui', 0)]);
  for (const label of ['Edit settings', 'Duplicate', 'Delete']) {
    await view.open(view.buttons().at(-1));
    await view.act(() =>
      view
        .rows()
        .find((row) => row.label === label)
        .row.click(),
    );
  }
  assert.deepEqual(view.calls[0], ['settings', 'Avatar']);
  assert.deepEqual(view.calls[1], ['duplicate', { kind: 'component', path: 'src/components/ui/Avatar.astro', name: 'Avatar', files: 1 }]);
  assert.deepEqual(view.calls[2], ['remove', { kind: 'component', path: 'src/components/ui/Avatar.astro', name: 'Avatar', files: 1 }]);
  await view.unmount();
});

test('Delete is disabled while the component is used, and choosing it does nothing', async () => {
  const view = await mount([component('Arrow', '', 13), component('Checking', '', undefined)]);
  await view.open(view.buttons()[0]);
  const used = view.rows().find((row) => row.label.startsWith('Delete'));
  assert.equal(used.disabled, true);
  assert.ok(used.row.querySelector('.menu-info'), 'the reason is on the row as an info mark');
  await view.act(() => used.row.click());
  assert.deepEqual(view.calls, []);
  await view.unmount();
});

test('a folder header menu duplicates and deletes the folder, counting every component under it', async () => {
  const view = await mount([component('Tabs', 'ui', 0), component('Tab', 'ui', 0), component('Card', 'cards', 2)]);
  const headers = [...document.querySelectorAll('.palette-folder .palette-row-menu')];
  assert.equal(headers.length, 2);
  const cards = headers.find((button) => button.getAttribute('aria-label').includes('cards'));
  await view.open(cards);
  assert.deepEqual(
    view.rows().map((row) => [row.label.replace(/Used in.*/, ''), row.disabled]),
    [
      ['Duplicate', false],
      ['Delete', true],
    ],
  );
  await view.act(() => document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const ui = [...document.querySelectorAll('.palette-folder .palette-row-menu')].find((button) => button.getAttribute('aria-label').includes('ui'));
  await view.open(ui);
  await view.act(() =>
    view
      .rows()
      .find((row) => row.label === 'Duplicate')
      .row.click(),
  );
  assert.deepEqual(view.calls, [['duplicate', { kind: 'folder', path: 'src/components/ui', name: 'ui', files: 2 }]]);
  await view.unmount();
});

test('without a host that can do it, or a role that may, the rows are left out', async () => {
  const studio = await mount([component('Avatar', '', 0)], { management: false });
  await studio.open(studio.buttons()[0]);
  assert.deepEqual(
    studio.rows().map((row) => row.label),
    ['Show instances'],
  );
  await studio.unmount();
  const client = await mount([component('Avatar', '', 0)], { role: clientRole() });
  await client.open(client.buttons()[0]);
  assert.deepEqual(
    client.rows().map((row) => row.label),
    ['Show instances'],
  );
  await client.unmount();
});

function clientRole() {
  return { id: 'client', name: 'Client', isAdmin: false, features: new Set(), appPermissions: {}, pinnedApps: [], componentRules: [] };
}
