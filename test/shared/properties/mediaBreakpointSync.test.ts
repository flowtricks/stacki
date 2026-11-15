// Goal: the `@media` width bounds that equal a breakpoint are found in every form a project writes them, nothing else is, and
// a replacement changes the number and unit token alone, byte for byte.
// Method: table-test the tokenizer and matcher over each form in the request (range syntax, legacy min/max-width, `only screen
// and`, comma lists, upper case, odd spacing, comments), the unit equivalents (64rem is 1024px), the inclusive 1px forms, and the
// non-matches (65rem, height, min-height, prefers-color-scheme, em, calc, comments, strings, selectors); nested @media inside
// @supports and @layer; then the replacement text (rem, px, Lumos conversion, inclusive forms) and byte-exact application over
// CRLF, tabs and a minified line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReplacements,
  classifyBound,
  findWidthBounds,
  formatNumber,
  previewAround,
  replacementText,
} from '#dist/shared/properties/mediaBreakpointSync.js';
import type { BreakpointSetting } from '#dist/shared/properties/projectBreakpoints.js';

const css = { lineComments: false };
const scss = { lineComments: true };
const old: BreakpointSetting = { value: 64, unit: 'rem' };

function matched(text: string, setting: BreakpointSetting = old, syntax = css): readonly string[] {
  return findWidthBounds(text, syntax).flatMap((bound) => {
    const kind = classifyBound(bound, setting);
    return kind === undefined ? [] : [`${kind}:${text.slice(bound.start, bound.end)}`];
  });
}

test('every form of the request matches, in either unit', () => {
  const forms: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['@media (width >= 64rem) { a { color: red } }', ['exact:64rem']],
    ['@media (width < 64rem) { a { color: red } }', ['exact:64rem']],
    ['@media (width <= 64rem) { a { color: red } }', ['exact:64rem']],
    ['@media (64rem <= width) { a { color: red } }', ['exact:64rem']],
    ['@media (64rem > width) { a { color: red } }', ['exact:64rem']],
    ['@media (48rem < width <= 64rem) { a { color: red } }', ['exact:64rem']],
    ['@media (64rem < width <= 80rem) { a { color: red } }', ['exact:64rem']],
    ['@media (min-width: 64rem) { a { color: red } }', ['exact:64rem']],
    ['@media (max-width: 64rem) { a { color: red } }', ['exact:64rem']],
    ['@media only screen and (max-width: 64rem) { a { color: red } }', ['exact:64rem']],
    ['@media screen and (min-width: 64rem) and (max-width: 80rem) { a { color: red } }', ['exact:64rem']],
    ['@media print, (min-width: 64rem) { a { color: red } }', ['exact:64rem']],
    ['@MEDIA ONLY SCREEN AND (MAX-WIDTH: 64REM) { a { color: red } }', ['exact:64REM']],
    ['@media(width>=64rem){a{color:red}}', ['exact:64rem']],
    ['@media   (  width   >=   64rem  )   {a{}}', ['exact:64rem']],
    ['@media (min-width: 1024px) { a { color: red } }', ['exact:1024px']],
    ['@media (width < 1024px) { a { color: red } }', ['exact:1024px']],
    ['@media (min-width: 64.0rem) { a { color: red } }', ['exact:64.0rem']],
    ['@media (width >= 64rem) { @media (width < 64rem) { a {} } }', ['exact:64rem', 'exact:64rem']],
    ['@media /* note */ (width >= 64rem /* edge */) { a {} }', ['exact:64rem']],
  ];
  for (const [text, expected] of forms) {
    assert.deepEqual(matched(text), expected, text);
  }
});

