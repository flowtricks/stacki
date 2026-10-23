// Goal: loading an optional editor must keep the app and preview visible.
// Methodology: mount the real App and PreviewPane under the production root
// boundary, hold each import promise, and drive the rail and editor callbacks.
// Only loaded panel bodies are stubbed; import timing and Suspense remain real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { createHash } = require('node:crypto');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const { JSDOM } = require('jsdom');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { applyCodePatch } = require('#dist/shared/engine/codePatch.js');
const { NODE_PROJECTOR } = require('#dist/electron/documents/documentDisk.js');
const { buildEditIntent } = require('#dist/electron/documents/editRequests.js');
const { toIntent } = require('#dist/shared/engine/intent.js');
const { planIntent } = require('#dist/shared/engine/planner.js');
const { applySplices, inverseEdits } = require('#dist/shared/engine/splice.js');
const { repoPath, stubPanels, stubSources } = require('../../helpers/sources.js');

// A visual edit request as main's handler applies it, on the fake's disk: the
// real translation and planner, against the bytes it names (step 9 — every
// gesture of an .astro page reaches disk this way).
function applyEditRequest(text, edit) {
  const snapshot = NODE_PROJECTOR.snapshot('/project/src/pages/index.astro', Buffer.from(text));
  const draft = buildEditIntent(edit, snapshot);
  assert.ok(draft.ok, `the edit is built (${draft.ok ? '' : draft.error})`);
  const intent = toIntent({
    id: 'lazy-panels',
    file: snapshot.path,
    authoredChecksum: snapshot.checksum,
    ...draft.value,
  });
  const planned = planIntent({ authored: snapshot, current: snapshot }, intent);
  assert.ok(planned.ok, `the edit plans (${planned.ok ? '' : planned.error})`);
  const bytes = applySplices(snapshot.bytes, planned.value.splices);
  const written = Buffer.from(bytes).toString('utf8');
  return { text: written, inverse: inverseEdits(planned.value.splices) };
}

