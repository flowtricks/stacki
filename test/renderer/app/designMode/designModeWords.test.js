// Goal: Design mode's own catalogs (src/app/designMode/i18n) hold every English key in every one of the app's 18
// locales, with the same placeholders, no empty text, and nothing extra; filling a placeholder works and a missing
// value leaves the placeholder visible rather than an "undefined".
//
// Method: the real catalogs, bundled by test/helpers/rendererModule.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../../helpers/rendererModule');

const { designModeCatalogs } = load('src/app/designMode/i18n/catalogs.ts');
const { designModeEnglish } = load('src/app/designMode/i18n/en.ts');
const { designWord } = load('src/app/designMode/i18n/designWords.ts');
const { LOCALES } = require('#dist/shared/core/i18n/locales.js');

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test('every locale has every key, its placeholders and some text', () => {
  const keys = Object.keys(designModeEnglish).sort();
  assert.deepEqual(Object.keys(designModeCatalogs).sort(), [...LOCALES].sort());
  for (const locale of LOCALES) {
    const catalog = designModeCatalogs[locale];
    assert.deepEqual(Object.keys(catalog).sort(), keys, `${locale}: same keys`);
    for (const key of keys) {
      assert.ok(catalog[key].trim().length > 0, `${locale} ${key}: some text`);
      assert.deepEqual(placeholders(catalog[key]), placeholders(designModeEnglish[key]), `${locale} ${key}: same placeholders`);
    }
    if (locale !== 'en') {
      assert.notEqual(catalog['bar.tip'], designModeEnglish['bar.tip'], `${locale}: translated`);
    }
  }
});

test('words fill their placeholders; a missing value stays visible', () => {
  assert.equal(designWord('en', 'frame.changes', { count: 3 }), '3 changed files');
  assert.equal(designWord('en', 'frame.changes'), '{count} changed files');
  assert.equal(designWord('en', 'frame.changes', { other: 1 }), '{count} changed files');
  assert.notEqual(designWord('ja', 'mode.name'), 'Design mode');
});
