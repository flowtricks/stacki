// Goal: errors appear once in the global stack, remain usable over modals, and clear stale retries.
// Method: mount the real toast owner, error-state bridge and native-dialog wrapper in jsdom;
// exercise rerenders, recovery failures, nested modal transitions, and the bounded early queue.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');
const { installPopupDOM } = require('../../helpers/popupDom');

test('errors are toasts only, including within modal forms and during recovery', async () => {
  const directory = repoPath('node_modules/.stacki-test/error-toasts');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'test.cjs');
  await esbuild.build({
    stdin: {
      resolveDir: repoPath('src'),
      loader: 'tsx',
      contents: `
    export { ErrorToast } from './ui/ErrorToast';
    export { reportErrorToast, useErrorToasts } from './ui/errorNotices';
    export { useToastStack } from './features/notifications/useToastStack';
    export { ToastStack } from './features/notifications/ToastStack';
    export { default as Popup } from './ui/Popup';
  `,
    },
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
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { ErrorToast, reportErrorToast, useErrorToasts, useToastStack, ToastStack, Popup } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  let attempts = 0;
  let closes = 0;
  function App({ message, modal, version = 1 }) {
    const stack = useToastStack();
    useErrorToasts(stack.push, stack.dismiss);
    const content = React.createElement(
      'div',
      { className: 'tested-panel' },
      React.createElement('input', { 'aria-label': 'Name' }),
      React.createElement(ErrorToast, {
        message,
        recovery: [
          {
            label: 'Retry',
            run: () => {
              attempts = version;
              if (version === 3) {
                throw new Error('Retry failed');
              }
            },
          },
        ],
      }),
    );
    return React.createElement(
      React.Fragment,
      undefined,
      modal
        ? React.createElement(
            Popup,
            {
              onClose: () => {
                closes += 1;
              },
            },
            content,
          )
        : content,
      React.createElement(ToastStack, { notices: stack.notices, dismiss: stack.dismiss }),
    );
  }
  const render = (props) => act(() => root.render(React.createElement(App, props)));
  try {
    for (let index = 0; index < 8; index += 1) {
      reportErrorToast(`Early ${index}`);
    }
    await render({ modal: false });
    assert.equal(document.querySelectorAll('.toast').length, 5, 'Early errors are bounded');
    assert.match(document.querySelector('.toast').textContent, /Early 7/);
    await render({ message: 'Could not save the name', modal: true });
    const dialog = document.querySelector('dialog');
    assert.ok(dialog.open);
    assert.equal(document.querySelector('.tested-panel').textContent, '', 'No inline error');
    assert.ok(dialog.querySelector('.toast.error'), 'Native modal owns the visible toast');
    const id = dialog.querySelector('.toast-slot').dataset.toastId;
    await render({ message: 'Could not save the name', modal: true, version: 2 });
    assert.equal(dialog.querySelector('.toast-slot').dataset.toastId, id, 'No rerender spam');
    await act(() => {
      const retry = dialog.querySelector('.toast-recovery');
      retry.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
      retry.click();
    });
    assert.equal(attempts, 2, 'Recovery uses the latest values');
    assert.equal(closes, 0, 'Toast interaction cannot dismiss the form');
    await render({ message: 'Another save failure', modal: true, version: 3 });
    await act(() => dialog.querySelector('.toast-recovery').click());
    assert.match(document.querySelector('.toast').textContent, /Retry failed/);
    await render({ message: undefined, modal: false });
    assert.equal(document.querySelectorAll('.toast-recovery').length, 0, 'No stale recovery');
    assert.equal(document.querySelector('.toast-stack').parentElement, document.body);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