// The editors the app loads lazily, by component name. The test reads the
// lazyPanel(() => import(…)) calls from src/app/appPanels.ts itself, so this list pins which
// editors are lazy without pinning where their files live.
const LAZY_PANELS = [
  'PropsPanel',
  'StylePanel',
  'CodeWindow',
  'CmsPanel',
  'CmsView',
  'ContentView',
  'VariablesPanel',
  'VariablesView',
  'CodePanel',
];
const LAZY_IMPORT = /lazyPanel\(\(\) => import\('([^']+)'\)\)/g;
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
      root.render(
        React.createElement(React.Suspense, { fallback: undefined }, React.createElement(App)),
      ),
    );
    await act(() => __lazyPanels.WelcomeScreen.onOpen('/project'));
    const stable = captureEditor();
    const context = { act, gates, stable, bridge: window.avb };
    assertPending(context, 'StylePanel');
    assertPending(context, 'PropsPanel');
    await releasePanel(context, 'StylePanel');
    assertPending(context, 'PropsPanel');
    await releasePanel(context, 'PropsPanel');
    await checkVariables(context);
    await checkCMS(context);
    await checkCodePanel(context);
    await checkCodeWindow(context);
    assert.equal(gates.requested.size, LAZY_PANELS.length, 'Every lazy editor was exercised');
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
    }),
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
      }),
    );
  });
  assert.ok(
    document.querySelector('[data-test-panel="CodePanel"]'),
    'canvas selection keeps the code panel open',
  );
  const changed = __lazyPanels.CodePanel.source.replace(
    '<main>Content</main>',
    '<main><h1>Changed</h1></main>',
  );
  await context.act(async () => {
    await __lazyPanels.CodePanel.onChange(changed, changed.indexOf('<h1>') + 2);
  });
  assert.equal(__lazyPanels.PropsPanel.node.name, 'h1', 'code selection reaches the inspector');
  await context.act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  assert.equal(context.bridge.codeSaves, 1, 'typed code is saved as a patch (step 8)');
  assert.equal(context.bridge.disk(), changed, 'the patch leaves exactly the typed text');
  assert.ok(
    document.querySelector('.property-saving-overlay') === null,
    'visual edits are enabled',
  );
  await context.act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  await context.act(() => __lazyPanels.PropsPanel.onSetContent('Visual edit'));
  await context.act(() => new Promise((resolve) => setTimeout(resolve, 350)));
  assert.match(
    __lazyPanels.CodePanel.source,
    /<h1>Visual edit<\/h1>/,
    'visual edits serialize back into the code panel',
  );
  const shown = __lazyPanels.CodePanel.source;
  assert.equal(context.bridge.disk(), shown, 'as the request left the disk');
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
  assert.ok(document.querySelector(`[data-test-panel="${name}"]`) === null);
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
    load(name, load) {
      assert.ok(LAZY_PANELS.includes(name), `Unexpected lazy module: ${name}`);
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
  const bundle = repoPath('node_modules/.stacki-test/lazy-panels.cjs');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  await esbuild.build({
    entryPoints: [repoPath('src/app/App.tsx')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('deferred-panel-imports', {
        'src/app/appPanels.ts': (filename) => {
          const source = fs.readFileSync(filename, 'utf8');
          const found = [...source.matchAll(LAZY_IMPORT)].map((match) => match[1]);
          const names = found.map((specifier) => path.basename(specifier));
          assert.deepEqual(names, LAZY_PANELS, 'the app loads exactly these editors lazily');
          const contents = found.reduce((code, specifier) => {
            const expression = `import('${specifier}')`;
            const name = path.basename(specifier);
            const deferredImport = `globalThis.__loadTestPanel('${name}', () => ${expression})`;
            return code.replace(expression, deferredImport);
          }, source);
          return { contents, loader: 'ts' };
        },
        'src/features/code/CodeWindow.tsx': () => ({
          contents: panelStub('CodeWindow'),
          loader: 'tsx',
        }),
      }),
      stubPanels('lazy-panel-bodies', (name) =>
        REAL_PREVIEW.has(name) ? undefined : { contents: panelStub(name), loader: 'tsx' },
      ),
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
  // One file on a fake disk: whole-model saves write it, code saves patch it.
  let disk = source;
  const onDisk = (text) => ({
    ...parsePage(text, { locs: true }),
    source: text,
    checksum: sha256(text),
  });
  const bridge = {
    disk: () => disk,
    codeSaves: 0,
    pendingProject: async () => undefined,
    scanProject: async () => ({
      pages: [page],
      pageFolders: [],
      components: [],
      layouts: [],
    }),
    startDevServer: async () => ({ url: 'http://localhost:4321' }),
    listProjectClasses: async () => [],
    // Disk replies carry the SHA-256 of the bytes, as main's do.
    readPage: async () => onDisk(disk),
    parsePageSource: async ({ source: next }) => ({
      ...parsePage(next, { locs: true }),
      source: next,
    }),
    // Typed code arrives as a patch against the checksum it was typed from;
    // a visual edit as a request main applies with the engine.
    editPage: async ({ authoredChecksum, edit }) => {
      assert.equal(authoredChecksum, sha256(disk), 'the request names the bytes on disk');
      if (edit.tag === 'code-patch') {
        disk = applyCodePatch(disk, edit.hunks);
        bridge.codeSaves += 1;
        return { ok: true, ...onDisk(disk), inverse: [] };
      }
      const applied = applyEditRequest(disk, edit);
      disk = applied.text;
      return { ok: true, ...onDisk(disk), inverse: applied.inverse };
    },
    gitInfo: async () => ({ isRepo: false }),
    publishAvailability: async () => ({ github: 'unknown', hosting: 'unconfigured' }),
    onCssChanged: () => () => {},
  };
  return new Proxy(bridge, {
    get(target, name) {
      if (name in target) {
        return target[name];
      }
      return String(name).startsWith('on') ? () => () => {} : async () => undefined;
    },
  });
}
