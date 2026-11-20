// Goal: the Pages panel's Select mode looks and behaves like the Assets panel's: a Select button in the header (Done
// while it is on), no trash icon on any row, a checkbox at the start of each row, a click that ticks instead of opening
// the page, an action bar with how many are ticked and a red Delete, a confirm in the app's own dialog, and Esc to leave.
// Method: the real PagesPanel and ConfirmHost bundled as the app bundles them and rendered in jsdom, with a recording
// host standing in for main. Every case reads the DOM a person would see and the requests the host received. Nothing
// waits on a timer: each step is awaited through React's act.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { repoPath, ROOT } = require('../../helpers/sources');
const output = repoPath('node_modules/.stacki-test/page-select-mode.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export { default as PagesPanel } from './src/features/pages/PagesPanel';
    export { ConfirmHost } from './src/ui/ConfirmDialog';`,
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

const page = (name, route) => ({ path: '/site/src/pages/' + name, name, route });
const PAGES = [
  page('index.astro', '/'),
  page('about.astro', '/about'),
  page('404.astro', '/404'),
  page('blog/first.md', '/blog/first'),
  page('blog/second.md', '/blog/second'),
];
const IMPACT = { files: 0, links: 3, moves: [], reviews: [{ file: 'src/layouts/Base.astro', line: 4, text: '<a href="/about">' }], reviewsMore: 0 };

function fixture(context) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLInputElement = dom.window.HTMLInputElement;
  global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const components = require(output);
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const calls = { planned: [], applied: [], failed: [], opened: [] };
  let planReply = (request) => ({
    ok: true,
    value: {
      pages: request.pages.length,
      folders: request.folders.length,
      errorPages: request.pages.filter((name) => name === '404.astro').length,
      impact: IMPACT,
    },
  });
  const bulkRemove = {
    plan: async (request) => {
      calls.planned.push(request);
      return planReply(request);
    },
    apply: async (request) => {
      calls.applied.push(request);
      return { ok: true, value: undefined };
    },
    fail: (error) => calls.failed.push(error.message),
  };
  const none = async () => undefined;
  const render = (overrides = {}) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          undefined,
          React.createElement(components.PagesPanel, {
            scan: { pages: PAGES, pageFolders: ['blog', 'empty'], layouts: [] },
            currentPage: PAGES[1],
            onSelect: (selected) => calls.opened.push(selected.name),
            onCreate: () => {},
            onCreateTemplate: none,
            connectSanity: () => undefined,
            onMovePage: () => {},
            onCreateFolder: none,
            onRename: none,
            onRenameFolder: () => {},
            bulkRemove,
            ...overrides,
          }),
          React.createElement(components.ConfirmHost),
        ),
      ),
    );
  const click = (element, init = {}) =>
    act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    });
  const key = (element, init) =>
    act(async () => {
      element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
  return { dom, render, click, key, calls, setPlan: (reply) => (planReply = reply) };
}

const rows = () => [...document.querySelectorAll('.panel-body .list-item')];
const rowFor = (label) => rows().find((row) => row.querySelector('.label')?.textContent === label);
const box = (row) => row.querySelector('input[type="checkbox"]');
const headerButton = () => document.querySelector('.panel-header .asset-select-link');
const bar = () => document.querySelector('.page-select-bar');
const barButton = (label) => [...bar().querySelectorAll('button')].find((element) => element.textContent === label);
const count = () => bar().querySelector('.page-select-count').textContent;

test('with Select mode off, no row has a trash icon or a checkbox, and the header has a Select text button', async (context) => {
  const setup = fixture(context);
  await setup.render();
  assert.equal(headerButton().textContent, 'Select');
  const actions = [...document.querySelectorAll('.panel-body .row-action')];
  assert.equal(actions.length > 0, true, 'the settings gear stays');
  assert.deepEqual(
    actions.map((action) => action.className),
    actions.map((action) => (action.classList.contains('settings-action') ? 'row-action settings-action' : 'row-action rename-action')),
    'the only row actions are the settings gear and the folder rename: no trash',
  );
  assert.equal(
    actions.some((action) => /delete/i.test(action.title)),
    false,
  );
  assert.equal(document.querySelectorAll('.panel-body input[type="checkbox"]').length, 0);
  assert.equal(bar() ?? undefined, undefined);
});

test('without a host that can delete several pages, the header has no Select button', async (context) => {
  const setup = fixture(context);
  await setup.render({ bulkRemove: undefined });
  assert.equal(headerButton() ?? undefined, undefined);
});

test('Select turns into Done, shows a checkbox on every row and the action bar, and a click ticks instead of opening the page', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await setup.click(headerButton());
  assert.equal(headerButton().textContent, 'Done');
  assert.equal(document.querySelectorAll('.panel-body .row-action').length, 0, 'no gear while selecting');
  assert.equal(rows().length, rows().filter((row) => box(row)).length, 'every row starts with a checkbox');
  assert.equal(count(), '0 selected');
  assert.equal(barButton('Delete').disabled, true);
  await setup.click(rowFor('about'));
  assert.equal(box(rowFor('about')).checked, true);
  assert.equal(count(), '1 selected');
  assert.deepEqual(setup.calls.opened, [], 'a click in Select mode never opens the page');
  assert.equal(barButton('Delete').disabled, false);
  assert.equal(barButton('Delete').className, 'danger', 'Delete is the one red button');
  await setup.click(rowFor('about'));
  assert.equal(count(), '0 selected');
  await setup.click(headerButton());
  assert.equal(bar() ?? undefined, undefined);
  assert.equal(headerButton().textContent, 'Select');
});

test('the homepage cannot be ticked and says why', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await setup.click(headerButton());
  const home = rows().find((row) => row.getAttribute('title')?.includes('homepage'));
  assert.ok(home, 'the homepage row carries the reason as its tooltip');
  assert.equal(box(home).disabled, true);
  assert.equal(home.getAttribute('title'), 'The homepage can’t be deleted. Make another page the homepage first.');
  await setup.click(home);
  assert.equal(count(), '0 selected');
});

test('a folder ticks everything inside it, shows partial when only some is ticked, and Shift-click ticks a range', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await setup.click(headerButton());
  await setup.click(rowFor('Blog'));
  assert.equal(box(rowFor('Blog')).checked, true);
  assert.equal(box(rowFor('first')).checked, true);
  assert.equal(box(rowFor('second')).checked, true);
  assert.equal(count(), '1 selected', 'a folder is one however many pages it holds');
  await setup.click(rowFor('first'));
  assert.equal(box(rowFor('Blog')).checked, false);
  assert.equal(box(rowFor('Blog')).indeterminate, true, 'a folder with some of its pages ticked is partial');
  assert.equal(count(), '1 selected');
  await setup.click(headerButton());
  await setup.click(headerButton());
  await setup.click(rowFor('about'));
  await setup.click(rowFor('404'), { shiftKey: true });
  assert.equal(box(rowFor('404')).checked, true);
  assert.equal(count(), '2 selected');
});

test('Cmd+A ticks every row shown, and a search narrows it to the results', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await setup.click(headerButton());
  await setup.key(document.querySelector('.panel-section'), { key: 'a', metaKey: true });
  assert.equal(box(rowFor('about')).checked, true);
  assert.equal(box(rowFor('404')).checked, true);
  assert.equal(box(rowFor('Blog')).checked, true);
  assert.equal(box(rowFor('Home')).checked, false, 'the homepage stays unticked');
  await setup.click(barButton('Cancel'));
  assert.equal(bar() ?? undefined, undefined, 'Cancel leaves the mode and forgets the ticks');
  await setup.click(headerButton());
  assert.equal(count(), '0 selected');
  const search = document.querySelector('.panel-section input:not([type="checkbox"])');
  await act(async () => {
    Object.getOwnPropertyDescriptor(setup.dom.window.HTMLInputElement.prototype, 'value').set.call(search, 'blog');
    search.dispatchEvent(new setup.dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(rows().length, 2, 'the search shows two pages');
  await setup.key(document.querySelector('.panel-section'), { key: 'a', ctrlKey: true });
  assert.equal(count(), '1 selected', 'both blog pages are ticked, which is the folder');
});

test('Esc leaves the mode', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await setup.click(headerButton());
  await setup.click(rowFor('about'));
  await setup.key(document.querySelector('.panel-section'), { key: 'Escape' });
  assert.equal(bar() ?? undefined, undefined);
  assert.equal(document.querySelectorAll('.panel-body input[type="checkbox"]').length, 0);
});

test('Delete plans, asks in the app’s own dialog what will go and what will break, then deletes once and leaves the mode', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await setup.click(headerButton());
  await setup.click(rowFor('about'));
  await setup.click(rowFor('404'));
  await setup.click(barButton('Delete'));
  assert.deepEqual(setup.calls.planned, [{ pages: ['404.astro', 'about.astro'], folders: [] }]);
  assert.deepEqual(setup.calls.applied, [], 'nothing is deleted before the answer');
  const dialog = document.querySelector('.modal');
  assert.ok(dialog, 'the confirm is the app’s own dialog');
  const dialogText = dialog.textContent;
  assert.match(dialogText, /Delete 2 pages\?/);
  assert.match(dialogText, /2 files in src\/pages are deleted\. Undo puts them all back in one step\./);
  assert.match(dialogText, /site’s error page/);
  assert.match(dialogText, /3 links point to these pages and will break/);
  assert.match(dialogText, /src\/layouts\/Base\.astro:4/);
  const confirm = [...dialog.querySelectorAll('button')].find((element) => element.className.includes('danger'));
  assert.equal(confirm.textContent, 'Delete');
  await setup.click(confirm);
  assert.deepEqual(setup.calls.applied, [{ pages: ['404.astro', 'about.astro'], folders: [] }]);
  assert.equal(bar() ?? undefined, undefined, 'the selection clears after the delete');
  assert.equal(headerButton().textContent, 'Select');
});

test('cancelling the confirm deletes nothing and keeps the selection; a refusal is shown, not swallowed', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await setup.click(headerButton());
  await setup.click(rowFor('Blog'));
  await setup.click(barButton('Delete'));
  assert.deepEqual(setup.calls.planned, [{ pages: [], folders: ['blog'] }]);
  const cancel = [...document.querySelector('.modal').querySelectorAll('button')].find((element) => element.textContent === 'Cancel');
  await setup.click(cancel);
  assert.deepEqual(setup.calls.applied, []);
  assert.equal(count(), '1 selected');
  setup.setPlan(() => ({
    ok: false,
    error: { code: 'refused', message: 'The folder “blog” holds src/pages/blog/data.json, which is not a page. Move or delete it first.' },
  }));
  await setup.click(barButton('Delete'));
  assert.equal(document.querySelector('.modal') ?? undefined, undefined, 'no confirm for a plan main refused');
  assert.equal(setup.calls.failed.length, 1);
  assert.match(setup.calls.failed[0], /which is not a page/);
  assert.equal(count(), '1 selected');
});
