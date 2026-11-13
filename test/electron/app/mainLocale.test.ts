// Goal: the main process speaks the language the person chose (electron/lib/mainLocale.ts, applicationMenu.ts): English at once, another
// language after its two small catalogs load, English again if they cannot load or are corrupt, and the application menu is
// built from `translate` so every item follows. The preference mirrored from the renderer is a validated boundary value.
// Method: the real loader and menu builder run with fake importers (a broken one, a corrupt one) and the real shipped catalogs,
// and the channel parsers are driven with known-good and known-bad values.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApplicationMenuTemplate } from '#dist/electron/app/applicationMenu.js';
import { MAIN_ENGLISH, activeMainLocale, loadMainLocale, setMainLocale, translateMain } from '#dist/electron/lib/mainLocale.js';
import { parseSettings } from '#dist/electron/app/mainValidation.js';
import { LOCALES } from '#dist/shared/core/i18n/locales.js';
import { parseLocaleSet, parseLocaleSetResult } from '#dist/shared/ipc/localeChannel.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

test('English is available at once and is the default', () => {
  assert.equal(MAIN_ENGLISH.translate('menu.file.title'), 'File');
  setMainLocale(MAIN_ENGLISH);
  assert.equal(activeMainLocale(), 'en');
  assert.equal(translateMain('menu.file.openProject'), 'Open Project…');
});

test('every shipped language loads its menu and dialog catalogs', async () => {
  for (const locale of LOCALES) {
    const loaded = await loadMainLocale(locale);
    assert.equal(loaded.locale, locale);
    assert.ok(loaded.translate('menu.file.title').length > 0);
    if (locale !== 'en') {
      assert.notEqual(loaded.translate('menu.file.openProject'), 'Open Project…', `${locale} translates the menu`);
    }
  }
  setMainLocale(await loadMainLocale('de'));
  assert.equal(translateMain('menu.edit.copy'), 'Kopieren');
  setMainLocale(MAIN_ENGLISH);
});

test('a catalog that cannot load or is corrupt leaves English, not a crash', async () => {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const broken = await loadMainLocale('fr', () => Promise.reject(new Error('disk')));
    assert.equal(broken, MAIN_ENGLISH);
    const corrupt = await loadMainLocale('fr', () => Promise.resolve([{ messages: { 'menu.file.title': 42 } }]));
    assert.equal(corrupt, MAIN_ENGLISH);
    const junkModule = await loadMainLocale('fr', () => Promise.resolve(['nope']));
    assert.equal(junkModule, MAIN_ENGLISH);
  } finally {
    console.warn = originalWarn;
  }
});

test('the application menu is built from translate and keeps its shape in every language', async () => {
  for (const locale of LOCALES) {
    const loaded = await loadMainLocale(locale);
    const sent: string[] = [];
    const template = buildApplicationMenuTemplate({
      isMac: true,
      isDev: true,
      translate: loaded.translate,
      send: (channel) => void sent.push(channel),
      checkForUpdates: () => undefined,
      reloadAllCode: () => undefined,
      reloadWindow: () => undefined,
    });
    const labels = template.map((item) => item.label).filter((label) => label !== undefined);
    assert.deepEqual(labels, [
      'Stacki',
      loaded.translate('menu.file.title'),
      loaded.translate('menu.edit.title'),
      loaded.translate('menu.view.title'),
      loaded.translate('menu.window.title'),
    ]);
    const file = template[1];
    const submenu = Array.isArray(file?.submenu) ? file.submenu : [];
    const settings = submenu.find((item) => item.accelerator === 'CmdOrCtrl+,');
    assert.equal(settings?.label, loaded.translate('menu.file.settings'));
    assert.equal(typeof settings?.click, 'function');
    Reflect.apply(settings?.click ?? (() => undefined), undefined, []);
    assert.deepEqual(sent, ['menu:settings'], 'the translated item still sends the same command');
  }
});

test('a packaged non-Mac menu spells out the View menu and ends File with Quit', () => {
  const template = buildApplicationMenuTemplate({
    isMac: false,
    isDev: false,
    translate: MAIN_ENGLISH.translate,
    send: () => undefined,
    checkForUpdates: () => undefined,
    reloadAllCode: () => undefined,
    reloadWindow: () => undefined,
  });
  assert.equal(template[0]?.label, 'File');
  assert.equal(template[2]?.label, 'View');
  assert.equal(template[3]?.label, 'Window');
  const submenu = Array.isArray(template[0]?.submenu) ? template[0].submenu : [];
  assert.equal(submenu[submenu.length - 1]?.role, 'quit');
});

test('the mirrored preference is a shipped language or "system", and nothing else', () => {
  for (const preference of ['system', ...LOCALES]) {
    assert.deepEqual(parseLocaleSet({ preference }), { preference });
    assert.deepEqual(parseIpcPayload('locale:set', { preference }), { preference });
    assert.equal(parseSettings({ sound: false, localePreference: preference }).localePreference, preference);
  }
  for (const preference of ['', 'EN', 'en-US', 'klingon', 3, {}]) {
    assert.throws(() => parseLocaleSet({ preference }), /Locale preference/);
    assert.throws(() => parseSettings({ sound: false, localePreference: preference }), /Locale preference/);
  }
  assert.throws(() => parseLocaleSet({}));
  assert.equal(parseSettings({ sound: false }).localePreference, 'system', 'an older settings file follows the system');
  assert.deepEqual(parseLocaleSetResult({ saved: true }), { saved: true });
  assert.throws(() => parseLocaleSetResult({ saved: 'yes' }));
});
