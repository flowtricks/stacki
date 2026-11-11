// Goal: a running app is never closed by its folder being briefly broken while an
// AI agent writes it file by file. A running app acts only on a settled folder:
// rapid writes make one reload in place (same frame element, same mode, same
// panel); a manifest broken for a moment and then valid again never closes it; a
// folder that settles broken keeps the last good version running and shows "This
// app's files have an error: … Showing the last working version." in the app's
// window until the folder is valid again; a version bump reloads in place; a list
// that cannot be read changes nothing; only a deleted folder closes the app, and
// then the Apps panel shows its list.
// Method: the pure pieces first (`settledAppFolders`, the settler with a fake
// clock, including a read a newer notice overtook). Then the real hook, the real
// AppWindows layer and the real Apps panel are mounted in JSDOM from one bundle
// (so they share the runtime and the dock slot) over a stubbed `window.avb` whose
// folder the test rewrites and whose change notices the test sends; the frame's
// reloads are counted from its `src` writes, and the DOM is read after each settle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<div id="panel"></div><div id="host"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent', 'MutationObserver']) {
  global[key] = key === 'window' ? dom.window : dom.window[key];
}
Object.defineProperty(global, 'localStorage', { configurable: true, value: dom.window.localStorage });
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.matchMedia = () => ({ matches: true });
dom.window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function close() {
  this.open = false;
};
global.IS_REACT_ACT_ENVIRONMENT = true;

