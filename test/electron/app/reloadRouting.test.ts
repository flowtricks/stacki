// Goal: ⌘R and ⇧⌘R always refresh the site preview, wherever focus is, and never reload Stacki; ⇧⌘R clears the HTTP cache first.
// Stacki's own reload is a separate View item (⌥⌘R in dev, no accelerator when packaged).
// Method: the pure decision (preview open or not) is checked directly, including the negative space (no preview: nothing happens).
// Then the real menu template is built for a dev and a packaged run, the items are found by accelerator or label and clicked, and
// each reports the command it asked to run, so the pairing of accelerator and command is pinned for both modes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApplicationMenuTemplate, type ReloadCommand } from '#dist/electron/app/applicationMenu.js';
import { routeReload } from '#dist/electron/app/reloadRouting.js';
import { MAIN_ENGLISH } from '#dist/electron/lib/mainLocale.js';

test('with a preview open the shortcut refreshes the site', () => {
  assert.equal(routeReload({ previewOpen: true }), 'refreshPreview');
});

test('with no preview open the shortcut does nothing', () => {
  assert.equal(routeReload({ previewOpen: false }), 'noop');
  assert.equal(routeReload({ previewOpen: false, hard: true }), 'noop');
});

test('a hard refresh clears the cache before it refreshes the site', () => {
  assert.equal(routeReload({ previewOpen: true, hard: true }), 'clearCacheAndRefreshPreview');
  assert.equal(routeReload({ previewOpen: true, hard: false }), 'refreshPreview');
});

interface ViewItem {
  readonly label: string | undefined;
  readonly accelerator: string | undefined;
  readonly asked: ReloadCommand | undefined;
}

function viewItems(mode: 'dev' | 'packaged'): ViewItem[] {
  let asked: ReloadCommand | undefined;
  const template = buildApplicationMenuTemplate({
    isMac: true,
    isDev: mode === 'dev',
    translate: MAIN_ENGLISH.translate,
    send: () => undefined,
    checkForUpdates: () => undefined,
    reload: (command) => {
      asked = command;
    },
  });
  const view = template.find((item) => item.label === 'View');
  const items = Array.isArray(view?.submenu) ? view.submenu : [];
  const found: ViewItem[] = [];
  for (const item of items) {
    if (typeof item.click === 'function') {
      asked = undefined;
      assert.equal(item.role, undefined, 'a reload item is not a stock role that reloads Stacki whatever has focus');
      Reflect.apply(item.click, undefined, []);
      found.push({ label: item.label, accelerator: typeof item.accelerator === 'string' ? item.accelerator : undefined, asked });
    }
  }
  return found;
}

for (const mode of ['dev', 'packaged'] as const) {
  test(`a ${mode} run maps ⌘R to the site refresh and ⇧⌘R to the hard one`, () => {
    const items = viewItems(mode);
    assert.equal(items.find((item) => item.accelerator === 'CmdOrCtrl+R')?.asked, 'refreshSite');
    assert.equal(items.find((item) => item.accelerator === 'Shift+CmdOrCtrl+R')?.asked, 'hardRefreshSite');
  });
}

test('a dev run reloads Stacki on ⌥⌘R only', () => {
  const items = viewItems('dev');
  const reloading = items.filter((item) => item.asked === 'reloadStacki');
  assert.equal(reloading.length, 1);
  assert.equal(reloading[0]?.accelerator, 'Alt+CmdOrCtrl+R');
  assert.equal(reloading[0]?.label, 'Reload Stacki');
});

test('a packaged run offers Reload Stacki by menu only, with no accelerator', () => {
  const items = viewItems('packaged');
  const reloading = items.filter((item) => item.asked === 'reloadStacki');
  assert.equal(reloading.length, 1);
  assert.equal(reloading[0]?.accelerator, undefined);
  assert.equal(reloading[0]?.label, 'Reload Stacki');
});
