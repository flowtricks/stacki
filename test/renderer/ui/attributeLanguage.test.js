// Goal: which attribute is code is decided by one table, and the grammars that
// table names colour what a person types: `sizes` media conditions and lengths,
// `srcset` candidates with descriptors, SVG path data, a pattern's regular
// expression, JSON in `data-*`, and token lists. Prose and unknown names stay
// plain, so a sentence is never coloured by accident.
// Method: the pure table is asked known-good names (spelled in more than one
// way), element-scoped names, `data-*` with JSON and with a sentence, and
// unknown or prose names; each grammar is run over fixed text through
// attributeTokens, whose joined text must be the input and whose colours are
// read by token.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('../../helpers/rendererModule');
const { attributeLanguage, attributeLanguageOf } = load('src/ui/attributeLanguage.ts');
const { attributeTokens } = load('src/ui/attributeSyntax.ts');

test('known attributes map to their language, whatever their spelling', () => {
  for (const [name, language] of [
    ['sizes', 'mediaQuery'],
    ['media', 'mediaQuery'],
    ['srcset', 'sourceSet'],
    ['srcSet', 'sourceSet'],
    ['style', 'declarations'],
    ['d', 'pathData'],
    ['viewBox', 'svgNumbers'],
    ['view-box', 'svgNumbers'],
    ['points', 'svgNumbers'],
    ['transform', 'svgNumbers'],
    ['stroke-dasharray', 'svgNumbers'],
    ['pattern', 'regex'],
    ['rel', 'tokens'],
    ['type', 'tokens'],
    ['accept', 'tokens'],
    ['onclick', 'javascript'],
    ['onClick', 'javascript'],
    ['onmouseover', 'javascript'],
  ]) {
    assert.equal(attributeLanguage(name), language, name);
  }
});

test('names with no grammar stay plain', () => {
  for (const name of [
    'alt',
    'title',
    'label',
    'aria-label',
    'aria-describedby',
    'href',
    'src',
    'id',
    'class',
    'once',
    'online-help',
    'onboarding',
    'content',
    '',
    'x'.repeat(500),
  ]) {
    assert.equal(attributeLanguage(name), undefined, name);
  }
});

test('content is a list only on meta, and data-* is JSON only when it opens like JSON', () => {
  assert.equal(attributeLanguage('content', 'meta'), 'keyValues');
  assert.equal(attributeLanguage('content', 'p'), undefined);
  assert.equal(attributeLanguageOf('data-config', '{"a":1}'), 'json');
  assert.equal(attributeLanguageOf('data-list', ' [1, 2]'), 'json');
  assert.equal(attributeLanguageOf('data-label', 'Click me'), undefined);
  assert.equal(attributeLanguageOf('label', '{"a":1}'), undefined);
});

const colours = (text, language) =>
  attributeTokens(text, language)
    .filter((token) => token.style !== undefined)
    .map((token) => [token.text, token.style.color]);

test('sizes colours features, lengths and separators and keeps its text', () => {
  const text = '(min-width: 992px) 33vw, (min-width: 768px) 50vw, 100vw';
  const tokens = attributeTokens(text, 'mediaQuery');
  assert.equal(tokens.map((token) => token.text).join(''), text);
  const found = colours(text, 'mediaQuery');
  assert.ok(
    found.some(([part]) => part === 'min-width'),
    'a feature is coloured',
  );
  assert.ok(
    found.some(([part]) => part === '992px'),
    'a length is coloured',
  );
  assert.ok(
    found.some(([part]) => part === '100vw'),
    'the last length is coloured',
  );
  const colourOf = (part) => found.find(([candidate]) => candidate === part)?.[1];
  assert.notEqual(colourOf('min-width'), colourOf('992px'), 'features and lengths differ');
});

test('the other grammars colour what they name and leave a sentence alone', () => {
  assert.deepEqual(
    colours('a.jpg 480w', 'sourceSet').map(([part]) => part),
    ['a.jpg', '480w'],
  );
  assert.ok(colours('M10 10 L20 20 Z', 'pathData').some(([part]) => part === 'M'));
  assert.ok(colours('translate(10px, 5)', 'svgNumbers').some(([part]) => part === 'translate'));
  assert.ok(colours('[A-Z]{3}\\d', 'regex').some(([part]) => part === '\\d'));
  assert.ok(colours('{"a": 1}', 'json').some(([part]) => part === '"a"'));
  assert.ok(colours('image/png, .jpg', 'tokens').some(([part]) => part === 'image/png'));
  assert.ok(colours('width=device-width, initial-scale=1', 'keyValues').some(([part]) => part === 'width'));
  assert.deepEqual(colours('A sentence, with commas.', 'keyValues'), [], 'a description is not coloured');
});
