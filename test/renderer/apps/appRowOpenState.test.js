// Goal: an Installed row in the Apps panel shows that its app is open. The row of
// every running app (docked in the panel or popped out over the canvas) is marked
// `data-open="true"` with `aria-current="true"` and a status dot; the row of an app
// that is not running carries none of these.
//
// Methodology: the real `AppRow` is mounted in JSDOM from one bundle with the real
// runtime store. The store is driven with `launchApp` and `stopApp`, and the DOM is
// read right after each act(), so a missing live subscription shows as a stale row.
// Negative space: nothing running, an app closed again, a different app running,
// and clicking an open row calling `launchApp` again, which must keep one window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) {
  global[key] = key === 'window' ? dom.window : dom.window[key];
}
Object.defineProperty(global, 'localStorage', { configurable: true, value: dom.window.localStorage });
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.matchMedia = () => ({ matches: true });
global.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
// No main process here: every bridge call waits forever, and every subscription is a no-op.
dom.window.avb = new Proxy({}, { get: (_target, name) => (String(name).startsWith('on') ? () => noop : () => new Promise(noop)) });

const directory = repoPath('node_modules/.stacki-test/app-row-open-state');
fs.mkdirSync(directory, { recursive: true });
const outfile = path.join(directory, 'row.cjs');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { AppRow } from './src/features/apps/AppsPanel';",
      "export { launchApp, stopApp, resetAppsRuntime, runningApps } from './src/features/apps/appsRuntime';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const apps = require(outfile);

const summary = (id, name) => ({
  manifest: {
    manifestVersion: 1,
    id,
    name,
    version: '1.0.0',
    description: 'Test app.',
    entry: 'index.html',
    capabilities: ['selection'],
    window: { mode: 'popup', widthPx: 360, heightPx: 640 },
    settings: [],
    secretsAllowlist: [],
  },
  lock: { id, version: '1.0.0', sha256: 'a'.repeat(64), installedAt: '2026-11-10T00:00:00.000Z', source: { kind: 'local' } },
});
const FEEDBACK = summary('feedback-pins', 'Feedback pins');
const LUMOS = summary('lumos-fluid-builder', 'Lumos Fluid Builder');
const opened = [];
const actions = {
  admin: true,
  busy: false,
  projectPath: '/p',
  share: noop,
  submit: () => noop,
  open: (app) => {
    opened.push(app.manifest.id);
    apps.launchApp(app, 'popup');
  },
  showDetails: noop,
  setAutoUpdate: noop,
  update: noop,
  uninstall: noop,
};

async function mount() {
  apps.resetAppsRuntime();
  opened.length = 0;
  const root = createRoot(document.getElementById('host'));
  await act(() =>
    root.render(
      React.createElement(
        'ul',
        { className: 'apps-list' },
        [FEEDBACK, LUMOS].map((app) => React.createElement(AppRowOf, { key: app.manifest.id, app })),
      ),
    ),
  );
  return root;
}
const AppRowOf = ({ app }) => React.createElement(apps.AppRow, { app, avatar: undefined, actions });
const rowOf = (name) => [...document.querySelectorAll('.apps-row')].find((row) => row.textContent.includes(name));
const isOpen = (name) => {
  const main = rowOf(name).querySelector('.apps-row-main');
  const select = rowOf(name).querySelector('.apps-row-select');
  const dot = rowOf(name).querySelector('.apps-row-open-dot') !== null;
  const marked = main.getAttribute('data-open') === 'true';
  assert.equal(select.getAttribute('aria-current') === 'true', marked, 'The accessible state follows the highlight');
  assert.equal(dot, marked, 'The dot follows the highlight');
  return marked;
};

test('no app running: no row is highlighted', async () => {
  const root = await mount();
  assert.equal(isOpen('Feedback pins'), false);
  assert.equal(isOpen('Lumos Fluid Builder'), false);
  assert.equal(rowOf('Lumos Fluid Builder').querySelector('.apps-row-select').hasAttribute('aria-current'), false);
  await act(() => root.unmount());
});

test('an open app highlights only its row, and closing removes it at once', async () => {
  const root = await mount();
  await act(() => apps.launchApp(LUMOS, 'popup'));
  assert.equal(isOpen('Lumos Fluid Builder'), true);
  assert.equal(isOpen('Feedback pins'), false);
  await act(() => apps.stopApp(LUMOS.manifest.id));
  assert.equal(isOpen('Lumos Fluid Builder'), false);
  await act(() => root.unmount());
});

test('two open apps highlight both rows, docked or popped out', async () => {
  const root = await mount();
  await act(() => {
    apps.launchApp(FEEDBACK, 'panel');
    apps.launchApp(LUMOS, 'popup');
  });
  assert.equal(isOpen('Feedback pins'), true);
  assert.equal(isOpen('Lumos Fluid Builder'), true);
  await act(() => apps.stopApp(FEEDBACK.manifest.id));
  assert.equal(isOpen('Feedback pins'), false);
  assert.equal(isOpen('Lumos Fluid Builder'), true);
  await act(() => root.unmount());
});

test('clicking an open row keeps one window for the app', async () => {
  const root = await mount();
  const select = () => rowOf('Lumos Fluid Builder').querySelector('.apps-row-select');
  await act(() => select().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await act(() => select().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(opened, ['lumos-fluid-builder', 'lumos-fluid-builder']);
  assert.equal(apps.runningApps().length, 1, 'The second click does not start a second copy');
  assert.equal(isOpen('Lumos Fluid Builder'), true);
  await act(() => root.unmount());
});
