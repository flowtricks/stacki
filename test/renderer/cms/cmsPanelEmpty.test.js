// Goal: Keep the CMS panel useful when its current view contains no collections: the
// project's content collections are always offered, and + still creates a collection.
// Methodology: Mount with in-memory inventories, including collections hidden in
// another Astro file, and exercise the creation and cancel controls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/cms-panel-empty.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/cms/CmsPanel.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const CmsPanel = require(output).default;

const hiddenCollection = {
  rel: 'pages/other.astro#posts',
  name: 'posts',
  dir: 'pages/other.astro',
  data: [{ title: 'A post' }],
};

async function mountPanel(files, collections = []) {
  window.avb = {
    listCms: async () => ({ files }),
    contentCollections: async () => ({
      collections,
      covered: { files: [], dirs: [] },
    }),
    onCmsChanged: () => () => {},
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(CmsPanel, {
        project: { path: '/project' },
        currentFile: 'pages/index.astro',
        refreshKey: 0,
        onSelect: () => {},
        onSelectContent: () => {},
        onOpenSettings: () => {},
        showToast: () => {},
      }),
    );
  });
  return root;
}

test('a panel with no collections offers content collections and creation', async () => {
  for (const files of [[], [hiddenCollection]]) {
    const root = await mountPanel(files);
    try {
      const rows = [...document.querySelectorAll('.cms-collection')];
      assert.deepEqual(
        rows.map((row) => row.textContent),
        ['Content Collections'],
        'the content collections row is always there; a hidden file collection is not',
      );
      await act(async () => document.querySelector('button[title="New collection"]').click());
      const input = document.querySelector('input[placeholder="Collection name"]');
      assert.equal(document.activeElement, input);
      await act(async () => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      assert.ok(document.querySelector('input') === null);
      assert.equal(document.querySelectorAll('.cms-collection').length, 1);
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test('visible file and content collections suppress the empty state', async () => {
  const inventories = [
    {
      files: [{ ...hiddenCollection, dir: 'pages/index.astro', rel: 'pages/index.astro#posts' }],
      collections: [],
    },
    { files: [{ ...hiddenCollection, dir: 'data', rel: 'data/posts.json' }], collections: [] },
    { files: [], collections: [{ name: 'posts', editable: true, count: 0 }] },
  ];
  for (const inventory of inventories) {
    const root = await mountPanel(inventory.files, inventory.collections);
    try {
      assert.ok(document.querySelector('.props-empty') === null);
      assert.ok(document.querySelector('.cms-collection'));
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test('CMS reopens from cache and reports refresh failures', async () => {
  const root = await mountPanel([{ ...hiddenCollection, dir: 'data', rel: 'data/posts.json' }]);
  await act(async () => root.render(undefined));
  let rejectRead;
  window.avb.listCms = () =>
    new Promise((resolve, reject) => {
      rejectRead = reject;
    });
  await act(async () =>
    root.render(
      React.createElement(CmsPanel, {
        project: { path: '/project' },
        currentFile: 'pages/index.astro',
        refreshKey: 0,
        onSelect() {},
        onSelectContent() {},
        onOpenSettings() {},
        showToast() {},
      }),
    ),
  );
  assert.ok(document.querySelector('.cms-collection'), 'Previous collections render before the read');
  assert.doesNotMatch(document.body.textContent, /Loading collections|No collections to show/);
  await act(async () => rejectRead(new Error('CMS unavailable')));
  assert.match(document.body.textContent, /CMS unavailable/);
  assert.doesNotMatch(document.body.textContent, /No collections to show/);
  assert.equal(document.querySelector('[role="alert"] button').textContent, 'Retry');
  await act(async () => root.unmount());
});