test('the inclusive 1px forms are matched as inclusive, only in the form that includes its edge', () => {
  assert.deepEqual(matched('@media (max-width: 1023px) { a {} }'), ['inclusive:1023px']);
  assert.deepEqual(matched('@media (width <= 1023px) { a {} }'), ['inclusive:1023px']);
  assert.deepEqual(matched('@media (width > 1023px) { a {} }'), ['inclusive:1023px']);
  assert.deepEqual(matched('@media (1023px < width) { a {} }'), ['inclusive:1023px']);
  assert.deepEqual(matched('@media (max-width: 63.9375rem) { a {} }'), ['inclusive:63.9375rem']);
  assert.deepEqual(matched('@media (min-width: 1023px) { a {} }'), [], 'min-width: 1023px is not the boundary less one');
  assert.deepEqual(matched('@media (width < 1023px) { a {} }'), []);
  assert.deepEqual(matched('@media (width >= 1023px) { a {} }'), []);
});

test('other values, features and units are not matched', () => {
  const none = [
    '@media (width >= 65rem) { a {} }',
    '@media (min-width: 63rem) { a {} }',
    '@media (height >= 64rem) { a {} }',
    '@media (min-height: 64rem) { a {} }',
    '@media (max-height: 1024px) { a {} }',
    '@media (min-width: 64em) { a {} }',
    '@media (min-width: 64vw) { a {} }',
    '@media (min-width: calc(64rem)) { a {} }',
    '@media (prefers-color-scheme: dark) { a {} }',
    '@media (prefers-reduced-motion: reduce) and (min-resolution: 64dpi) { a {} }',
    '@media (device-width >= 64rem) { a {} }',
    '@media (width = 64rem) { a {} }',
    '@media (min-width: 64) { a {} }',
    '@container (min-width: 64rem) { a {} }',
    '@supports (min-width: 64rem) { a {} }',
    'a { width: 64rem; max-width: 64rem }',
    '.w-64rem { color: red }',
    '@media screen { a { width: 64rem } }',
  ];
  for (const text of none) {
    assert.deepEqual(matched(text), [], text);
  }
});

test('comments and strings are not preludes', () => {
  assert.deepEqual(matched('/* @media (width >= 64rem) { } */ a { color: red }'), []);
  assert.deepEqual(matched('a::after { content: "@media (width >= 64rem) {" }'), []);
  assert.deepEqual(matched("a { content: '@media (min-width: 64rem)'; }"), []);
  assert.deepEqual(matched('// @media (width >= 64rem)\na {}'), ['exact:64rem'], 'CSS has no line comments');
  assert.deepEqual(matched('// @media (width >= 64rem)\na {}', old, scss), [], 'SCSS does');
});

test('nested @media inside @supports and @layer is found', () => {
  assert.deepEqual(matched('@supports (display: grid) { @media (min-width: 64rem) { a {} } }'), ['exact:64rem']);
  assert.deepEqual(matched('@layer base { @media (width < 64rem) { a {} } }'), ['exact:64rem']);
  assert.deepEqual(matched('a { @media (width >= 64rem) { color: red } }'), ['exact:64rem']);
});

test('a px breakpoint matches rem equivalents too', () => {
  const px: BreakpointSetting = { value: 1100, unit: 'px' };
  assert.deepEqual(matched('@media (min-width: 68.75rem) { a {} }', px), ['exact:68.75rem']);
  assert.deepEqual(matched('@media (min-width: 1100px) { a {} }', px), ['exact:1100px']);
  assert.deepEqual(matched('@media (max-width: 1099px) { a {} }', px), ['inclusive:1099px']);
});

test('locators ignore the number, and tell identical preludes apart', () => {
  const first = findWidthBounds('@media (min-width: 64rem) { a {} }', css)[0];
  const moved = findWidthBounds('\n\n@media (min-width: 70rem) { a {} }', css)[0];
  assert.ok(first && moved);
  assert.equal(first.locator, moved.locator, 'the same query keeps its locator when the number or the line changes');
  const twins = findWidthBounds('@media (min-width: 64rem) { a {} } @media (min-width: 64rem) { b {} }', css);
  assert.equal(twins.length, 2);
  assert.notEqual(twins[0]?.locator, twins[1]?.locator);
  assert.equal(findWidthBounds('@media (min-width: 64rem) {}', css)[0]?.locator, findWidthBounds('@MEDIA ( MIN-WIDTH : 70REM ) {}', css)[0]?.locator);
});

