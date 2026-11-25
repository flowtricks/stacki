// Goal: closing or reopening a component-usage popup invalidates older scans.
// Methodology: hold multiple replies for the same component, resolve them out
// of order, and assert only the newest owned request can populate the popup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('component usage popup ignores replies after close and from older opens', async () => {
  const directory = repoPath('node_modules/.stacki-test/palette-lifecycle');
  const bundle = path.join(directory, 'panel.js');
  fs.mkdirSync(directory, { recursive: true });
  await esbuild.build({
    entryPoints: [repoPath('src/features/palette/PalettePanel.tsx')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const PalettePanel = require(bundle).default;
  const requests = [];
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(PalettePanel, {
        components: [{ path: '/p/Button.astro', name: 'Button', folder: '', instances: 1 }],
        devUrl: undefined,
        onInsert: () => {},
        onCreateComponent: () => {},
        createFrom: { kind: 'unavailable', reason: 'Select an element.' },
        onUsage: () => {
          const request = deferred();
          requests.push(request);
          return request.promise;
        },
      }),
    );
    await Promise.resolve();
  });
  const count = () => document.querySelector('.palette-instances');
  const clickCount = () =>
    act(async () => {
      count().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  await clickCount();
  await act(async () => {
    document.querySelector('.instances-head button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    requests[0].resolve({ files: [] });
    await Promise.resolve();
  });
  assert.ok(document.querySelector('.instances-popup') === null);

  await clickCount();
  await clickCount();
  const oldFile = {
    rel: 'src/pages/old.astro',
    path: '/p/src/pages/old.astro',
    kind: 'page',
    count: 1,
  };
  const newFile = {
    rel: 'src/pages/new.astro',
    path: '/p/src/pages/new.astro',
    kind: 'page',
    count: 1,
  };
  await act(async () => {
    requests[2].resolve({ files: [newFile], total: 1 });
    await Promise.resolve();
  });
  await act(async () => {
    requests[1].resolve({ files: [oldFile], total: 1 });
    await Promise.resolve();
  });
  assert.match(document.querySelector('.instances-popup').textContent, /new/);
  assert.doesNotMatch(document.querySelector('.instances-popup').textContent, /old/);
  await act(async () => root.unmount());
  dom.window.close();
});
