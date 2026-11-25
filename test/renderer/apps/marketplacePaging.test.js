// Goal: the Marketplace tab renders the index 100 apps at a time and loads the
// next 100 as the loading row at the list's end scrolls into the panel's view,
// stopping once every app is shown. Search covers the whole index, not only the
// rendered pages: a search for app 240 finds it before any page has loaded, its
// results page by 100 the same way, and clearing the search returns to the full
// list's first page.
// Method: the real MarketplaceView mounted in JSDOM with a stubbed `window.avb`
// serving 250 fake apps, and a fake IntersectionObserver so the test decides when
// the loading row is in view. The observer's root is checked to be the panel's
// scroll container, not the window. Rows are counted from the DOM after each step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

// Every observer the view makes; `show` tells those watching `element` that it came into view.
const observers = [];
global.IntersectionObserver = class {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.elements = new Set();
    observers.push(this);
  }
  observe(element) {
    this.elements.add(element);
  }
  disconnect() {
    this.elements.clear();
  }
};
const show = (element) => {
  for (const observer of [...observers]) {
    if (observer.elements.has(element)) {
      observer.callback([{ target: element, isIntersecting: true }]);
    }
  }
};

function bundle(entry, name) {
  const directory = repoPath('node_modules/.stacki-test/marketplace-paging');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, `${name}.cjs`);
  esbuild.buildSync({
    entryPoints: [repoPath(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return require(outfile);
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { Simulate } = require('react-dom/test-utils');
const { MarketplaceView } = bundle('src/features/apps/marketplace/MarketplaceView.tsx', 'view');
const roles = bundle('shared/properties/projectRoles.ts', 'roles');

const APP_COUNT = 250;
const pad = (number) => String(number).padStart(3, '0');
const fakeApp = (number) => ({
  id: `app-${pad(number)}`,
  name: `App ${pad(number)}`,
  description: `Fake marketplace app number ${pad(number)}.`,
  author: 'octocat',
  icon: `https://stacki.build/api/marketplace/icons/app-${pad(number)}.png`,
  categories: ['tools'],
  source: { owner: 'octocat', repository: `app-${pad(number)}`, asset: `app-${pad(number)}.zip` },
  versions: [{ version: '1.0.0', tag: 'v1.0.0', sha256: 'a'.repeat(64) }],
});
const INDEX = { version: 1, apps: Array.from({ length: APP_COUNT }, (_, at) => fakeApp(at + 1)) };

async function mount() {
  observers.length = 0;
  window.avb = { appMarketplace: async () => ({ ok: true, value: INDEX }) };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(MarketplaceView, {
        projectPath: '/p',
        role: roles.ADMIN_VIEW,
        installed: [],
        notify: () => {},
        avatar: () => undefined,
        onInstalled: () => {},
      }),
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const rows = () => [...container.querySelectorAll('.apps-market-row .apps-row-title')].map((element) => element.textContent);
  const sentinel = () => container.querySelector('.apps-market-more');
  const scrollNearEnd = async () => {
    const row = sentinel();
    assert.ok(row, 'a loading row ends the list while more remain');
    await act(async () => show(row));
  };
  const search = (value) => act(async () => Simulate.change(container.querySelector('input[type=search]'), { target: { value } }));
  const finish = () => act(async () => root.unmount());
  return { container, rows, sentinel, scrollNearEnd, search, finish };
}

test('the search reads "Search the marketplace"', async () => {
  const view = await mount();
  assert.equal(view.container.querySelector('input[type=search]').getAttribute('placeholder'), 'Search the marketplace');
  await view.finish();
});

test('250 apps render 100, then 200, then 250 as the loading row comes into view', async () => {
  const view = await mount();
  assert.equal(view.rows().length, 100);
  assert.equal(view.rows()[0], 'App 001');
  assert.equal(view.sentinel().textContent, 'Loading', 'the row is a placeholder, with only its hidden status text');
  assert.ok(view.sentinel().querySelector('.ui-skeleton'));
  const body = view.container.querySelector('.apps-body');
  const watching = observers.find((observer) => observer.elements.has(view.sentinel()));
  assert.equal(watching.options.root, body, 'the observer watches inside the panel, not the window');
  await view.scrollNearEnd();
  assert.equal(view.rows().length, 200);
  assert.deepEqual(
    view.rows().slice(0, 100),
    INDEX.apps.slice(0, 100).map((app) => app.name),
    'rows only append below',
  );
  await view.scrollNearEnd();
  assert.equal(view.rows().length, 250);
  assert.equal(view.rows()[249], 'App 250');
  assert.ok(!view.sentinel(), 'loading stops once everything is shown');
  await view.finish();
});

test('a second report for the same row loads one page, not two', async () => {
  const view = await mount();
  const row = view.sentinel();
  await act(async () => {
    for (const observer of [...observers]) {
      if (observer.elements.has(row)) {
        observer.callback([{ target: row, isIntersecting: true }]);
        observer.callback([{ target: row, isIntersecting: true }]);
      }
    }
  });
  assert.equal(view.rows().length, 200);
  await view.finish();
});

test('search covers the whole index, its results page by 100, and clearing it resets', async () => {
  const view = await mount();
  await view.search('App 240');
  assert.equal(view.rows()[0], 'App 240', 'app 240 is found without loading pages first');
  await view.search('octocat');
  assert.equal(view.rows().length, 100, 'search results page by 100');
  await view.scrollNearEnd();
  assert.equal(view.rows().length, 200);
  await view.scrollNearEnd();
  assert.equal(view.rows().length, 250);
  assert.ok(!view.sentinel());
  await view.search('');
  assert.equal(view.rows().length, 100, 'clearing the search returns to the first page');
  assert.equal(view.rows()[0], 'App 001');
  await view.finish();
});
