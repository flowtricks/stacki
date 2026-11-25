// Goal: a window that opens a project paints its REAL shell with the last session's real content in its first
// render, from the boot seed alone: no skeleton, spinner, splash or placeholder in the document, and no IPC answer
// on the path to that frame (src/app/boot, docs/startup.md).
// Method: the real App is bundled with the shell's loader and rendered synchronously (flushSync, as src/main.tsx
// does after awaiting the shell) in jsdom, with a `window.stackiBoot` seed naming a project and a snapshot whose
// page list holds a marker page. The preload bridge is a Proxy whose every call returns a promise that NEVER
// settles, so any render that waited on an IPC answer would show nothing: the marker page must be in the DOM at the
// first commit. The document is then searched for any skeleton, spinner, splash or aria-busy markup, which must be
// absent. A second render without a seed must still show the start screen with none of them. No clock is asserted.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { repoPath } = require('../../helpers/sources.js');

const MARKER = 'zzbootmarker';
const FAKE_PROJECT = path.join(path.parse(process.cwd()).root, 'stacki-boot-test', 'site');

async function bundleApp() {
  const esbuild = require('esbuild');
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'boot-first-render.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as App } from ${JSON.stringify(repoPath('src/app/App.tsx'))};
export { loadShell } from ${JSON.stringify(repoPath('src/app/shell/lazyShell.ts'))};
export { bootSeed } from ${JSON.stringify(repoPath('src/lib/bootSeed.ts'))};`,
      resolveDir: repoPath('src'),
      loader: 'ts',
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  });
  return outfile;
}

function installDom(seed) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  };
  // Node defines some of these (navigator) as getters, so each is redefined rather than assigned.
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  window.ResizeObserver = global.ResizeObserver;
  global.WebGLRenderingContext = window.WebGLRenderingContext || class {};
  global.WebGL2RenderingContext = window.WebGL2RenderingContext || class {};
  window.WebGLRenderingContext = global.WebGLRenderingContext;
  window.WebGL2RenderingContext = global.WebGL2RenderingContext;
  // eslint-disable-next-line stacki/no-null -- Stubs the platform getContext, which answers null.
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const never = () => new Promise(() => undefined);
  const bridge = new Proxy(
    { platform: 'darwin' },
    { get: (target, property) => (property in target ? target[property] : typeof property === 'string' && property.startsWith('on') ? () => () => {} : never) },
  );
  window.avb = bridge;
  global.avb = bridge;
  if (seed !== undefined) {
    window.stackiBoot = { seed, save: () => undefined, firstFrame: () => undefined };
  }
  return window;
}

const seed = {
  version: 1,
  pendingProject: FAKE_PROJECT,
  snapshots: [
    {
      version: 1,
      projectPath: FAKE_PROJECT,
      leftTab: 'pages',
      pageName: `${MARKER}.astro`,
      scan: {
        pages: [{ path: path.join(FAKE_PROJECT, 'src', 'pages', `${MARKER}.astro`), name: `${MARKER}.astro`, route: `/${MARKER}` }],
        pageFolders: [],
        layouts: [],
        components: [],
      },
    },
  ],
};

const PLACEHOLDER =
  '[aria-busy="true"], [class*="skeleton" i], [class*="spinner" i], [class*="splash" i], [data-testid*="skeleton" i], [data-testid*="spinner" i], [data-testid*="splash" i], #boot-spinner';

async function renderFirstFrame(modulePath, { seeded }) {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  // The seed is read once per page load: a fresh module copy is a fresh page.
  delete require.cache[modulePath];
  const app = require(modulePath);
  if (seeded) {
    await app.loadShell();
  }
  const root = createRoot(document.getElementById('root'));
  require('react-dom').flushSync(() => {
    root.render(React.createElement(app.App));
  });
  const html = document.getElementById('root').innerHTML;
  const placeholders = document.querySelectorAll(PLACEHOLDER).length;
  root.unmount();
  return { html, placeholders };
}

test('the first render of a window opening a project is the real shell with the real page list, though no IPC answers', async () => {
  const modulePath = await bundleApp();
  installDom(seed);
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const first = await renderFirstFrame(modulePath, { seeded: true });
    assert.ok(first.html.includes(MARKER), 'the snapshot page list is in the first commit');
    assert.equal(first.placeholders, 0, 'no skeleton, spinner, splash or busy region in the first frame');
    assert.ok(!document.getElementById('boot-spinner'), 'no boot spinner element');
    assert.deepEqual(
      errors.filter((line) => /before initialization|Error/.test(line)),
      [],
      'the first render reports no error',
    );
  } finally {
    console.error = realError;
  }
});

test('a window with nothing to reopen paints the start screen with no placeholder either', async () => {
  const modulePath = await bundleApp();
  installDom(undefined);
  const first = await renderFirstFrame(modulePath, { seeded: false });
  assert.ok(first.html.length > 0, 'something real was rendered');
  assert.ok(first.html.includes('welcome-mode'), 'it is the start screen');
  assert.equal(first.placeholders, 0);
});
