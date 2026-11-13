// Goal: rich messages (src/lib/i18n/translateRich.ts) render a sentence with inline code and links as React elements built from
// the translation's own word order, escape everything (no markup from a translation ever becomes HTML), and apply the same
// fallback rules as plain messages. translateRef shows a typed reference and the producer's English for an unknown, missing or malformed one, and never throws.
// Method: the real translator pieces are bundled and driven with a small English and Spanish catalog through
// react-dom/server, so the output is the markup a window would receive.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { ROOT, repoPath } = require('../../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'translate-rich.bundle.cjs');
buildSync({
  stdin: {
    contents: `export { createReactRichTranslator } from './src/lib/i18n/translateRich.ts';
      export { createRichTranslator } from './shared/core/i18n/richText.ts';
      export { buildLocaleValue, isKnownMessageKey } from './src/lib/i18n/localeContext.ts';
      export { messages as realEnglish } from './shared/properties/i18n/messages/en/index.ts';`,
    resolveDir: ROOT,
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const { createReactRichTranslator, createRichTranslator, buildLocaleValue, isKnownMessageKey, realEnglish } = require(output);

const english = {
  'x.saved': 'Saved in {file} for <link>the docs</link>.',
  'x.files': { one: '{count} file in <b>{folder}</b>', other: '{count} files in <b>{folder}</b>' },
  'x.hostile': 'Name: {name}',
};
const spanish = {
  'x.saved': 'Consulta <link>la documentación</link>; guardado en {file}.',
  'x.files': { one: '{count} archivo en <b>{folder}</b>', other: '{count} archivos en <b>{folder}</b>' },
  'x.hostile': 'Nombre: {name}',
};

function translatorFor(locale, catalog, issues) {
  return createReactRichTranslator(createRichTranslator({ locale, catalog, fallback: english, onIssue: (issue) => issues.push(issue) }));
}
const html = (node) => renderToStaticMarkup(React.createElement(React.Fragment, undefined, node));
const code = (text) => React.createElement('code', undefined, text);
const link = (children) => React.createElement('a', { href: '#docs' }, children);

test('slots and tags land where the translation puts them', () => {
  const issues = [];
  const slots = { file: code('.stacki/folders.json'), link };
  assert.equal(html(translatorFor('en', english, issues)('x.saved', slots)), 'Saved in <code>.stacki/folders.json</code> for <a href="#docs">the docs</a>.');
  assert.equal(
    html(translatorFor('es', spanish, issues)('x.saved', slots)),
    'Consulta <a href="#docs">la documentación</a>; guardado en <code>.stacki/folders.json</code>.',
  );
  assert.deepEqual(issues, []);
});

test('a numeric count picks the plural form and tags wrap translated text', () => {
  const issues = [];
  const translate = translatorFor('es', spanish, issues);
  const bold = (children) => React.createElement('strong', undefined, children);
  assert.equal(html(translate('x.files', { count: 1, folder: 'src', b: bold })), '1 archivo en <strong>src</strong>');
  assert.equal(html(translate('x.files', { count: 4, folder: 'src', b: bold })), '4 archivos en <strong>src</strong>');
});

test('translated text is escaped: a translation or a value can never inject markup', () => {
  const issues = [];
  const hostile = '<img src=x onerror=alert(1)>';
  const markup = html(translatorFor('es', { 'x.hostile': hostile + ' {name}' }, issues)('x.hostile', { name: hostile }));
  assert.equal(markup.includes('<img'), false);
  assert.match(markup, /&lt;img/);
});

test('a translation that needs a slot the call site lacks falls back to English; English that does is a programmer error', () => {
  const issues = [];
  const translate = translatorFor('es', { 'x.hostile': 'Nombre: {other}' }, issues);
  assert.equal(html(translate('x.hostile', { name: 'Ada' })), 'Name: Ada');
  assert.equal(issues.length, 1);
  assert.throws(() => translatorFor('en', english, [])('x.saved', { link }), /fits the slots and tags/);
  assert.throws(() => html(translatorFor('en', english, [])('x.saved', { file: 'a', link: 'not a function' })), /fits the slots and tags/);
});

test("translateRef translates a typed reference; translateDescribed shows the producer's English for an unknown, missing or incomplete one", () => {
  const key = Object.keys(realEnglish).find((candidate) => typeof realEnglish[candidate] === 'string' && !realEnglish[candidate].includes('{'));
  assert.ok(key);
  const value = buildLocaleValue('en', realEnglish, () => {});
  assert.equal(value.translateRef({ key }), realEnglish[key]);
  assert.equal(value.translateDescribed({ message: 'fallback', messageRef: { key } }), realEnglish[key]);
  assert.equal(value.translateDescribed({ message: 'English from main', messageRef: { key: 'nope.missing' } }), 'English from main');
  assert.equal(value.translateDescribed({ message: 'English from main' }), 'English from main');
  const withParam = Object.keys(realEnglish).find((candidate) => typeof realEnglish[candidate] === 'string' && realEnglish[candidate].includes('{'));
  assert.ok(withParam);
  assert.equal(value.translateDescribed({ message: 'English from main', messageRef: { key: withParam } }), 'English from main');
  assert.equal(isKnownMessageKey(key), true);
  assert.equal(isKnownMessageKey('nope.missing'), false);
});
