// Goal: renames require an explicit Apply and show live route conflicts in the shared popup.
// Method: mount the real Desktop Pages panel and shared dialog, type through DOM events,
// and exercise invalid inputs, cancellation, pending saves and late server failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { repoPath, ROOT } = require('../../helpers/sources');
const output = repoPath('node_modules/.stacki-test/page-rename-dialog.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export { RenamePageDialog } from './src/features/pages/RenamePageDialog';
    export { default as PagesPanel } from './src/features/pages/PagesPanel';`,
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const inventory = {
  pages: ['index.astro', 'old.astro', 'about/index.astro'],
  folders: ['about', 'empty'],
};
function fixture(context) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const components = require(output);
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const writes = [];
  let closes = 0;
  const props = {
    item: { kind: 'page', from: 'old.astro' },
    inventory,
    save: async (change) => {
      writes.push(change);
    },
    close: () => {
      closes++;
    },
  };
  const show = (overrides = {}) => act(async () => root.render(React.createElement(components.RenamePageDialog, { ...props, ...overrides })));
  const type = (value) =>
    act(async () => {
      const input = document.querySelector('.modal input');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  const submit = () =>
    act(async () => document.querySelector('.modal form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  return { dom, root, components, writes, show, type, submit, closes: () => closes };
}
const apply = () => document.querySelector('.modal button[type="submit"]');
const error = () => document.querySelector('.page-rename-error').textContent;

test('live conflicts disable Apply for index routes and empty folders', async (context) => {
  const setup = fixture(context);
  await setup.show();
  assert.equal(apply().disabled, true);
  assert.equal(error(), '');
  for (const name of ['about', 'ABOUT', 'empty', 'index']) {
    await setup.type(name);
    assert.match(error(), /already used/);
    assert.equal(apply().disabled, true);
    await setup.submit();
    assert.equal(setup.writes.length, 0);
  }
  await setup.type('company');
  assert.equal(error(), '');
  assert.equal(apply().disabled, false);
  await act(async () => document.querySelector('.modal input').blur());
  assert.equal(setup.writes.length, 0, 'Blur never applies the rename');
  await setup.submit();
  assert.deepEqual(setup.writes, [{ kind: 'page', from: 'old.astro', to: 'company.astro' }]);
  assert.equal(setup.closes(), 1);
});

test('folder renaming catches page and folder names and Cancel never writes', async (context) => {
  const setup = fixture(context);
  await setup.show({ item: { kind: 'folder', from: 'about' } });
  for (const name of ['old', 'empty', '../outside', '']) {
    await setup.type(name);
    assert.ok(error());
    assert.equal(apply().disabled, true);
  }
  await setup.type('company');
  assert.equal(error(), '');
  await act(async () => {
    document.querySelector('.modal button[type="button"]').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  assert.equal(setup.writes.length, 0);
  assert.equal(setup.closes(), 1);
});

test('late conflicts stay visible and pending saves cannot submit twice', async (context) => {
  const setup = fixture(context);
  let reject;
  let saves = 0;
  await setup.show({
    save: () => {
      saves++;
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    },
  });
  await setup.type('company');
  await setup.submit();
  await setup.submit();
  assert.equal(saves, 1);
  assert.equal(apply().disabled, true);
  assert.equal(document.querySelector('.modal input').disabled, true);
  await act(async () => reject(new Error('The destination was just created by another editor.')));
  assert.match(error(), /another editor/);
  assert.equal(setup.closes(), 0);
  await setup.type('another');
  assert.equal(error(), '');
  assert.equal(apply().disabled, false);
});

test('Desktop rename action opens the popup instead of an inline rename input', async (context) => {
  const setup = fixture(context);
  const pages = inventory.pages.map((name) => ({
    path: '/site/src/pages/' + name,
    name,
    route: '/' + name.replace(/\.astro$/, ''),
  }));
  await act(async () =>
    setup.root.render(
      React.createElement(setup.components.PagesPanel, {
        scan: { pages, pageFolders: inventory.folders, layouts: [] },
        currentPage: undefined,
        onSelect() {},
        onCreate() {},
        onDelete() {},
        onMovePage() {},
        onRenameFolder() {},
        onDeleteFolder() {},
        onCreateFolder: async () => undefined,
        onRename: async (change) => setup.writes.push(change),
      }),
    ),
  );
  await act(async () => document.querySelector('[data-order-key="old.astro"] [aria-label="Rename page"]').click());
  assert.equal(document.querySelector('.modal input').value, 'old');
  assert.equal(document.querySelector('.rename-input') === null, true);
  assert.equal(apply().textContent, 'Apply');
  await setup.type('about');
  assert.match(error(), /already used/);
  assert.equal(setup.writes.length, 0);
});
