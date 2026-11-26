// Goal: only error toasts offer Copy; it writes the message exactly as shown, keeps the toast up, says whether the
// write worked, and says nothing about it once its moment has passed. A refused or missing clipboard is a label.
// Method: mount the real toast stack in jsdom with a stand-in clipboard and mocked timers.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');
const { installPopupDOM } = require('../../helpers/popupDom');

const CONFIRM_MS = 1500;

test('an error toast copies its message and reports how that went', async (context) => {
  const directory = repoPath('node_modules/.stacki-test/toast-copy');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = `${directory}/test.cjs`;
  await esbuild.build({
    stdin: { resolveDir: repoPath('src'), loader: 'tsx', contents: "export { ToastStack } from './features/notifications/ToastStack';" },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  installPopupDOM(window);
  const written = [];
  let refuse = false;
  const clipboard = {
    writeText: async (text) => {
      if (refuse) {
        throw new Error('Write permission denied');
      }
      written.push(text);
    },
  };
  context.mock.method(console, 'error', () => {});
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { ToastStack } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  // Replaced once React has loaded: it reads the real one as it starts.
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard } });
  const message = 'bun install failed:\n  error: EPERM';
  let dismissed = 0;
  const notices = [
    { id: 'error', kind: 'error', message },
    { id: 'info', kind: 'info', message: 'Saved' },
    { id: 'warning', kind: 'warning', message: 'Check this' },
    { id: 'success', kind: 'success', message: 'Done' },
  ];
  const shown = () => document.querySelector('.toast-copy > [data-shown="true"]').textContent;
  const click = () => act(async () => document.querySelector('.toast-copy').click());
  try {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    await act(() => root.render(React.createElement(ToastStack, { notices, dismiss: () => (dismissed += 1) })));
    assert.equal(document.querySelectorAll('.toast-copy').length, 1, 'Only the error offers Copy');
    assert.ok(document.querySelector('.toast.error .toast-copy'));
    assert.equal(shown(), 'Copy');
    assert.equal(document.querySelectorAll('.toast-copy > span').length, 3, 'Every label holds its room, so nothing shifts');

    await click();
    assert.deepEqual(written, [message]);
    assert.equal(shown(), 'Copied');
    assert.equal(dismissed, 0);

    // A second click starts the moment again.
    await act(() => context.mock.timers.tick(CONFIRM_MS - 100));
    await click();
    await act(() => context.mock.timers.tick(CONFIRM_MS - 100));
    assert.equal(shown(), 'Copied');
    await act(() => context.mock.timers.tick(100));
    assert.equal(shown(), 'Copy');

    refuse = true;
    await click();
    assert.equal(shown(), 'Copy failed');

    // A browser with no clipboard (a page served without HTTPS) fails the same way, without throwing.
    await act(() => context.mock.timers.tick(CONFIRM_MS));
    globalThis.navigator = {};
    await click();
    assert.equal(shown(), 'Copy failed');
  } finally {
    await act(() => root.unmount());
    context.mock.timers.reset();
    if (navigatorBefore === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', navigatorBefore);
    }
    dom.window.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
