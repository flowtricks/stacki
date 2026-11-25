// Goal: Design mode's own catalogs (src/app/designMode/i18n) hold every English key in every one of the app's 18
// locales, with the same placeholders, no empty text, and nothing extra; filling a placeholder works and a missing
// value leaves the placeholder visible rather than an "undefined". The canvas modes registry the AI composer's
// menu reads adds, replaces and removes rows and stays within its bound.
//
// Method: the real catalogs and registry, bundled by test/helpers/rendererModule.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../../helpers/rendererModule');

const { designModeCatalogs } = load('src/app/designMode/i18n/catalogs.ts');
const { designModeEnglish } = load('src/app/designMode/i18n/en.ts');
const { designWord } = load('src/app/designMode/i18n/designWords.ts');
const { LOCALES } = require('#dist/shared/core/i18n/locales.js');
const modes = load('src/lib/canvasModes.ts');

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
      assert.notEqual(catalog['mode.description'], designModeEnglish['mode.description'], `${locale}: translated`);
    }
  }
});

test('words fill their placeholders; a missing value stays visible', () => {
  assert.equal(designWord('en', 'inspector.selected', { count: 3 }), '3 selected');
  assert.equal(designWord('en', 'inspector.selected'), '{count} selected');
  assert.equal(designWord('en', 'inspector.selected', { other: 1 }), '{count} selected');
  assert.notEqual(designWord('ja', 'mode.name'), 'Design mode');
});

test('the canvas modes registry adds, replaces and removes rows, and refuses past its bound', () => {
  const row = (id) => ({ id, label: () => id, description: () => id, icon: undefined, isActive: () => false, toggle: () => undefined });
  const removeFirst = modes.registerCanvasMode(row('one'));
  const removeAgain = modes.registerCanvasMode(row('one'));
  const removeTwo = modes.registerCanvasMode(row('two'));
  removeFirst();
  removeAgain();
  removeTwo();
  const removals = [];
  for (let index = 0; index < 16; index += 1) {
    removals.push(modes.registerCanvasMode(row('m' + index)));
  }
  assert.throws(() => modes.registerCanvasMode(row('extra')), /at most 16 canvas modes/);
  assert.doesNotThrow(() => modes.registerCanvasMode(row('m3')), 'replacing a row is not adding one');
  for (const remove of removals) {
    remove();
  }
});