const directory = repoPath('node_modules/.stacki-test/app-folder-settle');
fs.mkdirSync(directory, { recursive: true });
const outfile = path.join(directory, 'settle.cjs');
esbuild.buildSync({
  // One bundle: the hook, the windows, the panel and the runtime share their module state.
  stdin: {
    contents: [
      "export * from './src/features/apps/appFolderChanges';",
      "export { AppWindows } from './src/features/apps/AppWindows';",
      "export { default as AppsPanel } from './src/features/apps/AppsPanel';",
      "export { launchApp, resetAppsRuntime, runningApps } from './src/features/apps/appsRuntime';",
      "export { APP_FOLDER_LIMITS } from './shared/properties/appFolders';",
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
const apps = require(outfile);

const PROJECT = '/projects/site';
const APP_ID = 'feedback-pins';
const summary = (version = '1.0.0') => ({
  manifest: {
    manifestVersion: 1,
    id: APP_ID,
    name: 'Feedback pins',
    version,
    description: 'Pins and threads.',
    entry: 'index.html',
    capabilities: ['selection'],
    window: { mode: 'panel', widthPx: 360, heightPx: 640 },
    settings: [],
    secretsAllowlist: [],
  },
  lock: { id: APP_ID, version, sha256: 'a'.repeat(64), installedAt: '2026-11-10T00:00:00.000Z', source: { kind: 'local' } },
});
const BROKEN_REASON = 'stacki-app.json is not JSON: SyntaxError: Unterminated string in JSON at position 200.';

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test('a settled folder reads as valid, broken with its reason, or removed', () => {
  const reading = { apps: [summary('1.1.0')], broken: [{ folder: 'other', message: 'No manifest.' }] };
  assert.deepEqual(
    apps.settledAppFolders([APP_ID, 'other', 'gone'], reading).map((settled) => settled.kind),
    ['valid', 'broken', 'removed'],
  );
  assert.equal(apps.settledAppFolders([APP_ID], reading)[0].app.manifest.version, '1.1.0');
  assert.deepEqual(apps.settledAppFolders(['other'], reading)[0], { kind: 'broken', appId: 'other', message: 'No manifest.' });
  assert.deepEqual(apps.settledAppFolders([], reading), []);
  assert.equal(
    apps.appFolderErrorNotice('The manifest is invalid.'),
    'This app’s files have an error: The manifest is invalid. Showing the last working version.',
  );
  assert.throws(() => apps.appFolderErrorNotice(' . '), /Assertion failed: A broken folder says why/);
});

// A settler over a fake clock and a folder read the test resolves by hand.
function fakeSettler(running) {
  const timers = [];
  const reads = [];
  const applied = [];
  const settler = apps.createAppFolderSettler({
    settleMs: apps.APP_FOLDER_LIMITS.settleMs,
    schedule: (delayMs, run) => {
      assert.equal(delayMs, apps.APP_FOLDER_LIMITS.settleMs);
      const timer = { run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    running: () => running,
    read: () => new Promise((resolve) => reads.push(resolve)),
    apply: (settled) => applied.push(settled),
  });
  const fire = () => {
    const live = timers.filter((timer) => !timer.cancelled);
    assert.equal(live.length, 1, 'One settle is armed at a time');
    live[0].cancelled = true;
    live[0].run();
  };
  return { settler, timers, reads, applied, fire };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the settler waits out a burst and reads the folder once', async () => {
  const fake = fakeSettler([APP_ID]);
  for (let i = 0; i < 5; i += 1) {
    fake.settler.heard([APP_ID]);
  }
  assert.equal(fake.timers.length, 5, 'Each notice re-arms the one timer');
  assert.equal(fake.timers.filter((timer) => timer.cancelled).length, 4);
  assert.equal(fake.reads.length, 0, 'Nothing is read before the folder settles');
  fake.fire();
  assert.equal(fake.reads.length, 1);
  fake.reads[0]({ apps: [summary()], broken: [] });
  await flush();
  assert.equal(fake.applied.length, 1, 'One settle acts once');
  assert.deepEqual(
    fake.applied[0].map((settled) => settled.kind),
    ['valid'],
  );
  fake.settler.close();
});

test('a read a newer notice overtook is dropped, and the next settle acts for both', async () => {
  const fake = fakeSettler([APP_ID]);
  fake.settler.heard([APP_ID]);
  fake.fire();
  // The agent writes again while the folder is read: the broken reading is stale.
  fake.settler.heard(['unrelated']);
  fake.reads[0]({ apps: [], broken: [{ folder: APP_ID, message: 'Half written.' }] });
  await flush();
  assert.equal(fake.applied.length, 0, 'A stale reading never acts');
  fake.fire();
  fake.reads[1]({ apps: [summary()], broken: [] });
  await flush();
  assert.equal(fake.applied.length, 1, 'The running app still settles on the later reading');
  assert.equal(fake.applied[0][0].kind, 'valid');
  // An unreadable folder and a change to no running app's folder act on nothing.
  fake.settler.heard([APP_ID]);
  fake.fire();
  fake.reads[2](undefined);
  fake.settler.heard(['unrelated']);
  fake.fire();
  await flush();
  assert.equal(fake.reads.length, 3, 'A change to no running app reads nothing');
  assert.equal(fake.applied.length, 1);
  // A closed settler arms nothing.
  fake.settler.close();
  fake.settler.heard([APP_ID]);
  assert.equal(fake.timers.filter((timer) => !timer.cancelled).length, 0);
});

// ---------------------------------------------------------------------------
// The running app, end to end
// ---------------------------------------------------------------------------

// The stubbed host: the folder the test rewrites, the notices it sends, and the reads it counts.
const host = { apps: [summary()], broken: [], listOk: true, listener: undefined };
window.avb = {
  listApps: async () => (host.listOk ? { ok: true, value: host.apps } : { ok: false, message: 'The apps could not be read.' }),
  appFolders: async () => ({ ok: true, value: host.broken }),
  onAppFoldersChanged: (listener) => {
    host.listener = listener;
    return () => {
      host.listener = undefined;
    };
  },
};

function Harness() {
  apps.useAppFolderChanges(PROJECT);
  return React.createElement(apps.AppWindows, { projectPath: PROJECT, role: apps.ADMIN_VIEW });
}

const settleMs = apps.APP_FOLDER_LIMITS.settleMs;
const wait = (ms) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const notice = () => act(() => host.listener({ folders: [APP_ID] }));
const appWindow = () => document.querySelector('.apps-window');
const banner = () => appWindow()?.querySelector('.apps-folder-error') ?? undefined;

async function openApp() {
  localStorage.clear();
  apps.resetAppsRuntime();
  host.apps = [summary()];
  host.broken = [];
  host.listOk = true;
  const panelRoot = createRoot(document.getElementById('panel'));
  const hostRoot = createRoot(document.getElementById('host'));
  await act(() => hostRoot.render(React.createElement(Harness)));
  await act(() => panelRoot.render(React.createElement(apps.AppsPanel, { projectPath: PROJECT, role: apps.ADMIN_VIEW, notify: () => {} })));
  await act(() => {
    assert.equal(apps.launchApp(summary(), 'panel'), 'panel');
  });
  await wait(0);
  const frame = appWindow().querySelector('iframe');
  assert.ok(frame, 'The app frame is drawn');
  // Every `src` write is a load of the document: the first render's is not counted.
  const loads = { count: 0 };
  const observer = new MutationObserver((records) => {
    loads.count += records.filter((record) => record.attributeName === 'src').length;
  });
  observer.observe(frame, { attributes: true });
  const stillOpen = () => {
    assert.equal(apps.runningApps().length, 1, 'The app is still running');
    assert.equal(apps.runningApps()[0].mode, 'panel', 'In the same mode');
    assert.equal(appWindow().querySelector('iframe'), frame, 'In the same frame element');
    assert.ok(document.querySelector('#panel .apps-dock-slot'), 'The Apps panel still shows the app, not the list');
    assert.equal(document.querySelector('#panel .apps-header') ?? undefined, undefined);
  };
  const close = async () => {
    observer.disconnect();
    await act(() => panelRoot.unmount());
    await act(() => hostRoot.unmount());
  };
  return { loads, stillOpen, close };
}

test('rapid writes to a running app make one reload in place', async () => {
  const opened = await openApp();
  try {
    for (let i = 0; i < 6; i += 1) {
      await notice();
      await wait(Math.floor(settleMs / 5));
    }
    assert.equal(opened.loads.count, 0, 'Nothing reloads while the folder is still moving');
    await wait(settleMs + 100);
    assert.equal(opened.loads.count, 1, 'One settle, one reload');
    opened.stillOpen();
    assert.equal(banner(), undefined);
  } finally {
    await opened.close();
  }
});

test('a manifest broken for a moment, then valid, never closes the app', async () => {
  const opened = await openApp();
  try {
    host.apps = [];
    host.broken = [{ folder: APP_ID, message: BROKEN_REASON }];
    await notice();
    await wait(Math.floor(settleMs / 3));
    host.apps = [summary()];
    host.broken = [];
    await notice();
    await wait(settleMs + 100);
    opened.stillOpen();
    assert.equal(banner(), undefined, 'A transient error is never shown');
    assert.equal(opened.loads.count, 1);
  } finally {
    await opened.close();
  }
});

test('a folder that settles broken keeps the last good version and says why, until it is valid again', async () => {
  const opened = await openApp();
  try {
    host.apps = [];
    host.broken = [{ folder: APP_ID, message: BROKEN_REASON }];
    await notice();
    await wait(settleMs + 100);
    opened.stillOpen();
    assert.equal(opened.loads.count, 0, 'The last good version keeps running: a broken folder is not loaded');
    assert.equal(
      banner()?.textContent,
      'This app’s files have an error: stacki-app.json is not JSON: SyntaxError: Unterminated string in JSON at position 200. Showing the last working version.',
    );
    assert.equal(banner().getAttribute('role'), 'status', 'The notice does not block the app');
    // Fixed, with a version bump: it reloads in place on the new version and the notice clears.
    host.apps = [summary('1.1.0')];
    host.broken = [];
    await notice();
    await wait(settleMs + 100);
    opened.stillOpen();
    assert.equal(banner(), undefined);
    assert.equal(opened.loads.count, 1);
    assert.equal(apps.runningApps()[0].app.manifest.version, '1.1.0', 'The running app takes its new version');
  } finally {
    await opened.close();
  }
});

test('a list that cannot be read changes nothing; a deleted folder closes the app', async () => {
  const opened = await openApp();
  try {
    host.listOk = false;
    await notice();
    await wait(settleMs + 100);
    opened.stillOpen();
    assert.equal(opened.loads.count, 0);
    host.listOk = true;
    host.apps = [];
    host.broken = [];
    await notice();
    await wait(settleMs + 100);
    assert.equal(apps.runningApps().length, 0, 'A deleted folder closes its app');
    assert.equal(appWindow() ?? undefined, undefined);
    assert.ok(document.querySelector('#panel .apps-header'), 'The Apps panel shows its list again');
  } finally {
    await opened.close();
  }
});
