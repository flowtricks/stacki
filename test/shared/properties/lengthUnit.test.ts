// Goal: shared/properties/lengthUnit.ts decides what a project writes lengths in
// (rem in a Lumos project, px elsewhere) and converts px to rem at the project's
// root font size. Every control that writes a length relies on both.
//
// Methodology: detection is driven by each marker alone, by both, and by
// malformed markers that must not count; the root font size is read from each
// static form and refused for fluid or out-of-bound forms. The wire parser
// passes the two good shapes and fails each bad one with a pinned message.
// Conversion is checked at its bounds — the assertions crash with pinned
// messages — and over real values the style panel writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertPxLengths,
  detectLengthUnit,
  formatPxLength,
  isLumosManifest,
  LENGTH_UNIT_LIMITS,
  parseLengthUnit,
  projectDefaultUnit,
  projectLength,
  PX_LENGTHS,
  pxToRem,
  remToPx,
  rootFontPxFromCss,
  sameLengthUnit,
} from '#dist/shared/properties/lengthUnit.js';

const LUMOS_MANIFEST = JSON.stringify({ name: 'site', lumos: { version: '1.0.2' } });
const PLAIN_MANIFEST = JSON.stringify({ name: 'site', dependencies: { astro: '^7' } });
const REM = { kind: 'rem', rootFontPx: 16 } as const;

test('a package.json lumos block makes the project rem', () => {
  assert.deepEqual(detectLengthUnit({ manifest: LUMOS_MANIFEST, lumosGuide: false, stylesheets: [] }), REM);
});

test('a LUMOS.md alone makes the project rem (the installer can leave the block out)', () => {
  assert.deepEqual(detectLengthUnit({ manifest: PLAIN_MANIFEST, lumosGuide: true, stylesheets: [] }), REM);
  assert.deepEqual(detectLengthUnit({ manifest: undefined, lumosGuide: true, stylesheets: [] }), REM);
});

test('a project with neither marker keeps px', () => {
  assert.equal(detectLengthUnit({ manifest: PLAIN_MANIFEST, lumosGuide: false, stylesheets: [] }), PX_LENGTHS);
  assert.equal(detectLengthUnit({ manifest: undefined, lumosGuide: false, stylesheets: ['html { font-size: 20px; }'] }), PX_LENGTHS);
});

test('a malformed manifest is not Lumos, and never throws', () => {
  assert.equal(isLumosManifest('{ not json'), false);
  assert.equal(isLumosManifest('[]'), false);
  assert.equal(isLumosManifest('null'), false);
  assert.equal(isLumosManifest(JSON.stringify({ lumos: 'yes' })), false);
  assert.equal(isLumosManifest(JSON.stringify({ lumos: [] })), false);
  assert.equal(isLumosManifest('{"lumos":null}'), false);
  assert.equal(isLumosManifest(JSON.stringify({ lumos: {} })), true);
  // Over the bound, the manifest is not read at all.
  const huge = JSON.stringify({ lumos: {}, pad: 'x'.repeat(LENGTH_UNIT_LIMITS.manifestCharsMax) });
  assert.equal(isLumosManifest(huge), false);
});

test('the root font size comes from a static html or :root font-size', () => {
  assert.equal(rootFontPxFromCss('html { font-size: 62.5%; }'), 10);
  assert.equal(rootFontPxFromCss(':root{font-size:18px}'), 18);
  assert.equal(rootFontPxFromCss('html {\n  color: red;\n  font-size: 1.125rem !important;\n}'), 18);
  assert.equal(rootFontPxFromCss('body { font-size: 20px; }'), undefined, 'only the root sets rem');
  assert.equal(rootFontPxFromCss('html { font-size: clamp(1rem, 2vw, 1.25rem); }'), undefined, 'a fluid root has no single size');
  assert.equal(rootFontPxFromCss('html { font-size: var(--root); }'), undefined);
  assert.equal(rootFontPxFromCss('html { font-size: 0px; }'), undefined, 'below the minimum is refused');
  assert.equal(rootFontPxFromCss('html { font-size: 500px; }'), undefined, 'above the maximum is refused');
  assert.equal(rootFontPxFromCss('html { font-size: 10px; } :root { font-size: 12px; }'), 12, 'the later rule wins');
});

test('detection converts at the root size the stylesheets set, the later sheet winning', () => {
  const unit = detectLengthUnit({ manifest: LUMOS_MANIFEST, lumosGuide: false, stylesheets: ['html { font-size: 62.5%; }', 'p { margin: 0 }'] });
  assert.deepEqual(unit, { kind: 'rem', rootFontPx: 10 });
  const later = detectLengthUnit({ manifest: LUMOS_MANIFEST, lumosGuide: false, stylesheets: ['html { font-size: 62.5%; }', ':root { font-size: 20px }'] });
  assert.deepEqual(later, { kind: 'rem', rootFontPx: 20 });
});

test('detection asserts its stylesheet bound', () => {
  const sheets = Array.from({ length: LENGTH_UNIT_LIMITS.stylesheetsMax + 1 }, () => '');
  assert.throws(() => detectLengthUnit({ manifest: undefined, lumosGuide: true, stylesheets: sheets }), {
    message: 'Assertion failed: detectLengthUnit: stylesheet count is bounded',
  });
});

