// Goal: the Language switcher marks every language with a country flag. Each shipped locale has a flag id in LOCALE_INFO that exists in the
// vendored set (src/ui/flags) and no two locales share one, the short text mark stays as the fallback (non-empty, at most two characters,
// distinct), the open menu draws a flag svg in front of every language row and a globe in front of "System default", the closed trigger shows
// the chosen language's flag, and the settings row's label carries a globe.
// Method: the real LanguageSetting and Dropdown bundled as the app bundles them, rendered in jsdom with the default (English) translator and
// driven by DOM events; each case awaits React's act, never a timer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { repoPath, ROOT } = require('../../helpers/sources');
const output = repoPath('node_modules/.stacki-test/language-switcher-marks.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents:
      "export { LanguageSetting } from './src/app/settings/LanguageSetting'; export { LOCALES, LOCALE_INFO } from './shared/core/i18n/locales'; export { FLAG_SHAPES } from './src/ui/flags/flagPaths';",
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const { LanguageSetting, LOCALES, LOCALE_INFO, FLAG_SHAPES } = require(output);

test('every locale has a distinct flag that exists in the vendored set', () => {
  const seen = new Map();
  for (const locale of LOCALES) {
    const { flag } = LOCALE_INFO[locale];
    const shapes = FLAG_SHAPES[flag];
    assert.ok(Array.isArray(shapes) && shapes.length > 0, `${locale}'s flag ${flag} has artwork`);
    assert.equal(seen.get(flag), undefined, `${locale} shares the flag ${flag} with ${seen.get(flag)}`);
    seen.set(flag, locale);
  }
  assert.equal(Object.keys(FLAG_SHAPES).length, LOCALES.length, 'the vendored set holds exactly the flags in use');
});

test('every locale has a short, distinct fallback mark', () => {
  const seen = new Map();
  for (const locale of LOCALES) {
    const { mark } = LOCALE_INFO[locale];
    assert.ok(mark.length > 0, `${locale} has a mark`);
    assert.ok([...mark].length <= 2, `${locale}'s mark fits the 16px column`);
    assert.equal(seen.get(mark), undefined, `${locale} shares the mark ${mark} with ${seen.get(mark)}`);
    seen.set(mark, locale);
  }
});

test('the menu marks every language, the trigger shows the chosen one, and globes mark the row and System default', async (context) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  // The preference store reads the bare global, so the jsdom storage stands in for it.
  Object.defineProperty(global, 'localStorage', { value: dom.window.localStorage, configurable: true });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  await act(async () => root.render(React.createElement(LanguageSetting)));
  assert.ok(document.querySelector('.app-settings-row-label [data-central-icon="globe"]'), 'the row label has a globe');
  const trigger = document.querySelector('.dd-trigger');
  assert.ok(trigger.querySelector('[data-central-icon="globe"]'), 'System default shows the globe in the closed trigger');
  await act(async () => trigger.click());
  const options = [...document.querySelectorAll('.dd-popup .dd-option')];
  assert.equal(options.length, LOCALES.length + 1);
  assert.ok(options[0].querySelector('.dd-icon [data-central-icon="globe"]'));
  for (const locale of LOCALES) {
    const mark = document.querySelector(`.dd-popup [data-locale-mark="${locale}"]`);
    assert.ok(mark, `${locale} has a mark in the menu`);
    assert.ok(mark.querySelector(`svg.ui-flag[data-flag="${LOCALE_INFO[locale].flag}"]`), `${locale} draws its flag`);
    assert.equal(mark.textContent, '', `${locale}'s flag carries no text`);
  }
  // Choosing a language puts its flag in the closed trigger.
  const german = document.querySelector('.dd-popup [data-locale-mark="de"]').closest('.dd-option');
  await act(async () => german.click());
  assert.ok(document.querySelector('.dd-trigger [data-locale-mark="de"] svg.ui-flag[data-flag="de"]'));
});
