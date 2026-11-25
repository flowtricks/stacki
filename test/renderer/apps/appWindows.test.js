// Goal: an app docks in the side panel or pops out into the Variables window's
// popup, keeping its one frame (so it keeps running with its state) across both
// modes and across rail panel switches. The user's last mode, panel width and
// popup rectangle are remembered per project and app and win over the manifest's
// `window` defaults; a docked app asks for its panel width through the panel's own
// width store and releases it when it pops out, hides or closes.
// Method: the stored-preference parsers get known-good and known-bad values; then
// the real AppWindows layer and the Apps panel's dock slot are mounted in JSDOM
// from one bundle (so they share the runtime, the slot and the width store), the
// dock toggle is clicked, and the DOM, the iframe's identity, local storage and
// the requested panel width are read after each step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<div id="panel"></div><div id="host"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent']) {
  global[key] = key === 'window' ? dom.window : dom.window[key];
}
Object.defineProperty(global, 'localStorage', { configurable: true, value: dom.window.localStorage });
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.matchMedia = () => ({ matches: true });
global.IS_REACT_ACT_ENVIRONMENT = true;

const directory = repoPath('node_modules/.stacki-test/app-windows');
fs.mkdirSync(directory, { recursive: true });
const outfile = path.join(directory, 'windows.cjs');
esbuild.buildSync({
  // One bundle: the windows, the panel's slot, the runtime and the width store share their module state.
  stdin: {
    contents: [
      "export { AppWindows, AppDockSlot } from './src/features/apps/AppWindows';",
      "export * from './src/features/apps/appWindowPreferences';",
      "export { launchApp, setAppMode, stopApp, resetAppsRuntime, runningApps } from './src/features/apps/appsRuntime';",
      "export { setAppsPanelReveal } from './src/features/apps/appsDirectory';",
      "export { requestedPanelWidth } from './src/ui/panelWidthRequests';",
      "export { ADMIN_VIEW } from './shared/properties/projectRoles';",
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
const windows = require(outfile);

const PROJECT = '/projects/site';
const summary = (id, placement) => ({
  manifest: {
    manifestVersion: 1,
    id,
    name: `App ${id}`,
    version: '1.0.0',
    description: '',
    icon: undefined,
    entry: 'index.html',
    window: placement,
    source: undefined,
    authorGitHub: undefined,
    settings: [],
    secretsAllowlist: [],
  },
  lock: { id, version: '1.0.0', sha256: 'a'.repeat(64), installedAt: '2026-11-10T00:00:00.000Z', source: { kind: 'file', fileName: `${id}.zip` } },
});

test('stored modes and widths parse only known values within the manifest bounds', () => {
  assert.equal(windows.parseStoredAppWindowMode('panel'), 'panel');
  assert.equal(windows.parseStoredAppWindowMode('popup'), 'popup');
  for (const bad of [undefined, 'floating', 'docked', '', 'popup '.repeat(10), 1]) {
    assert.equal(windows.parseStoredAppWindowMode(bad), undefined, String(bad));
  }
  assert.equal(windows.parseStoredAppPanelWidth('240'), 240);
  assert.equal(windows.parseStoredAppPanelWidth('1600'), 1600);
  for (const bad of [undefined, '', '239', '1601', '300.5', 'NaN', '-300', '12345', 300]) {
    assert.equal(windows.parseStoredAppPanelWidth(bad), undefined, String(bad));
  }
  assert.equal(windows.dockModeOf('panel'), 'docked');
  assert.equal(windows.dockModeOf('popup'), 'floating');
  assert.equal(windows.appModeOf('docked'), 'panel');
  assert.equal(windows.appModeOf('floating'), 'popup');
  assert.throws(() => windows.appWindowStorageKey('', 'a'), /names its project/);
  assert.throws(() => windows.appWindowStorageKey(PROJECT, ''), /names its app/);
});

test('the opening mode and panel width are the user choice per project, else the manifest', () => {
  localStorage.clear();
  const app = summary('notes', { mode: 'popup', widthPx: 420, heightPx: undefined });
  assert.equal(windows.appOpeningMode(PROJECT, app), 'popup', 'The manifest mode applies first');
  assert.equal(windows.appPanelWidth(PROJECT, app), 420, 'The manifest width applies first');
  windows.storeAppWindowMode(PROJECT, 'notes', 'panel');
  windows.storeAppPanelWidth(PROJECT, 'notes', 333);
  assert.equal(windows.appOpeningMode(PROJECT, app), 'panel', 'The remembered mode wins');
  assert.equal(windows.appPanelWidth(PROJECT, app), 333, "The user's resize wins over the manifest width");
  assert.equal(windows.appOpeningMode('/projects/other', app), 'popup', 'Another project keeps the manifest mode');
  assert.equal(windows.appPanelWidth('/projects/other', app), 420);
  assert.equal(windows.appPanelWidth(PROJECT, summary('bare', { mode: 'panel', widthPx: undefined, heightPx: undefined })), undefined);
  localStorage.setItem(`${windows.appWindowStorageKey(PROJECT, 'notes')}.mode`, 'sideways');
  assert.equal(windows.appOpeningMode(PROJECT, app), 'popup', 'A corrupt stored mode falls back to the manifest');
  assert.throws(() => windows.storeAppPanelWidth(PROJECT, 'notes', 9000), /valid manifest width/);
});

test('docking and popping out keep one frame, request the panel width, and remember the mode', async () => {
  localStorage.clear();
  windows.resetAppsRuntime();
  const reveals = [];
  windows.setAppsPanelReveal(() => reveals.push('apps'));
  const panelRoot = createRoot(document.getElementById('panel'));
  const hostRoot = createRoot(document.getElementById('host'));
  const app = summary('heat', { mode: 'panel', widthPx: 420, heightPx: 300 });
  const appWindow = () => document.querySelector('.apps-window');
  const toggle = () =>
    act(() =>
      appWindow()
        .querySelector('.dockable-window-toggle')
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
  try {
    await act(() => hostRoot.render(React.createElement(windows.AppWindows, { projectPath: PROJECT, role: windows.ADMIN_VIEW })));
    await act(() => panelRoot.render(React.createElement(windows.AppDockSlot)));
    await act(() => {
      assert.equal(windows.launchApp(app, windows.appOpeningMode(PROJECT, app)), 'panel');
    });
    const frame = appWindow().querySelector('iframe');
    assert.ok(frame, 'The app frame is drawn');
    assert.equal(appWindow().dataset.windowMode, 'docked');
    assert.equal(appWindow().hidden, false, 'A docked app shows over the Apps panel slot');
    assert.equal(windows.requestedPanelWidth('left'), 420, "A docked app asks for its manifest's panel width");

    await toggle();
    assert.equal(appWindow().dataset.windowMode, 'floating', 'The toggle pops the app out');
    assert.equal(appWindow().querySelector('iframe'), frame, 'Popping out keeps the same frame, so the app keeps running');
    assert.equal(appWindow().style.width, '420px', 'The popup opens at the manifest width');
    assert.equal(appWindow().style.height, '300px', 'The popup opens at the manifest height');
    assert.equal(windows.requestedPanelWidth('left'), undefined, "A popped-out app releases the panel to the user's width");
    assert.equal(windows.runningApps()[0].mode, 'popup');
    assert.equal(windows.appOpeningMode(PROJECT, app), 'popup', 'The mode is remembered for this project');

    // Another rail panel: the slot unmounts. The popup stays up and running.
    await act(() => panelRoot.render(undefined));
    assert.equal(appWindow().hidden, false, 'A popup survives a rail panel switch');
    assert.equal(appWindow().querySelector('iframe'), frame);

    await act(() => panelRoot.render(React.createElement(windows.AppDockSlot)));
    await toggle();
    assert.equal(appWindow().dataset.windowMode, 'docked', 'The toggle docks the app back');
    assert.deepEqual(reveals, ['apps'], 'Docking reveals the Apps panel, as Variables does');
    assert.equal(appWindow().querySelector('iframe'), frame, 'Docking keeps the same frame');
    assert.equal(windows.requestedPanelWidth('left'), 420);
    assert.equal(windows.appOpeningMode(PROJECT, app), 'panel');

    // A docked app hides with its panel and keeps running; the panel width returns to the user's.
    await act(() => panelRoot.render(undefined));
    assert.equal(appWindow().hidden, true, 'A docked app hides while another rail panel shows');
    assert.equal(appWindow().querySelector('iframe'), frame, 'A hidden docked app keeps its frame');
    assert.equal(windows.requestedPanelWidth('left'), undefined);

    await act(() => panelRoot.render(React.createElement(windows.AppDockSlot)));
    // The header reads tile, name, dock toggle, then Close at the far right.
    const headerButtons = [...appWindow().querySelectorAll('.dockable-window-header button')];
    assert.equal(headerButtons.at(-1)?.getAttribute('aria-label'), 'Close App heat', 'Close ends the header');
    assert.equal(headerButtons.at(-2)?.classList.contains('dockable-window-toggle'), true, 'the dock toggle sits just left of Close');
    await act(() =>
      appWindow()
        .querySelector('[aria-label="Close App heat"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    assert.equal(appWindow() ?? undefined, undefined, 'Close stops the app');
    assert.equal(windows.requestedPanelWidth('left'), undefined, 'Closing releases the panel width');
    assert.equal(windows.setAppMode('heat', 'popup'), false, 'A stopped app has no mode to change');
  } finally {
    await act(() => panelRoot.unmount());
    await act(() => hostRoot.unmount());
    windows.setAppsPanelReveal(undefined);
    windows.resetAppsRuntime();
  }
});

test('a popup app opens popped out at the default size and relaunching keeps its current mode', async () => {
  localStorage.clear();
  windows.resetAppsRuntime();
  const hostRoot = createRoot(document.getElementById('host'));
  const app = summary('palette', { mode: 'popup', widthPx: undefined, heightPx: undefined });
  try {
    await act(() => hostRoot.render(React.createElement(windows.AppWindows, { projectPath: PROJECT, role: windows.ADMIN_VIEW })));
    await act(() => {
      windows.launchApp(app, windows.appOpeningMode(PROJECT, app));
    });
    const appWindow = document.querySelector('.apps-window');
    assert.equal(appWindow.dataset.windowMode, 'floating');
    assert.equal(appWindow.style.width, '360px', 'The default popup width');
    assert.equal(appWindow.style.height, '480px', 'The default popup height');
    assert.equal(windows.requestedPanelWidth('left'), undefined, 'A popup asks for no panel width');
    await act(() => {
      assert.equal(windows.launchApp(app, 'panel'), 'popup', 'Opening a running app keeps the mode it has');
    });
  } finally {
    await act(() => hostRoot.unmount());
    windows.resetAppsRuntime();
  }
});
