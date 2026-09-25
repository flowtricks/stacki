// Goal: loading an optional editor must keep the app and preview visible.
// Methodology: mount the real App and PreviewPane under the production root
// boundary, hold each import promise, and drive the rail and editor callbacks.
// Only loaded panel bodies are stubbed; import timing and Suspense remain real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { parsePage, serializePage } = require('../dist/electron/astroParser.js');

const PANEL_PATHS = [
  './panels/PropsPanel',
  './panels/StylePanel',
  './ui/CodeWindow',
  './panels/CmsPanel',
  './panels/CmsView',
  './panels/ContentView',
  './panels/VariablesPanel',
  './panels/VariablesView',
  './panels/CodePanel',
];
const REAL_PREVIEW = new Set([
  'PreviewPane',
  'CanvasView',
  'DevOffline',
  'PreviewOverlays',
  'PreviewToolbar',
  'PreviewSizeControls',
]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('all optional editors load without hiding the app or replacing its preview', async () => {
  const bundle = await buildApp();
  const dom = installDOM();
  const gates = createImportGates();
  global.__loadTestPanel = gates.load;
  global.__lazyPanels = {};
  window.avb = createBridge();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const App = require(bundle).default;
  const root = createRoot(document.getElementById('root'));
  const act = (action) =>
    React.act(async () => {
      await action();
      await settle();
    });
  try {
    await act(() =>
      root.render(React.createElement(React.Suspense, { fallback: null }, React.createElement(App)))
    );
    await act(() => __lazyPanels.WelcomeScreen.onOpen('/project'));
    const stable = captureEditor();
    const context = { act, gates, stable };
    assertPending(context, 'StylePanel');
    assertPending(context, 'PropsPanel');
    await releasePanel(context, 'StylePanel');
    assertPending(context, 'PropsPanel');
    await releasePanel(context, 'PropsPanel');
    await checkVariables(context);
    await checkCMS(context);
    await checkCodePanel(context);
    await checkCodeWindow(context);
    assert.equal(gates.requested.size, PANEL_PATHS.length, 'Every lazy editor was exercised');
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    delete global.__loadTestPanel;
    delete global.__lazyPanels;
  }
});

async function checkVariables(context) {
  await context.act(() => railButton(5).click());
  assertPending(context, 'VariablesPanel');
  await releasePanel(context, 'VariablesPanel');
  await context.act(() =>
    __lazyPanels.VariablesPanel.onSelect({
      file: 'src/styles/tokens.css',
      index: 0,
    })
  );
  assertPending(context, 'VariablesView');
  await releasePanel(context, 'VariablesView');
  assert.equal(__lazyPanels.VariablesView.selected.file, 'src/styles/tokens.css');
}

async function checkCodePanel(context) {
  await context.act(() => railButton(6).click());
  assertPending(context, 'CodePanel');
  await releasePanel(context, 'CodePanel');
  assert.equal(__lazyPanels.CodePanel.relativePath, 'src/pages/index.astro');
  assert.match(__lazyPanels.CodePanel.source, /<main>Content<\/main>/);
  await context.act(() => {
    const frame = document.querySelector('.frame-clip iframe');
    assert.ok(frame, 'The preview frame is available for a canvas click');
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'avb:click-node',
          path: '0',
          occurrence: 0,
          outside: false,
        },
        source: frame.contentWindow,
      })
    );
  });
  assert.ok(
    document.querySelector('[data-test-panel="CodePanel"]'),
    'canvas selection keeps the code panel open'
  );
  const changed = __lazyPanels.CodePanel.source.replace(
    '<main>Content</main>',
    '<main><h1>Changed</h1></main>'
  );
  await context.act(async () => {
    await __lazyPanels.CodePanel.onChange(changed, changed.indexOf('<h1>') + 2);
  });
  assert.equal(__lazyPanels.PropsPanel.node.name, 'h1', 'code selection reaches the inspector');
  assert.equal(
    document.querySelector('.property-saving-overlay'),
    null,
    'visual edits are enabled'
  );
  await context.act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  await context.act(() => __lazyPanels.PropsPanel.onSetContent('Visual edit'));
  await context.act(() => new Promise((resolve) => setTimeout(resolve, 350)));
  assert.match(
    __lazyPanels.CodePanel.source,
    /<h1>Visual edit<\/h1>/,
    'visual edits serialize back into the code panel'
  );
  context.stable();
}

async function checkCMS(context) {
  await context.act(() => railButton(4).click());
  assertPending(context, 'CmsPanel');
  await releasePanel(context, 'CmsPanel');
  await context.act(() => __lazyPanels.CmsPanel.onSelect('src/data/services.json'));
  assertPending(context, 'CmsView');
  await releasePanel(context, 'CmsView');
  assert.equal(__lazyPanels.CmsView.rel, 'src/data/services.json');
  await context.act(() => __lazyPanels.CmsPanel.onSelectContent('articles'));
  assertPending(context, 'ContentView');
  await releasePanel(context, 'ContentView');
  assert.equal(__lazyPanels.ContentView.name, 'articles');
  await context.act(() => __lazyPanels.ContentView.onClose());
}

