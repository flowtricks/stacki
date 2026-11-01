// Goal: asset listings stay attached to their project and watcher bursts stay bounded.
// Methodology: render the real panel with held IPC replies, resolve projects out
// of order, then fire repeated watcher notifications during one active read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/asset-panel-lifecycle');
const bundlePath = path.join(buildDirectory, 'panel.js');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function rootEntry(root) {
  return { rel: root, name: root, parent: '', root, isDir: true, isRoot: true };
}

test('asset listings ignore stale projects and coalesce watcher bursts', async () => {
  fs.mkdirSync(buildDirectory, { recursive: true });
  await esbuild.build({
    entryPoints: [repoPath('src/features/assets/AssetsPanel.tsx')],
    outfile: bundlePath,
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
  const reads = [];
  let watcher = () => {};
  dom.window.avb = {
    listAssets: (projectPath) => {
      const request = deferred();
      reads.push({ projectPath, request });
      return request.promise;
    },
    onAssetsChanged: (callback) => {
      watcher = callback;
      return () => {
        if (watcher === callback) {
          watcher = () => {};
        }
      };
    },
  };
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const AssetsPanel = require(bundlePath).default;
  const root = createRoot(document.getElementById('root'));
  const render = (projectPath) =>
    act(async () => {
      root.render(
        React.createElement(AssetsPanel, {
          project: { path: projectPath },
          showToast: () => {},
        }),
      );
      await Promise.resolve();
    });
  await render('/one');
  assert.equal(document.querySelector('[role="status"]').getAttribute('aria-label'), 'Loading assets…');
  assert.doesNotMatch(document.body.textContent, /Loading assets/);
  assert.doesNotMatch(document.body.textContent, /Empty folder/);
  await render('/two');
  assert.deepEqual(
    reads.map((read) => read.projectPath),
    ['/one', '/two'],
  );
  await act(async () => {
    reads[1].request.resolve({ entries: [rootEntry('src')], missing: true });
    await Promise.resolve();
  });
  await act(async () => {
    reads[0].request.resolve({ entries: [rootEntry('public')], missing: false });
    await Promise.resolve();
  });
  assert.match(document.body.textContent, /src/);
  assert.doesNotMatch(document.body.textContent, /public/);

  await act(async () => {
    watcher();
    watcher();
    await Promise.resolve();
  });
  assert.equal(reads.length, 3, 'only one watcher read runs at a time');
  await act(async () => {
    reads[2].request.resolve({ entries: [rootEntry('src')], missing: true });
    await Promise.resolve();
  });
  assert.equal(reads.length, 4, 'the burst retains one pending follow-up');
  await act(async () => {
    reads[3].request.resolve({ entries: [rootEntry('src')], missing: true });
    await Promise.resolve();
    root.render(undefined);
  });
  await render('/two');
  assert.match(document.body.textContent, /src/);
  assert.doesNotMatch(document.body.textContent, /Loading assets|Empty folder/);
  assert.equal(reads.length, 5, 'Reopened cached listings revalidate in the background');
  await act(async () => {
    reads[4].request.resolve({ entries: [rootEntry('public')], missing: false });
  });
  assert.match(document.body.textContent, /public/, 'A changed inventory replaces cached data');
  await act(async () => root.unmount());
  dom.window.close();
});