test('the wire parser passes both shapes and fails each bad one', () => {
  assert.equal(parseLengthUnit({ kind: 'px' }), PX_LENGTHS);
  assert.deepEqual(parseLengthUnit({ kind: 'rem', rootFontPx: 16 }), REM);
  const bad: ReadonlyArray<readonly [unknown, string]> = [
    [JSON.parse('null'), 'LengthUnit: expected object'],
    [[], 'LengthUnit: expected object'],
    ['rem', 'LengthUnit: expected object'],
    [{ kind: 'em' }, 'LengthUnit.kind: expected "px" or "rem"'],
    [{ kind: 'rem' }, 'LengthUnit.rootFontPx: expected a finite number'],
    [{ kind: 'rem', rootFontPx: '16' }, 'LengthUnit.rootFontPx: expected a finite number'],
    [{ kind: 'rem', rootFontPx: Number.NaN }, 'LengthUnit.rootFontPx: expected a finite number'],
    [{ kind: 'rem', rootFontPx: 0.5 }, 'LengthUnit.rootFontPx: below the minimum'],
    [{ kind: 'rem', rootFontPx: 129 }, 'LengthUnit.rootFontPx: above the maximum'],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseLengthUnit(input), { message });
  }
  // Valid as it becomes invalid: the bounds themselves pass.
  assert.equal(parseLengthUnit({ kind: 'rem', rootFontPx: LENGTH_UNIT_LIMITS.rootFontPxMin }).kind, 'rem');
  assert.equal(parseLengthUnit({ kind: 'rem', rootFontPx: LENGTH_UNIT_LIMITS.rootFontPxMax }).kind, 'rem');
});

test('px and rem convert at the root size, with asserted bounds', () => {
  assert.equal(pxToRem(1, 16), 0.0625);
  assert.equal(pxToRem(12, 16), 0.75);
  assert.equal(pxToRem(-4, 16), -0.25);
  assert.equal(pxToRem(15, 10), 1.5);
  assert.equal(pxToRem(0.5, 16), 0.0313, 'rounded to four places');
  assert.equal(remToPx(0.75, 16), 12);
  assert.equal(remToPx(pxToRem(13, 16), 16), 13, 'a whole pixel survives the round trip');
  assert.throws(() => pxToRem(Number.NaN, 16), { message: 'Assertion failed: pxToRem: px is a finite number' });
  assert.throws(() => pxToRem(Number.POSITIVE_INFINITY, 16), { message: 'Assertion failed: pxToRem: px is a finite number' });
  assert.throws(() => pxToRem(1, 0), { message: 'Assertion failed: root font size is at least the minimum' });
  assert.throws(() => pxToRem(1, 129), { message: 'Assertion failed: root font size is at most the maximum' });
  assert.throws(() => remToPx(1, Number.NaN), { message: 'Assertion failed: root font size is a finite number' });
});

test('a slider length in px is written in the project unit', () => {
  assert.equal(formatPxLength(12, PX_LENGTHS), '12px');
  assert.equal(formatPxLength(12, REM), '0.75rem');
  assert.equal(formatPxLength(-0, REM), '0rem', 'no negative zero');
  assert.equal(formatPxLength(1, REM), '0.0625rem');
});

test('a px default and a px length become rem only in a rem project', () => {
  assert.equal(projectDefaultUnit('px', REM), 'rem');
  assert.equal(projectDefaultUnit('px', PX_LENGTHS), 'px');
  assert.equal(projectDefaultUnit('%', REM), '%');
  assert.deepEqual(projectLength(24, 'PX', REM), { amount: 1.5, unit: 'rem' });
  assert.deepEqual(projectLength(2, 'em', REM), { amount: 2, unit: 'em' });
  assert.deepEqual(projectLength(24, 'px', PX_LENGTHS), { amount: 24, unit: 'px' });
});

test('every px length in a value becomes rem; everything else is left alone', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['blur(12px)', 'blur(0.75rem)'],
    ['drop-shadow(0px 2px 5px rgba(0, 0, 0, 0.7))', 'drop-shadow(0rem 0.125rem 0.3125rem rgba(0, 0, 0, 0.7))'],
    ['0px 4px 8px -2px rgba(0,0,0,.2), inset 0 1px 0 #fff', '0rem 0.25rem 0.5rem -0.125rem rgba(0,0,0,.2), inset 0 0.0625rem 0 #fff'],
    ['2px solid var(--color)', '0.125rem solid var(--color)'],
    ['8px 16px', '0.5rem 1rem'],
    ['calc(100% - 24px)', 'calc(100% - 1.5rem)'],
    ['var(--space, 12PX)', 'var(--space, 0.75rem)'],
    ['translate(-10px, .5px)', 'translate(-0.625rem, 0.0313rem)'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(convertPxLengths(input, REM), expected, input);
  }
  const untouched = ['1.5rem', '2em', '50%', 'var(--space-12px)', 'url(icon-12px.svg)', '"12px"', "'4px'", '#12px', 'calc(1px2)', 'none', ''];
  for (const value of untouched) {
    assert.equal(convertPxLengths(value, REM), value, value);
  }
  assert.equal(convertPxLengths('blur(12px)', PX_LENGTHS), 'blur(12px)', 'a px project keeps px');
  const long = '1px '.repeat(Math.ceil(LENGTH_UNIT_LIMITS.valueCharsMax / 4) + 1);
  assert.equal(convertPxLengths(long, REM), long, 'over the bound, the value is written as typed');
  assert.equal(convertPxLengths('99999999px', REM), '99999999px', 'a magnitude no one means is left alone');
});

test('settings compare by what they write, not by identity', () => {
  assert.equal(sameLengthUnit(PX_LENGTHS, { kind: 'px' }), true);
  assert.equal(sameLengthUnit(REM, { kind: 'rem', rootFontPx: 16 }), true);
  assert.equal(sameLengthUnit(REM, { kind: 'rem', rootFontPx: 10 }), false);
  assert.equal(sameLengthUnit(REM, PX_LENGTHS), false);
  assert.equal(sameLengthUnit(PX_LENGTHS, REM), false);
});
