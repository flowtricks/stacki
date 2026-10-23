// The real App in jsdom, with stub panels that capture their props, over a
// bridge whose page reads parse real files and whose edits go through main's
// own translation and a real document host (electron/documents/documentActors.ts):
// what the step-9 and step-10 gesture suites drive. A gesture is run through a
// captured panel callback, then its save is waited for; ⌘Z is the user's undo.
// Pages are parsed by extension, as main does: .md and .mdx by the Markdown
// parser, everything else by the .astro parser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { parseMarkdownPage } = require('#dist/electron/parse/markdownParser.js');
const { createNodeDocumentActors } = require('#dist/electron/documents/documentActors.js');
const { buildEdit } = require('#dist/electron/documents/editRequests.js');
const { decodeUtf8 } = require('#dist/shared/core/span.js');
const { repoPath, stubPanels } = require('./sources.js');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
// Past the typing batch (300 ms) and the save that follows it.
const saved = () => new Promise((resolve) => setTimeout(resolve, 450));

function parsed(file, text) {
  if (/\.mdx?$/i.test(file)) {
    return parseMarkdownPage(text, { mdx: /\.mdx$/i.test(file) });
  }
  return parsePage(text, { locs: true });
}

// A panel that records its props, counts its renders and renders nothing.
const panelStub = (name) =>
  "export const relativeTime = () => ''; " +
  'export default function Panel(props) { ' +
  `globalThis.__panels[${JSON.stringify(name)}] = props; ` +
  `globalThis.__renders[${JSON.stringify(name)}] = ` +
  `(globalThis.__renders[${JSON.stringify(name)}] || 0) + 1; return null; }`;

// `options.bridge` replaces bridge calls (a bench emitting dev-server output);
// `options.wrap` wraps the app element (a bench's React Profiler).
async function mountApp(root, files, build, options = {}) {
  const directory = path.join(repoPath('node_modules/.stacki-test'), build);
  fs.mkdirSync(directory, { recursive: true });
  await esbuild.build({
    entryPoints: [repoPath('src/app/App.tsx')],
    outfile: path.join(directory, 'app.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubPanels('capture-panels', (name) => {
        return {
          contents: panelStub(name),
          loader: 'jsx',
        };
      }),
    ],
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'KeyboardEvent',
  ]) {
    global[key] = key === 'window' ? window : window[key];
  }
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.ResizeObserver = global.ResizeObserver;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  global.__panels = {};
  global.__renders = {};
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const documents = createNodeDocumentActors({
    log: () => {},
    schedule: (task) => setImmediate(task),
  });
  const calls = { edits: [] };
  const read = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    return { ...parsed(file, text), source: text, checksum: sha256(text) };
  };
  const bridge = new Proxy(
    {
      pendingProject: async () => undefined,
      scanProject: async () => files.scan,
      projectMetadata: async (input) =>
        require('#dist/electron/project/projectMetadata.js').readProjectMetadata(
          input.projectPath,
          input.kind,
        ),
      writeProjectMetadata: async (input) =>
        require('#dist/electron/project/projectMetadata.js').writeProjectMetadata(
          input.projectPath,
          input.write,
        ),
      startDevServer: async () => ({ url: 'http://localhost:4321' }),
      listProjectClasses: async () => [],
      readPage: async (file) => read(file),
      editPage: async ({ pagePath, authoredChecksum, edit }) => {
        calls.edits.push(edit.tag);
        const stated = { authoredChecksum, gone: 'anchor-moved' };
        const report = documents.submitEdit(pagePath, stated, (base) => buildEdit(edit, base));
        if (report.tag !== 'applied') {
          const error =
            report.tag === 'rejected'
              ? {
                  code: 'rejected',
                  reason: report.reason,
                  message: report.message,
                  diskChecksum: report.diskChecksum,
                }
              : { code: 'filesystem', message: report.tag };
          return { ok: false, error };
        }
        const decoded = decodeUtf8(report.bytes);
        assert.ok(decoded.ok);
        return { ok: true, ...read(pagePath), inverse: report.inverse };
      },
      importPathFor: async ({ targetPath }) => ({
        relative:
          '../' + path.relative(path.join(root, 'src'), targetPath).split(path.sep).join('/'),
        srcRelative: undefined,
      }),
      onFsChanged: () => () => {},
      gitInfo: async () => ({ isRepo: false }),
      publishAvailability: async () => ({ github: 'unknown', hosting: 'unconfigured' }),
      onCssChanged: () => () => {},
      ...options.bridge,
    },
    {
      get: (target, key) =>
        key in target
          ? target[key]
          : String(key).startsWith('on')
            ? () => () => {}
            : async () => undefined,
    },
  );
  window.avb = bridge;
  global.avb = bridge;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const reactRoot = createRoot(document.getElementById('root'));
  const App = require(path.join(directory, 'app.js')).default;
  await act(async () => {
    const element = React.createElement(App);
    reactRoot.render(options.wrap ? options.wrap(element) : element);
    await tick();
  });
  await act(async () => {
    await __panels.WelcomeScreen.onOpen(root);
    await tick();
  });
  return { act, calls, window, unmount: () => act(() => reactRoot.unmount()) };
}

// The shown node at a path of the page's model, through the navigator's props.
function nodeAt(pathSteps) {
  let list = __panels.StructurePanel.pageState.model.nodes;
  let node;
  for (const step of pathSteps) {
    node = list[step];
    assert.ok(node, `a node at ${pathSteps.join('/')}`);
    list = Array.isArray(node.children) ? node.children : [];
  }
  return node;
}

async function select(app, pathSteps) {
  await app.act(async () => {
    __panels.StructurePanel.onSelect(nodeAt(pathSteps).id);
    await tick();
  });
}

// A gesture, then its save. React commits the gesture's state when the act
// scope ends — in the app it commits before an urgent save's zero-delay timer
// fires, which is what that timer is for — so the wait is its own scope.
async function gesture(app, run) {
  await app.act(run);
  await app.act(() => saved());
}

async function undo(app) {
  await gesture(app, async () => {
    document.dispatchEvent(
      new app.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }),
    );
  });
}

module.exports = { gesture, mountApp, nodeAt, select, sha256, tick, undo };
