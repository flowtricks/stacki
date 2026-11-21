// Goal: ⌘R and ⇧⌘R refresh the site when focus is in the canvas, and do what they always did everywhere else.
// Method: the pure decision (focus x command) and the frame classification are checked directly, including the negative space
// (no focused frame, the main frame, an app's frame on the app scheme). Then the real menu template is built for a dev and a
// packaged run, the reload items are found by accelerator and clicked, and each reports the command it asked to run, so the
// pairing of accelerator and command is pinned for both modes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApplicationMenuTemplate, type ReloadCommand } from '#dist/electron/app/applicationMenu.js';
import { classifyFocusedFrame, routeReload } from '#dist/electron/app/reloadRouting.js';
import { MAIN_ENGLISH } from '#dist/electron/lib/mainLocale.js';

const COMMANDS: readonly ReloadCommand[] = ['reloadAllCode', 'reloadWindow', 'forceReloadWindow'];
const APP_SCHEME = 'stacki-app';

test('focus in the canvas turns every reload command into the site refresh', () => {
  for (const command of COMMANDS) {
    assert.equal(routeReload(command, 'canvas'), 'refreshPreview');
  }
});

test('focus anywhere else keeps the command it had', () => {
  for (const command of COMMANDS) {
    assert.equal(routeReload(command, 'app'), command);
  }
});

test('only a frame that is neither the window nor an app counts as the canvas', () => {
  assert.equal(classifyFocusedFrame({ isMainFrame: false, url: 'http://localhost:4321/#avb-design' }, APP_SCHEME), 'canvas');
  assert.equal(classifyFocusedFrame({ isMainFrame: false, url: 'https://example.com/' }, APP_SCHEME), 'canvas');
  assert.equal(classifyFocusedFrame({ isMainFrame: true, url: 'http://localhost:5173/' }, APP_SCHEME), 'app');
  assert.equal(classifyFocusedFrame({ isMainFrame: false, url: `${APP_SCHEME}://notes/index.html` }, APP_SCHEME), 'app');
  assert.equal(classifyFocusedFrame(undefined, APP_SCHEME), 'app');
});

function reloadsAskedFor(isDev: boolean): Map<string, ReloadCommand | undefined> {
  let asked: ReloadCommand | undefined;
  const template = buildApplicationMenuTemplate({
    isMac: true,
    isDev,
    translate: MAIN_ENGLISH.translate,
    send: () => undefined,
    checkForUpdates: () => undefined,
    reload: (command) => {
      asked = command;
    },
  });
  const view = template.find((item) => item.label === 'View');
  const items = Array.isArray(view?.submenu) ? view.submenu : [];
  const byAccelerator = new Map<string, ReloadCommand | undefined>();
  for (const item of items) {
    const accelerator = typeof item.accelerator === 'string' ? item.accelerator : undefined;
    if (accelerator === 'CmdOrCtrl+R' || accelerator === 'Shift+CmdOrCtrl+R') {
      asked = undefined;
      assert.equal(typeof item.click, 'function', `${accelerator} runs a handler, not a stock role`);
      assert.equal(item.role, undefined, `${accelerator} is not a role that reloads Stacki whatever has focus`);
      Reflect.apply(item.click ?? (() => undefined), undefined, []);
      byAccelerator.set(accelerator, asked);
    }
  }
  return byAccelerator;
}

test('a dev run maps the accelerators to the relaunch and the window reload', () => {
  const asked = reloadsAskedFor(true);
  assert.equal(asked.get('CmdOrCtrl+R'), 'reloadAllCode');
  assert.equal(asked.get('Shift+CmdOrCtrl+R'), 'reloadWindow');
});

test('a packaged run maps the accelerators to the window reload and the cache-bypassing one', () => {
  const asked = reloadsAskedFor(false);
  assert.equal(asked.get('CmdOrCtrl+R'), 'reloadWindow');
  assert.equal(asked.get('Shift+CmdOrCtrl+R'), 'forceReloadWindow');
});
