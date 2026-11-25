// Goal: the Files panel opens on the project's real tree in its first frame, and never stays on placeholder rows.
// The keeper (FilesKeeper.tsx), mounted for as long as the project is open, reads the root and the folders left open
// before the panel is ever shown, never a closed folder, and keeps them current while the panel is closed. A listing
// that rejects, or is never answered (a main process older than the renderer), ends in a Refresh button and one toast.
//
// Method: the real panel and keeper, bundled with esbuild and mounted in jsdom over a fake `window.avb` whose replies
// go through the real boundary parsers. A first frame is the DOM of the first commit, read in a layout effect, before
// any passive effect or reply can change it. Node's mock timers stand in for the unanswered read's time limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.MutationObserver = dom.window.MutationObserver;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.ResizeObserver = global.ResizeObserver;
dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
global.IS_REACT_ACT_ENVIRONMENT = true;

// The fake main process: a disk of folder → entry names (a trailing slash is a folder), and how listing answers.
const main = { disk: new Map(), answer: 'ok', listed: [], watched: [], changed: new Set() };
const listing = (folder) => {
  const names = main.disk.get(folder);
  if (names === undefined) {
    return { ok: false, error: { code: 'missing' } };
  }
  const entries = names.map((name) => ({ name: name.replace(/\/$/, ''), kind: name.endsWith('/') ? 'directory' : 'file' }));
  return { ok: true, value: { path: folder, entries, totalCount: entries.length } };
};
dom.window.avb = {
  platform: 'darwin',
  listFiles: ({ path: folder }) => {
    main.listed.push(folder);
    if (main.answer === 'reject') {
      return Promise.reject(new Error("No handler registered for 'files:list'"));
    }
    return main.answer === 'never' ? new Promise(() => {}) : Promise.resolve(listing(folder));
  },
  watchFiles: async ({ directories }) => {
    main.watched = directories;
    return { watching: directories.length };
  },
  onFilesChanged: (callback) => {
    main.changed.add(callback);
    return () => main.changed.delete(callback);
  },
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const create = React.createElement;

let modules;
test.before(async () => {
  const outfile = repoPath('node_modules/.stacki-test/files-instant.cjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    stdin: {
      contents: [
        `export { default as FilesPanel } from './src/features/files/FilesPanel';`,
        `export { FilesKeeper } from './src/features/files/FilesKeeper';`,
        `export { FILES_READ_TIMEOUT_MS } from './src/features/files/filesReader';`,
        `export { updateFilesView, filesView } from './src/features/files/filesState';`,
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  });
  modules = require(outfile);
});

const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));