test('replacement text follows the new breakpoint, the matched form and the project unit', () => {
  const px = { unit: 'px' } as const;
  const rem = { unit: 'rem' } as const;
  assert.equal(replacementText('exact', rem, { value: 70, unit: 'rem' }, { lumos: false }), '70rem');
  assert.equal(replacementText('exact', px, { value: 70, unit: 'rem' }, { lumos: false }), '70rem', 'a px bound becomes the new rem value');
  assert.equal(replacementText('exact', rem, { value: 1100, unit: 'px' }, { lumos: false }), '1100px', 'a rem bound becomes the new px value');
  assert.equal(replacementText('exact', rem, { value: 1100, unit: 'px' }, { lumos: true }), '68.75rem', 'a Lumos project is written in rem');
  assert.equal(replacementText('exact', px, { value: 62.5, unit: 'rem' }, { lumos: true }), '62.5rem');
  assert.equal(replacementText('inclusive', px, { value: 70, unit: 'rem' }, { lumos: false }), '1119px', 'one pixel under 1120px, in px');
  assert.equal(replacementText('inclusive', rem, { value: 70, unit: 'rem' }, { lumos: false }), '69.9375rem');
  assert.equal(replacementText('inclusive', px, { value: 70, unit: 'rem' }, { lumos: true }), '69.9375rem', 'Lumos never gets px');
  assert.equal(formatNumber(64), '64');
  assert.equal(formatNumber(62.5), '62.5');
  assert.equal(formatNumber(63.9375), '63.9375');
});

test('replacements change only the token: CRLF, tabs and minified text stay byte for byte', () => {
  const sources = [
    '@media (min-width: 64rem) {\r\n\ta { color: red; }\r\n}\r\n',
    '@media\t(min-width:\t64rem)\t{\n\ta {\n\t\tcolor: red;\n\t}\n}',
    '@media (min-width:64rem){a{color:red}}b{c:d}@media (max-width:64rem){e{f:g}}',
  ];
  for (const text of sources) {
    const replacements = findWidthBounds(text, css).map((bound) => ({ start: bound.start, end: bound.end, text: '70rem' }));
    assert.ok(replacements.length > 0);
    const result = applyReplacements(text, replacements);
    assert.equal(result, text.replaceAll('64rem', '70rem'));
    assert.equal(result.length - text.length, replacements.length * ('70rem'.length - '64rem'.length));
  }
});

test('overlapping replacements are a programmer error', () => {
  assert.throws(
    () =>
      applyReplacements('abcdef', [
        { start: 0, end: 4, text: 'x' },
        { start: 2, end: 5, text: 'y' },
      ]),
    /Assertion failed: applyReplacements/,
  );
});

test('the preview shows the query around the token', () => {
  const text = '@media only screen and (max-width: 64rem) { a {} }';
  const [bound] = findWidthBounds(text, css);
  assert.ok(bound);
  assert.equal(previewAround(text, bound, '64rem'), '@media only screen and (max-width: 64rem)');
  assert.equal(previewAround(text, bound, '70rem'), '@media only screen and (max-width: 70rem)');
});

test('a hostile text is bounded, never a crash', () => {
  assert.doesNotThrow(() => findWidthBounds('@media ('.repeat(5000), css));
  assert.doesNotThrow(() => findWidthBounds('@media ' + '(min-width: 64rem) and '.repeat(5000) + '{}', css));
  assert.doesNotThrow(() => findWidthBounds('/* unterminated @media (min-width: 64rem)', css));
  assert.doesNotThrow(() => findWidthBounds('@media (min-width: 64rem', css));
});
