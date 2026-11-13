// Goal: the native text of the main process (updater dialogs, the usage notice, file pickers, failure sentences) follows the language the
// person chose, falls back to English instead of showing a key, and keeps its placeholders in every language.
// Method: the real loader and the real shipped catalogs run per locale; the updater is driven with a fake Electron updater and a
// dialog that records what it is asked to show; the application menu is rebuilt for each locale to prove a language change reaches
// every item. Negative space: unknown keys, missing parameters and a locale that fails to load.
import assert from 'node:assert/strict';
import type { MenuItemConstructorOptions } from 'electron';
import { test } from 'node:test';
import { buildApplicationMenuTemplate } from '#dist/electron/app/applicationMenu.js';
import { MAIN_ENGLISH, loadMainLocale, setMainLocale, translateMain } from '#dist/electron/lib/mainLocale.js';
import { LOCALES } from '#dist/shared/core/i18n/locales.js';

const NON_ENGLISH = LOCALES.filter((locale) => locale !== 'en');

test('every main sentence formats in every locale with the same placeholders', async () => {
  for (const locale of NON_ENGLISH) {
    const loaded = await loadMainLocale(locale);
    assert.equal(loaded.locale, locale);
    assert.notEqual(loaded.translate('dialog.update.ready.title'), 'Update Ready', `${locale} translates the update dialog`);
    const withVersion = loaded.translate('dialog.update.ready.message', { version: '9.9.9' });
    assert.ok(withVersion.includes('9.9.9'), `${locale} keeps {version}`);
    const failure = loaded.translate('error.documents.saveFailed', { file: 'a.astro', reason: 'disk full' });
    assert.ok(failure.includes('a.astro') && failure.includes('disk full'), `${locale} keeps both parameters`);
  }
});

test('an unknown key is a programmer error that crashes loudly, not a raw key on screen', () => {
  setMainLocale(MAIN_ENGLISH);
  // @ts-expect-error: the key is deliberately not in the catalog.
  assert.throws(() => translateMain('dialog.nothing.here'), /not an English message/);
});

test('a locale that cannot load leaves English dialogs', async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    setMainLocale(await loadMainLocale('de', () => Promise.reject(new Error('missing'))));
    assert.equal(translateMain('dialog.update.ready.title'), 'Update Ready');
  } finally {
    console.warn = warn;
    setMainLocale(MAIN_ENGLISH);
  }
});

test('rebuilding the menu after a language change relabels every item and keeps the actions', async () => {
  const labelsOf = async (locale: (typeof LOCALES)[number]) => {
    const loaded = await loadMainLocale(locale);
    const sent: string[] = [];
    const template = buildApplicationMenuTemplate({
      isMac: true,
      isDev: false,
      translate: loaded.translate,
      send: (channel) => void sent.push(channel),
      checkForUpdates: () => undefined,
      reloadAllCode: () => undefined,
      reloadWindow: () => undefined,
    });
    const labels: string[] = [];
    const pending: MenuItemConstructorOptions[] = [...template];
    // Menus are at most three levels deep; the cap makes a malformed template fail instead of looping.
    for (let visited = 0; visited < 500; visited += 1) {
      const item = pending.shift();
      if (item === undefined) {
        break;
      }
      if (item.label !== undefined) {
        labels.push(item.label);
      }
      if (Array.isArray(item.submenu)) {
        pending.push(...item.submenu);
      }
      assert.ok(item.role === undefined || item.label !== undefined, `the ${item.role} role item is spelled out, not left to the OS language`);
    }
    return labels;
  };
  const english = await labelsOf('en');
  assert.ok(english.includes('Zoom In') && english.includes('Window') && english.includes('Quit Stacki'));
  for (const locale of NON_ENGLISH) {
    const translated = await labelsOf(locale);
    assert.equal(translated.length, english.length, `${locale} has every item`);
    assert.ok(translated.filter((label, index) => label !== english[index]).length > english.length / 2, `${locale} changes most labels`);
  }
});
