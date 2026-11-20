// Goal: the Page settings dialog shows each page what it can change, asks before every write with what will happen,
// and hands each step to its host exactly once; the layout's props there are the Properties panel's own fields.
// Method: the real shared dialog, Pages panel and props editors, bundled as the app bundles them and rendered in
// jsdom with React. A recording host stands in for main (its plan answers a fixed summary), so each case reads the
// DOM a person would see — the badge, the disabled button and its reason, the confirm's lines — and the requests the
// host received. No timers are waited on: every step is awaited through React's act.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { repoPath, ROOT } = require('../../helpers/sources');
const output = repoPath('node_modules/.stacki-test/page-settings-dialog.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export { PageSettingsDialog } from './src/features/pages/PageSettingsDialog';
    export { default as PagesPanel } from './src/features/pages/PagesPanel';
    export { default as PropsPanel, InstancePropFields } from './src/features/props/PropsPanel';`,
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
  page('blog/[slug].astro', '/blog/[slug]'),
  page('404.astro', '/404'),
  page('contact.md', '/contact'),
];
const SUMMARY = { files: 3, links: 7, moves: [], reviews: [{ file: 'astro.config.mjs', line: 4, text: "'/old': '/'," }], reviewsMore: 0 };

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
  const planned = [];
  const applied = [];
  let closes = 0;
  const host = {
    unavailable: undefined,
    plan: async (request) => {
      planned.push(request);
      return { ok: true, value: SUMMARY };
    },
    apply: async (request) => {
      applied.push(request);
      return { ok: true, value: undefined };
    },
  };
  const show = (name, overrides = {}) =>
    act(async () =>
      root.render(
        React.createElement(components.PageSettingsDialog, {
          page: PAGES.find((entry) => entry.name === name),
          pages: PAGES,
          folders: ['blog'],
          host,
          allowed: { rename: true, create: true, remove: true },
          close: () => {
            closes++;
          },
          ...overrides,
        }),
      ),
    );
  const type = (value) =>
    act(async () => {
      const input = document.querySelector('.page-settings-general input');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  const click = (element) => act(async () => element.click());
  return { dom, root, components, host, show, type, click, planned, applied, closes: () => closes };
}
const button = (text) => [...document.querySelectorAll('.page-settings button')].find((element) => element.textContent.includes(text));
const byLabel = (label) => document.querySelector(`.page-settings [aria-label^="${label}"]`);
const text = () => document.querySelector('.page-settings').textContent;
const moveButton = (label) => [...document.querySelectorAll('.page-settings-move button')].find((element) => element.textContent === label);
const homeTip = () => button('Make this page the homepage').getAttribute('aria-description');

test('the homepage hides its URL name and shows the Homepage badge, and cannot be deleted', async (context) => {
  const setup = fixture(context);
  await setup.show('index.astro');
  assert.equal(document.querySelector('.page-settings-general input') ?? undefined, undefined);
  assert.equal(document.querySelector('.page-settings-badge').textContent, 'Homepage');
  assert.equal(text().includes('index'), false);
  assert.equal(button('Make this page the homepage'), undefined);
  const remove = byLabel('Delete this page');
  assert.equal(remove.disabled, true);
  assert.equal(remove.getAttribute('aria-label'), 'Delete this page · The homepage can’t be deleted. Make another page the homepage first.');
  assert.equal(byLabel('Duplicate this page').disabled, false);
});

test('another page shows its URL name and, in General, the house button that confirms the swap', async (context) => {
  const setup = fixture(context);
  await setup.show('about.astro');
  assert.equal(document.querySelector('.page-settings-general input').value, 'about');
  // No Homepage card: the button sits in General, and what it replaces is its tooltip.
  assert.equal(document.querySelectorAll('.page-settings-section').length, 1);
  assert.equal(button('Make this page the homepage').closest('.page-settings-section').querySelector('h3').textContent, 'General');
  assert.equal(homeTip(), 'Replaces Home as the homepage');
  assert.equal(text().includes('The current homepage'), false);
  const house = button('Make this page the homepage');
  assert.equal(house.disabled, false);
  await setup.click(house);
  assert.deepEqual(setup.planned, [{ kind: 'home', page: 'about.astro' }]);
  // The confirm is a popover beside the button; the dialog's sections stay as they were.
  assert.equal(document.querySelector('.page-settings-move .page-settings-confirm-title').textContent, 'Make “about” the homepage?');
  assert.equal(document.querySelector('.page-settings .page-settings-confirm') ?? undefined, undefined);
  assert.ok(button('Make this page the homepage'));
  const lines = [...document.querySelectorAll('.page-settings-move .page-settings-bullets li')].map((item) => item.textContent);
  assert.deepEqual(lines, [
    'about becomes the homepage, at / (src/pages/index.astro).',
    'Home moves to /about (src/pages/about.astro).',
    '7 links in 3 files are updated.',
    'Nothing else changes, and one Undo puts it all back.',
  ]);
  assert.match(document.querySelector('.page-settings-move .page-settings-review').textContent, /astro\.config\.mjs:4/);
  assert.equal(setup.applied.length, 0);
  await act(async () =>
    document.querySelector('.page-settings-move-body').dispatchEvent(new setup.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  assert.deepEqual(setup.applied, [{ kind: 'home', page: 'about.astro' }]);
  assert.equal(setup.closes(), 1);
});

test('the homepage popover’s Make homepage button confirms; Cancel and Escape write nothing', async (context) => {
  const setup = fixture(context);
  await setup.show('contact.md');
  await setup.click(button('Make this page the homepage'));
  assert.ok(moveButton('Make homepage'));
  await setup.click(moveButton('Cancel'));
  assert.equal(document.querySelector('.page-settings-move') ?? undefined, undefined);
  await setup.click(button('Make this page the homepage'));
  await act(async () => document.dispatchEvent(new setup.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('.page-settings-move') ?? undefined, undefined);
  assert.equal(setup.applied.length, 0);
  await setup.click(button('Make this page the homepage'));
  await setup.click(moveButton('Make homepage'));
  assert.deepEqual(setup.applied, [{ kind: 'home', page: 'contact.md' }]);
});

test('error pages disable the house button with the reason; templates have no Homepage section', async (context) => {
  const setup = fixture(context);
  await setup.show('404.astro');
  assert.equal(button('Make this page the homepage').disabled, true);
  assert.equal(homeTip(), 'Error pages (404, 500) can’t be the homepage.');
  // A CMS template has no Homepage section at all, and its route pattern is shown, never edited.
  await setup.show('blog/[slug].astro');
  assert.equal(button('Make this page the homepage'), undefined);
  assert.equal(text().includes('Homepage'), false);
  assert.equal(document.querySelector('.page-settings-general input').readOnly, true);
  assert.equal(setup.planned.length, 0);
});

test('the URL name is offered on Enter or blur in a popover beside it; invalid names never are; Cancel puts it back', async (context) => {
  const setup = fixture(context);
  await setup.show('about.astro');
  assert.equal(button('Change address'), undefined);
  const field = () => document.querySelector('.page-settings-general input');
  const enter = () => act(async () => field().dispatchEvent(new setup.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  const table = [
    ['index', '“index” is the homepage’s file name. Use “Make this page the homepage” instead.'],
    ['', 'Enter a URL name.'],
    ['a/b', 'Enter a name without folder separators.'],
    ['CONTACT', 'The URL /CONTACT is already used by another page or folder.'],
  ];
  for (const [typed, problem] of table) {
    await setup.type(typed);
    await enter();
    assert.equal(document.querySelector('.page-rename-error').textContent, problem);
    assert.equal(document.querySelector('.page-settings-move') ?? undefined, undefined, typed);
  }
  assert.equal(setup.planned.length, 0);
  await setup.type('company');
  // The chip keeps the current address until the move is confirmed.
  assert.equal(document.querySelector('.page-settings-address').textContent, '/about');
  assert.equal(document.querySelector('.page-settings-address').getAttribute('aria-label'), 'Web address: /about');
  await enter();
  assert.deepEqual(setup.planned, [{ kind: 'rename', from: 'about.astro', to: 'company.astro' }]);
  assert.equal(document.querySelector('.page-settings-move .page-settings-confirm-title').textContent, 'Change the address to /company?');
  assert.match(document.querySelector('.page-settings-move').textContent, /\/about becomes \/company\./);
  assert.match(document.querySelector('.page-settings-move').textContent, /7 links in 3 files are updated\./);
  assert.equal(document.querySelector('.page-settings-address').textContent, '/about');
  await setup.click(moveButton('Cancel'));
  assert.equal(field().value, 'about');
  assert.equal(document.querySelector('.page-settings-move') ?? undefined, undefined);
  assert.equal(setup.applied.length, 0);
  // Blur offers it too; Enter in the popover moves the page.
  await setup.type('company');
  await act(async () => field().dispatchEvent(new setup.dom.window.FocusEvent('focusout', { bubbles: true })));
  assert.equal(setup.planned.length, 2);
  await act(async () =>
    document.querySelector('.page-settings-move-body').dispatchEvent(new setup.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  assert.deepEqual(setup.applied, [{ kind: 'rename', from: 'about.astro', to: 'company.astro' }]);
  assert.equal(moveButton('Move page') ?? undefined, undefined);
});

test('duplicate applies at once; delete confirms with what breaks; a host that cannot says why', async (context) => {
  const setup = fixture(context);
  await setup.show('about.astro');
  await setup.click(byLabel('Duplicate this page'));
  assert.deepEqual(setup.applied, [{ kind: 'duplicate', page: 'about.astro' }]);
  await setup.show('404.astro');
  await setup.click(byLabel('Delete this page'));
  assert.equal(document.querySelector('.page-settings-confirm-title').textContent, 'Delete “404”?');
  assert.match(text(), /This is the site’s error page/);
  assert.match(text(), /7 links point to this page and will break:/);
  await setup.click(button('Delete page'));
  assert.deepEqual(setup.applied.at(-1), { kind: 'remove', page: '404.astro' });
  const studio = { ...setup.host, plan: undefined, unavailable: { message: 'Available in Stacki Desktop.' } };
  await setup.show('about.astro', { host: studio });
  assert.equal(button('Make this page the homepage').disabled, true);
  assert.equal(homeTip(), 'Available in Stacki Desktop.');
  assert.equal(byLabel('Duplicate this page').disabled, true);
});

test('a refused step shows main’s sentence in the dialog and stays open', async (context) => {
  const setup = fixture(context);
  const host = { ...setup.host, plan: async () => ({ ok: false, error: { code: 'parse', message: 'src/a.ts does not parse.' } }) };
  await setup.show('about.astro', { host });
  await setup.click(button('Make this page the homepage'));
  assert.equal(document.querySelector('.page-settings-problem').textContent, 'src/a.ts does not parse.');
  assert.equal(setup.closes(), 0);
});

test('the Pages panel gear opens the host’s settings dialog for that page', async (context) => {
  const setup = fixture(context);
  const opened = [];
  await act(async () =>
    setup.root.render(
      React.createElement(setup.components.PagesPanel, {
        scan: { pages: PAGES, pageFolders: ['blog'], layouts: [] },
        currentPage: undefined,
        onSelect() {},
        onCreate() {},
        onDelete() {},
        onMovePage() {},
        onRenameFolder() {},
        onDeleteFolder() {},
        onCreateFolder: async () => undefined,
        onRename: async () => undefined,
        renderPageSettings: (entry) => {
          opened.push(entry.name);
          return React.createElement('div', { className: 'host-settings' }, entry.name);
        },
      }),
    ),
  );
  assert.equal(document.querySelectorAll('[aria-label="Rename page"]').length, 0);
  await act(async () => document.querySelector('[data-order-key="about.astro"] [aria-label="Page settings"]').click());
  assert.equal(document.querySelector('.host-settings').textContent, 'about.astro');
  assert.deepEqual([...new Set(opened)], ['about.astro']);
});

test('a layout prop edited in the dialog is the edit the Properties panel makes', async (context) => {
  const setup = fixture(context);
  const node = { kind: 'component', id: 'layout', name: 'BaseLayout', props: { title: { kind: 'string', value: 'Home' } }, children: [] };
  const schema = [
    { name: 'title', type: 'string' },
    { name: 'description', type: 'string', optional: true },
  ];
  const edits = (component) => {
    const calls = [];
    const props = {
      node,
      schema,
      isLayout: true,
      onSetProp: (...args) => calls.push(args),
      onRenameProp() {},
      onSetText() {},
      onSetContent() {},
      onSetInline() {},
    };
    return { calls, element: React.createElement(component, props) };
  };
  const results = [];
  for (const component of [setup.components.PropsPanel, setup.components.InstancePropFields]) {
    const run = edits(component);
    await act(async () => setup.root.render(run.element));
    const input = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].find(
      (element) => element.value === 'Home' || element.textContent === 'Home',
    );
    assert.ok(input, 'the title field shows its value');
    await act(async () => {
      if ('value' in input) {
        const prototype = input.tagName === 'TEXTAREA' ? setup.dom.window.HTMLTextAreaElement.prototype : setup.dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, 'Welcome');
        input.dispatchEvent(new setup.dom.window.Event('input', { bubbles: true }));
        input.dispatchEvent(new setup.dom.window.Event('blur', { bubbles: true }));
      }
    });
    results.push(run.calls.map((call) => JSON.stringify(call.slice(0, 2))));
  }
  assert.ok(results[0].length > 0, 'the Properties panel wrote the title');
  assert.deepEqual(results[1], results[0]);
});

test('picking another folder offers the move at once; Cancel puts the folder back; a taken name is refused inline', async (context) => {
  const setup = fixture(context);
  const pick = async (label) => {
    await setup.click(document.querySelector('.page-settings-folder'));
    const option = [...document.querySelectorAll('.dd-option')].find((entry) => entry.querySelector('.dd-option-label')?.textContent === label);
    assert.ok(option, label);
    await setup.click(option);
  };
  await setup.show('about.astro');
  assert.equal(document.querySelector('.page-settings-folder .dd-label').textContent, 'Pages (root)');
  await pick('/blog');
  assert.deepEqual(setup.planned.at(-1), { kind: 'rename', from: 'about.astro', to: 'blog/about.astro' });
  assert.match(document.querySelector('.page-settings-move').textContent, /\/about becomes \/blog\/about\./);
  assert.equal(document.querySelector('.page-settings-address').textContent, '/about');
  await setup.click(moveButton('Cancel'));
  assert.equal(document.querySelector('.page-settings-folder .dd-label').textContent, 'Pages (root)');
  await pick('/blog');
  await setup.click(moveButton('Move page'));
  assert.deepEqual(setup.applied.at(-1), { kind: 'rename', from: 'about.astro', to: 'blog/about.astro' });
  // A template moves out of its folder; only the folder changes.
  await setup.show('blog/[slug].astro');
  assert.equal(document.querySelector('.page-settings-folder .dd-label').textContent, '/blog');
  await pick('Pages (root)');
  assert.deepEqual(setup.planned.at(-1), { kind: 'rename', from: 'blog/[slug].astro', to: '[slug].astro' });
  await setup.click(moveButton('Cancel'));
  await setup.show('contact.md');
  await setup.type('about');
  assert.equal(document.querySelector('.page-rename-error').textContent, 'The URL /about is already used by another page or folder.');
  // The homepage has no folder control.
  await setup.show('index.astro');
  assert.equal(document.querySelector('.page-settings-folder') ?? undefined, undefined);
});

test('the Folder dropdown shows a folder icon on every row and makes a new folder inside the menu', async (context) => {
  const setup = fixture(context);
  await setup.show('about.astro');
  await setup.click(document.querySelector('.page-settings-folder'));
  const rows = [...document.querySelectorAll('.dd-option')];
  assert.deepEqual(
    rows.map((row) => row.querySelector('.dd-option-label').textContent),
    ['Pages (root)', '/blog', 'New folder…'],
  );
  for (const row of rows) {
    assert.ok(row.querySelector('.dd-icon svg'), 'every row starts with its icon');
    assert.equal(row.firstElementChild.classList.contains('dd-icon'), true, 'the icon leads the row');
  }
  await setup.click(rows.at(-1));
  const field = () => document.querySelector('.dd-create-field input');
  assert.equal(field().placeholder, 'Folder name');
  assert.equal(document.activeElement, field());
  assert.ok(document.querySelector('.dd-create-field .dd-icon svg'));
  assert.equal(document.querySelector('.page-settings-new-folder') ?? undefined, undefined);
  const typeFolder = (value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(setup.dom.window.HTMLInputElement.prototype, 'value').set.call(field(), value);
      field().dispatchEvent(new setup.dom.window.Event('input', { bubbles: true }));
    });
  const press = (key) => act(async () => field().dispatchEvent(new setup.dom.window.KeyboardEvent('keydown', { key, bubbles: true })));
  const table = [
    ['BLOG', 'A folder named BLOG already exists.'],
    ['Contact', 'The URL /Contact is already used by another page or folder.'],
    ['a/../b', 'Page paths must stay inside the pages folder.'],
    ['bad*name', 'Use letters, numbers, spaces or dashes in page paths.'],
  ];
  for (const [typed, problem] of table) {
    await typeFolder(typed);
    await press('Enter');
    assert.equal(document.querySelector('.dd-create-error').textContent, problem, typed);
    assert.ok(field(), 'an invalid name keeps the field open');
  }
  assert.equal(setup.planned.length, 0);
  await typeFolder('company');
  await press('Enter');
  assert.equal(document.querySelector('.dd-popup') ?? undefined, undefined);
  assert.equal(document.querySelector('.page-settings-folder .dd-label').textContent, '/company');
  assert.deepEqual(setup.planned.at(-1), { kind: 'rename', from: 'about.astro', to: 'company/about.astro' });
  await setup.click(moveButton('Cancel'));
  // Cancelled: the folder is gone back to the page's own, and nothing was written.
  assert.equal(document.querySelector('.page-settings-folder .dd-label').textContent, 'Pages (root)');
  assert.equal(setup.applied.length, 0);
});
