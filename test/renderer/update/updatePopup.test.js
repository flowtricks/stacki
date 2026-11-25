// Goal: the update popup shows the download's progress live (bar width, percent, megabyte counter), swaps to Restart now / Later when
// the download finishes, answers the File menu's check and a failed download inside the app, and never opens a native dialog.
// Method: the real popup and its state hook are bundled and mounted in jsdom with a fake bridge. Events are injected by calling the
// subscriber the hook registered, so no timer or sleep is involved; each assertion reads the DOM after the event has been applied.
// Negative space: hiding survives progress ticks but not news, an event beating the first read is not overwritten by it, an unknown
// total shows bytes without a percent, and a bridge that refuses is logged, not thrown into the render.
// A failed download's cause is a toast, never a line in the dialog (owner rule).
// The look of the up-to-date state (icon, headline, version, one primary button, no outline or divider, dialog role with a name,
// focus on the button, Escape closes) is pinned here; updateLookChromium.test.js reads the real computed styles and Enter.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { toastMessages } = require('../../helpers/toastCapture.js');
const { installPopupDOM } = require('../../helpers/popupDom');

const directory = repoPath('node_modules/.stacki-test/update-popup');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'popup.cjs');
buildSync({
  stdin: { contents: "export { UpdatePopup, UpdatePopupHost } from './src/features/update/UpdatePopup';", resolveDir: repoPath('.'), loader: 'ts' },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  jsx: 'automatic',
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
});

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true });
installPopupDOM(dom.window);
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(global, key, { value: key === 'window' ? dom.window : dom.window[key], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { UpdatePopup, UpdatePopupHost } = require(bundle);

const MEGABYTE = 1024 * 1024;
const downloading = (transferredMb, totalMb, version = '1.4.10') => {
  const transferredBytes = Math.round(transferredMb * MEGABYTE);
  const totalBytes = totalMb === undefined ? undefined : Math.round(totalMb * MEGABYTE);
  return {
    kind: 'downloading',
    version,
    progress: { transferredBytes, totalBytes, percent: totalBytes === undefined ? 0 : Math.floor((transferredBytes * 100) / totalBytes) },
  };
};

function fakeBridge({ initial = { kind: 'idle' }, readFails = false } = {}) {
  const bridge = {
    listeners: new Set(),
    actions: [],
    resolveRead: undefined,
    read: () => (readFails ? Promise.reject(new Error('refused')) : new Promise((resolve) => (bridge.resolveRead = () => resolve(initial)))),
    subscribe: (callback) => {
      bridge.listeners.add(callback);
      return () => bridge.listeners.delete(callback);
    },
    act: (action) => {
      bridge.actions.push(action);
      return Promise.resolve();
    },
    emit: (state, reveal = true) => bridge.listeners.forEach((listener) => listener({ state, reveal })),
  };
  return bridge;
}

async function mount(element) {
  globalThis.stackiCapturedToasts = [];
  document.getElementById('root').innerHTML = '';
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  return { root, unmount: () => act(async () => root.unmount()) };
}

const present = (selector) => document.querySelector(selector) !== null;
const text = (selector) => document.querySelector(selector)?.textContent;
const bar = () => document.querySelector('[role="progressbar"]');
const buttons = () => [...document.querySelectorAll('.popup-surface button')].map((button) => button.textContent);

test('progress events update the bar, the percent and the megabyte counter live', async () => {
  const bridge = fakeBridge();
  const { unmount } = await mount(React.createElement(UpdatePopupHost, { bridge }));
  assert.equal(present('.popup-surface'), false, 'idle shows nothing');

  await act(async () => bridge.emit(downloading(0, 52.4)));
  assert.equal(text('.modal-header'), 'Downloading Stacki 1.4.10');
  assert.equal(bar().getAttribute('aria-valuenow'), '0', 'the bar is on screen at 0% from the first frame');
  assert.equal(text('.update-bytes'), '0.0 of 52.4 MB');

  await act(async () => bridge.emit(downloading(48.2, 52.4), false));
  assert.equal(text('.update-percent'), '91%');
  assert.equal(text('.update-bytes'), '48.2 of 52.4 MB');
  assert.equal(bar().getAttribute('aria-valuenow'), '91');
  assert.equal(document.querySelector('.update-bar-fill').style.width, '91%');
  assert.deepEqual(buttons(), ['Hide']);
  assert.match(text('.update-body'), /asked whether to restart/);
  await unmount();
});

test('an unknown total shows the bytes in and no percent', async () => {
  const bridge = fakeBridge();
  const { unmount } = await mount(React.createElement(UpdatePopupHost, { bridge }));
  await act(async () => bridge.emit({ kind: 'downloading', version: undefined, progress: downloading(5, undefined).progress }));
  assert.equal(text('.modal-header'), 'Downloading the Stacki update');
  assert.equal(text('.update-bytes'), '5.0 MB downloaded');
  assert.equal(bar().hasAttribute('aria-valuenow'), false, 'an unknown amount is not claimed as 0%');
  assert.equal(document.querySelector('.update-bar-fill').style.width, '0%');
  await unmount();
});

test('hide keeps the download going; ticks leave it hidden and news brings it back', async () => {
  const bridge = fakeBridge();
  const { unmount } = await mount(React.createElement(UpdatePopupHost, { bridge }));
  await act(async () => bridge.emit(downloading(10, 50)));
  await act(async () => document.querySelector('.popup-surface button').click());
  assert.equal(present('.popup-surface'), false, 'Hide closes it');
  assert.deepEqual(bridge.actions, [], 'hiding asks main for nothing: the download carries on');

  await act(async () => bridge.emit(downloading(20, 50), false));
  assert.equal(present('.popup-surface'), false, 'a tick does not reopen it');

  await act(async () => bridge.emit(downloading(21, 50), true));
  assert.ok(present('.popup-surface'), 'a File menu check reopens it');
  await unmount();
});

test('a finished download offers Restart now and Later; Restart asks main to install', async () => {
  const bridge = fakeBridge();
  const { unmount } = await mount(React.createElement(UpdatePopupHost, { bridge }));
  await act(async () => bridge.emit(downloading(50, 50)));
  await act(async () => bridge.emit({ kind: 'ready', version: '1.4.10' }));
  assert.equal(text('.modal-header'), 'Stacki 1.4.10 is ready');
  assert.deepEqual(buttons(), ['Later', 'Restart Now']);

  await act(async () => [...document.querySelectorAll('.popup-surface button')][1].click());
  assert.deepEqual(bridge.actions, ['install']);
  assert.equal(present('.popup-surface'), false);
  await unmount();
});

test('Later closes without installing, and the menu check brings the question back', async () => {
  const bridge = fakeBridge();
  const { unmount } = await mount(React.createElement(UpdatePopupHost, { bridge }));
  await act(async () => bridge.emit({ kind: 'ready', version: '1.4.10' }));
  await act(async () => [...document.querySelectorAll('.popup-surface button')][0].click());
  assert.deepEqual(bridge.actions, []);
  assert.equal(present('.popup-surface'), false);
  await act(async () => bridge.emit({ kind: 'ready', version: '1.4.10' }));
  assert.ok(present('.popup-surface'));
  await unmount();
});

test('a failed download shows a custom error with Retry and Close, and Retry asks main to check again', async () => {
  const bridge = fakeBridge();
  const { unmount } = await mount(React.createElement(UpdatePopupHost, { bridge }));
  await act(async () => bridge.emit({ kind: 'error', stage: 'download', detail: 'Error: net::ERR_CONNECTION_CLOSED' }));
  assert.match(text('.modal-body'), /could not be downloaded/);
  assert.match(toastMessages(), /ERR_CONNECTION_CLOSED/, 'the cause is a toast');
  assert.equal(present('.update-error-detail'), false, 'and no line is appended to the dialog');
  assert.deepEqual(buttons(), ['Close', 'Retry']);
  await act(async () => [...document.querySelectorAll('.popup-surface button')][1].click());
  assert.deepEqual(bridge.actions, ['retry']);

  await act(async () => bridge.emit({ kind: 'error', stage: 'check', detail: '' }));
  assert.match(text('.modal-body'), /could not check for updates/);
  assert.equal(toastMessages().includes('could not check'), false, 'no empty detail toast');
  await unmount();
});

test('the File menu answers show as notices, each one again when asked twice', async () => {
  const bridge = fakeBridge();
  const { unmount } = await mount(React.createElement(UpdatePopupHost, { bridge }));
  await act(async () => bridge.emit({ kind: 'notice', notice: 'latest', version: '1.4.9' }));
  assert.equal(text('.modal-header'), 'You’re up to date', 'the answer is the headline');
  assert.equal(text('.modal-body'), 'Stacki 1.4.9 is the latest version.', 'the version is the secondary line');
  await act(async () => document.querySelector('.popup-surface button').click());
  assert.equal(present('.popup-surface'), false);
  await act(async () => bridge.emit({ kind: 'notice', notice: 'development', version: '1.4.9' }));
  assert.match(text('.modal-body'), /only checked in the installed app/);
  assert.match(text('.modal-body'), /development build \(1\.4\.9\)/);
  await unmount();
});

test('the first read seeds the popup, but never overwrites an event that beat it', async () => {
  const seeded = fakeBridge({ initial: downloading(10, 50) });
  let view = await mount(React.createElement(UpdatePopupHost, { bridge: seeded }));
  await act(async () => seeded.resolveRead());
  assert.equal(text('.update-percent'), '20%', "a window opened mid-download starts from main's state");
  await view.unmount();

  const raced = fakeBridge({ initial: downloading(10, 50) });
  view = await mount(React.createElement(UpdatePopupHost, { bridge: raced }));
  await act(async () => raced.emit(downloading(40, 50), false));
  await act(async () => raced.resolveRead());
  assert.equal(text('.update-percent'), '80%', 'the older read does not move the bar back');
  await view.unmount();
});

test('a bridge that refuses is logged, not thrown into the render', async () => {
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const bridge = fakeBridge({ readFails: true });
    const { unmount } = await mount(React.createElement(UpdatePopupHost, { bridge }));
    await act(async () => undefined);
    assert.ok(logged.some((line) => line.includes('could not be read')));
    assert.equal(present('.popup-surface'), false);
    await unmount();
  } finally {
    console.error = realError;
  }
});

test('the popup is a pure view of a state, so any state can be shown on demand', async () => {
  const states = [
    [downloading(12.5, 40), 'Downloading Stacki 1.4.10'],
    [{ kind: 'ready', version: '2.0.0' }, 'Stacki 2.0.0 is ready'],
  ];
  for (const [state, header] of states) {
    const { unmount } = await mount(React.createElement(UpdatePopup, { state, hidden: false, onHide: () => undefined, onAct: () => undefined }));
    assert.equal(text('.modal-header'), header);
    await unmount();
  }
  const { unmount } = await mount(
    React.createElement(UpdatePopup, { state: { kind: 'idle' }, hidden: false, onHide: () => undefined, onAct: () => undefined }),
  );
  assert.equal(present('.popup-surface'), false);
  await unmount();
});

const ACTIVE_STATES = [
  [downloading(12.5, 40), 'downloading'],
  [{ kind: 'ready', version: '2.0.0' }, 'ready'],
  [{ kind: 'error', stage: 'download', detail: 'boom' }, 'error'],
  [{ kind: 'notice', notice: 'latest', version: '1.4.11' }, 'latest'],
  [{ kind: 'notice', notice: 'development', version: '1.4.11' }, 'development'],
  [{ kind: 'notice', notice: 'alreadyChecking', version: '1.4.11' }, 'alreadyChecking'],
];

test('every state wears the same shape: a tinted icon, a headline, and at least one button', async () => {
  for (const [state, name] of ACTIVE_STATES) {
    const { unmount } = await mount(React.createElement(UpdatePopup, { state, hidden: false, onHide: () => undefined, onAct: () => undefined }));
    assert.ok(present('.update-header .update-icon svg[data-central-icon]'), `${name}: the icon comes from the Central set`);
    assert.ok(text('.update-title').length > 0, `${name}: a headline`);
    assert.ok(buttons().length >= 1, `${name}: a button`);
    await unmount();
  }
});

test('up to date: a check icon, the headline, the version, and one primary Close button that has focus', async () => {
  const { unmount } = await mount(
    React.createElement(UpdatePopup, {
      state: { kind: 'notice', notice: 'latest', version: '1.4.11' },
      hidden: false,
      onHide: () => undefined,
      onAct: () => undefined,
    }),
  );
  assert.equal(document.querySelector('.update-icon svg').getAttribute('data-central-icon'), 'check');
  assert.equal(document.querySelector('.update-icon').className.includes('update-icon-accent'), true, 'tinted with the accent, not a grey');
  assert.equal(text('.update-title'), 'You’re up to date');
  assert.equal(text('.modal-body'), 'Stacki 1.4.11 is the latest version.');
  const [only, ...rest] = [...document.querySelectorAll('.popup-surface button')];
  assert.equal(rest.length, 0, 'one button');
  assert.equal(only.textContent, 'Close');
  assert.ok(only.classList.contains('primary'), 'the button is the blue primary');
  assert.equal(document.activeElement, only, 'focus lands on the button, so Enter presses it');
  await unmount();
});

test('the popup is a dialog named by its headline, and an error is red-tinted, not accent', async () => {
  const { unmount } = await mount(
    React.createElement(UpdatePopup, {
      state: { kind: 'notice', notice: 'latest', version: '1.4.11' },
      hidden: false,
      onHide: () => undefined,
      onAct: () => undefined,
    }),
  );
  const dialog = document.querySelector('dialog');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  const labelId = dialog.getAttribute('aria-labelledby');
  assert.ok(labelId && labelId.length > 0, 'the dialog names itself');
  assert.equal(document.getElementById(labelId).textContent, 'You’re up to date');
  await unmount();
  const view = await mount(
    React.createElement(UpdatePopup, { state: { kind: 'error', stage: 'check', detail: '' }, hidden: false, onHide: () => undefined, onAct: () => undefined }),
  );
  assert.ok(document.querySelector('.update-icon').classList.contains('update-icon-danger'));
  await view.unmount();
});

test('Escape closes the up-to-date popup without asking main for anything', async () => {
  const bridge = fakeBridge();
  const { unmount } = await mount(React.createElement(UpdatePopupHost, { bridge }));
  await act(async () => bridge.emit({ kind: 'notice', notice: 'latest', version: '1.4.11' }));
  assert.ok(present('.popup-surface'));
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(present('.popup-surface'), false, 'Escape closes it');
  assert.deepEqual(bridge.actions, []);
  await unmount();
});

test('the stylesheet draws no outline round the dialog and no rule above the buttons, and uses logical padding', () => {
  const css = fs.readFileSync(repoPath('src/features/update/updatePopup.css'), 'utf8');
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `${selector} is styled`);
    return css.slice(start, css.indexOf('}', start));
  };
  assert.match(rule('.modal.update-popup'), /border:\s*none/, 'no outline round the dialog');
  assert.match(rule('.update-popup .modal-footer'), /border-top:\s*none/, 'no divider above the buttons');
  assert.doesNotMatch(css, /border(?!-radius)[a-z-]*:\s*(?!none)[^;]*\d/, 'no rule in the sheet draws a border');
  assert.doesNotMatch(css, /(?:^|[\s;{])(?:margin|padding|border)-(?:left|right)\s*:/m, 'physical sides would break a right-to-left layout');
});