// The app around one project: the keeper always, the panel only while its tab is open.
function mountApp(projectPath) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const toasts = [];
  const filesHost = {
    projectPath,
    platform: 'darwin',
    showToast: (message, kind) => toasts.push({ message, kind }),
    recordUndo: () => undefined,
    referenceMove: () => undefined,
  };
  const frames = [];
  function FirstCommitProbe() {
    React.useLayoutEffect(() => {
      frames.push(snapshot(host));
    }, []);
    return undefined;
  }
  const render = (panelOpen) =>
    act(() => {
      root.render(
        create(
          React.Fragment,
          undefined,
          create(modules.FilesKeeper, { key: 'keeper', projectPath }),
          panelOpen ? create(modules.FilesPanel, { key: 'panel', host: filesHost }) : undefined,
          panelOpen ? create(FirstCommitProbe, { key: 'probe' }) : undefined,
        ),
      );
    });
  return {
    host,
    toasts,
    keep: () => render(false),
    open: () => {
      render(true);
      return frames.at(-1);
    },
    close: () => render(false),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function snapshot(host) {
  return {
    rows: [...host.querySelectorAll('[role="treeitem"] .files-name')].map((row) => row.textContent),
    skeleton: host.querySelector('.files-loading') !== null,
    retry: host.querySelector('.files-failed button') !== null,
  };
}

function reset() {
  main.disk = new Map([
    ['', ['node_modules/', 'src/', 'package.json']],
    ['src', ['pages/', 'a.ts']],
    ['src/pages', ['index.astro']],
    ['node_modules', ['astro/']],
  ]);
  main.answer = 'ok';
  main.listed = [];
  main.watched = [];
}

test('the first open draws the tree, read ahead with the folders left open and nothing else', async () => {
  reset();
  window.localStorage.setItem('stacki.files.open:/projects/one', JSON.stringify(['src']));
  const app = mountApp('/projects/one');
  app.keep();
  await settle();
  assert.deepEqual(main.listed, ['', 'src'], 'each shown folder is read once; a closed node_modules is never read');
  assert.deepEqual(main.watched, ['', 'src']);
  const first = app.open();
  assert.deepEqual(first, { rows: ['node_modules', 'src', 'pages', 'a.ts', 'package.json'], skeleton: false, retry: false });
  await settle();
  assert.deepEqual(main.listed, ['', 'src'], 'opening the panel reads nothing again');
  app.unmount();
});

test('the tree stays current while the panel is closed, and a folder opened again is read again', async () => {
  reset();
  const app = mountApp('/projects/two');
  app.open();
  await settle();
  app.close();
  await settle();
  assert.deepEqual(main.watched, [''], 'the folders are followed with the panel closed');
  main.disk.set('', ['src/', 'new.md']);
  await act(async () => main.changed.forEach((callback) => callback({ directories: [''] })));
  await settle();
  assert.deepEqual(app.open().rows, ['src', 'new.md']);
  await settle();

  const setOpen = (open) => act(() => modules.updateFilesView('/projects/two', (view) => ({ ...view, open: new Set(open) })));
  setOpen(['src']);
  await settle();
  setOpen([]);
  await settle();
  main.disk.set('src', ['b.ts']);
  setOpen(['src']);
  assert.deepEqual(snapshot(app.host).rows, ['src', 'pages', 'a.ts', 'new.md'], 'the held listing shows at once');
  await settle();
  assert.deepEqual(snapshot(app.host).rows, ['src', 'b.ts', 'new.md'], 'and is read again behind it');
  app.unmount();
});

test('another project starts on its own tree, never the last one', async (context) => {
  reset();
  // The read below is never answered; its time limit must not hold the process.
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const app = mountApp('/projects/three');
  main.answer = 'never';
  const first = app.open();
  assert.deepEqual(first.rows, [], 'no rows of another project');
  assert.equal(first.skeleton, true, 'only a first read still unanswered shows placeholders');
  app.unmount();
});

test('a rejected listing ends the placeholders with one toast and a Refresh that recovers', async () => {
  reset();
  main.answer = 'reject';
  const app = mountApp('/projects/stale');
  app.open();
  await settle();
  assert.deepEqual(snapshot(app.host), { rows: [], skeleton: false, retry: true });
  assert.deepEqual(app.toasts, [{ message: 'Couldn’t read stale', kind: 'error' }]);
  assert.equal(main.listed.length, 1, 'a failure is not retried in a loop');
  const retry = () => act(() => app.host.querySelector('.files-failed button').click());
  retry();
  await settle();
  assert.equal(app.toasts.length, 1, 'one toast per folder, not per retry');
  main.answer = 'ok';
  retry();
  await settle();
  assert.deepEqual(snapshot(app.host).rows, ['node_modules', 'src', 'package.json']);
  app.unmount();
});

test('a listing that is never answered stops waiting at its time limit', async (context) => {
  reset();
  main.answer = 'never';
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const app = mountApp('/projects/silent');
  app.open();
  act(() => context.mock.timers.tick(modules.FILES_READ_TIMEOUT_MS - 1));
  assert.equal(snapshot(app.host).skeleton, true);
  act(() => context.mock.timers.tick(1));
  assert.deepEqual(snapshot(app.host), { rows: [], skeleton: false, retry: true });
  assert.equal(app.toasts.length, 1);
  main.answer = 'ok';
  act(() => app.host.querySelector('.files-failed button').click());
  await settle();
  assert.equal(snapshot(app.host).retry, false, 'the timed-out read does not block the next one');
  app.unmount();
});

test('a root that is gone is read once, not over and over', async () => {
  reset();
  main.disk.delete('');
  const app = mountApp('/projects/gone');
  app.open();
  await settle();
  await settle();
  assert.deepEqual(main.listed, ['']);
  assert.equal(snapshot(app.host).retry, true);
  app.unmount();
});