async function checkCodeWindow(context) {
  await context.act(() => railButton(1).click());
  await context.act(() => __lazyPanels.StructurePanel.onSelect('frontmatter'));
  await context.act(() => __lazyPanels.PropsPanel.onOpenCode());
  assertPending(context, 'CodeWindow');
  await releasePanel(context, 'CodeWindow');
  assert.equal(__lazyPanels.CodeWindow.title, 'Frontmatter');
  await context.act(() => __lazyPanels.CodeWindow.onClose());
  context.stable();
}

function assertPending(context, name) {
  assert.ok(context.gates.requested.has(name), `${name} requested its first chunk`);
  assert.equal(document.querySelector(`[data-test-panel="${name}"]`), null);
  context.stable();
}

async function releasePanel(context, name) {
  await context.act(() => context.gates.release(name));
  assert.ok(document.querySelector(`[data-test-panel="${name}"]`), `${name} opens after loading`);
  context.stable();
}

function railButton(index) {
  const button = document.querySelectorAll('.rail-btn')[index];
  assert.ok(button, `Rail button ${index} exists`);
  return button;
}

function captureEditor() {
  const shell = document.querySelector('.app:not(.welcome-mode)');
  const frame = document.querySelector('.frame-clip iframe');
  const inspector = document.querySelector('.panel.right');
  assert.ok(shell, 'The project shell appears while the inspectors load');
  assert.ok(frame, 'The preview appears while the inspectors load');
  assert.ok(inspector, 'The inspector container appears before its chunk loads');
  const frameWindow = frame.contentWindow;
  const source = frame.src;
  return () => {
    assert.equal(document.querySelector('.app:not(.welcome-mode)'), shell);
    assert.equal(document.querySelector('.frame-clip iframe'), frame);
    assert.equal(document.querySelector('.panel.right'), inspector);
    assert.equal(frame.contentWindow, frameWindow, 'The preview document survives loading');
    assert.equal(frame.src, source, 'Loading an editor does not navigate the preview');
    assert.notEqual(shell.style.display, 'none', 'A pending editor must not hide the whole app');
    assert.notEqual(frame.style.display, 'none', 'A pending editor must not hide the preview');
  };
}

function createImportGates() {
  const requested = new Set();
  const pending = new Map();
  return {
    requested,
    load(modulePath, load) {
      assert.ok(PANEL_PATHS.includes(modulePath), `Unexpected lazy module: ${modulePath}`);
      const name = path.basename(modulePath);
      assert.equal(requested.has(name), false, `${name} should request its module once`);
      requested.add(name);
      // Nine fixed entries bound the queue, and release owns its only mutation.
      return new Promise((resolve) => pending.set(name, () => resolve(load())));
    },
    release(name) {
      const resolve = pending.get(name);
      assert.ok(resolve, `${name} has a pending import`);
      pending.delete(name);
      resolve();
    },
  };
}

async function buildApp() {
  const bundle = path.join(__dirname, '../node_modules/.stacki-test/lazy-panels.cjs');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/App.tsx')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'deferred-panel-imports',
        setup(build) {
          build.onLoad({ filter: /\/src\/App\.tsx$/ }, ({ path: filename }) => {
            const source = fs.readFileSync(filename, 'utf8');
            const contents = PANEL_PATHS.reduce((code, name) => {
              const expression = `import('${name}')`;
              assert.ok(code.includes(expression), `${name} remains a real lazy import`);
              const deferredImport = `globalThis.__loadTestPanel('${name}', () => ${expression})`;
              return code.replace(expression, deferredImport);
            }, source);
            return { contents, loader: 'tsx' };
          });
          build.onLoad({ filter: /\/src\/(?:panels\/[^/]+|ui\/CodeWindow)\.tsx$/ }, (args) => {
            const name = path.basename(args.path, '.tsx');
            if (REAL_PREVIEW.has(name)) {
              return undefined;
            }
            return { contents: panelStub(name), loader: 'tsx' };
          });
        },
      },
    ],
  });
  return bundle;
}

function panelStub(name) {
  return `
    import React from 'react';
    export const relativeTime = () => '';
    export default function Panel(props) {
      globalThis.__lazyPanels[${JSON.stringify(name)}] = props;
      return <div data-test-panel=${JSON.stringify(name)} />;
    }
  `;
}

function installDOM() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  const browserGlobals = [
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
  ];
  for (const name of browserGlobals) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

function createBridge() {
  const page = {
    name: 'index.astro',
    path: '/project/src/pages/index.astro',
    route: '/',
  };
  const source = '---\nconst title = "Home";\n---\n<main>Content</main>';
  const bridge = {
    pendingProject: async () => null,
    scanProject: async () => ({
      pages: [page],
      pageFolders: [],
      components: [],
      layouts: [],
    }),
    hasNodeModules: async () => true,
    startDevServer: async () => ({ url: 'http://localhost:4321' }),
    listProjectClasses: async () => [],
    readPage: async () => ({ ...parsePage(source, { locs: true }), source }),
    parsePageSource: async ({ source: next }) => ({
      ...parsePage(next, { locs: true }),
      source: next,
    }),
    writePage: async ({ model }) => {
      const next = serializePage(model);
      return { ok: true, ...parsePage(next, { locs: true }), source: next };
    },
    gitInfo: async () => ({ isRepo: false }),
    onCssChanged: () => () => {},
  };
  return new Proxy(bridge, {
    get(target, name) {
      if (name in target) {
        return target[name];
      }
      return String(name).startsWith('on') ? () => () => {} : async () => null;
    },
  });
}
