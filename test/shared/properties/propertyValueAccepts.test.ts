// Goal: shared/properties/propertyValueAccepts.ts decides which CSS variables a
// property's picker offers. For font-weight, a variable is offered only when its
// computed value is a valid weight; nothing else is filtered.
//
// Methodology: the pure predicate is driven by each valid form (keywords in any
// case, whole and fractional numbers, both range ends) and each invalid one
// (outside the range, units, none, global keywords, math functions). The resolver
// is driven through var() chains, fallbacks, a missing variable, a cycle and the
// depth bound, with a lookup built from a plain object so no stylesheet is read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOfferedFontWeight,
  isValidFontFamily,
  isLetterSpacingLength,
  isLineHeightMultiplier,
  isValidTextTransform,
  isValidFontWeight,
  resolveVariableValue,
  valuePredicateFor,
  variableAccepted,
  VALUE_ACCEPTS_LIMITS,
} from '#dist/shared/properties/propertyValueAccepts.js';

const lookupOf = (declared: Readonly<Record<string, string>>) => (name: string) => declared[name];

test('font-weight keywords are valid in any case', () => {
  for (const keyword of ['normal', 'bold', 'bolder', 'lighter', 'BOLD', ' Normal ']) {
    assert.equal(isValidFontWeight(keyword), true, keyword);
  }
});

test('font-weight numbers are valid from 1 to 1000, fractions included', () => {
  for (const weight of ['1', '100', '400', '700', '1000', '1.5', '999.9', '350', '+400', '4e2']) {
    assert.equal(isValidFontWeight(weight), true, weight);
  }
});

test('font-weight refuses what is not a weight', () => {
  const invalid = [
    '0',
    '1001',
    '-100',
    '0.5',
    '0.0625rem',
    '400px',
    '1rem',
    'none',
    'inherit',
    'initial',
    'unset',
    'revert',
    'revert-layer',
    '',
    '  ',
    'clamp(1rem, 2vw, 3rem)',
    'calc(400 + 100)',
    'var(--x)',
    '400 700',
    'NaN',
    'Infinity',
    '--x',
  ];
  for (const value of invalid) {
    assert.equal(isValidFontWeight(value), false, JSON.stringify(value));
  }
});

test('only font-weight has a predicate; every other property is unfiltered', () => {
  assert.equal(valuePredicateFor('font-weight'), isOfferedFontWeight);
  assert.equal(valuePredicateFor(' Font-Weight '), isOfferedFontWeight);
  assert.equal(valuePredicateFor('font-size'), undefined);
  assert.equal(valuePredicateFor('color'), undefined);
  assert.equal(valuePredicateFor(undefined), undefined);
});

test('resolveVariableValue follows chains and fallbacks', () => {
  const lookup = lookupOf({ 'display-font-weight': 'var(--primary-medium)', 'primary-medium': '500', nested: 'var(--missing, var(--primary-medium))' });
  assert.equal(resolveVariableValue('var(--display-font-weight)', lookup), '500');
  assert.equal(resolveVariableValue('var(--nested)', lookup), '500');
  assert.equal(resolveVariableValue('var(--missing, 700)', lookup), '700');
  assert.equal(resolveVariableValue('var(--missing, calc(1 + 2))', lookup), 'calc(1 + 2)');
  assert.equal(resolveVariableValue('600', lookup), '600');
});

test('resolveVariableValue gives up on a missing variable, a cycle, a long chain and malformed input', () => {
  assert.equal(resolveVariableValue('var(--missing)', lookupOf({})), undefined);
  assert.equal(resolveVariableValue('var(--a)', lookupOf({ a: 'var(--b)', b: 'var(--a)' })), undefined);
  assert.equal(resolveVariableValue('var(--a)', lookupOf({ a: 'var(--a)' })), undefined);
  assert.equal(resolveVariableValue('var(--a', lookupOf({ a: '1' })), undefined);
  assert.equal(resolveVariableValue('var(not-a-name)', lookupOf({})), undefined);
  const chain: Record<string, string> = {};
  for (let index = 0; index <= VALUE_ACCEPTS_LIMITS.depthMax + 2; index += 1) {
    chain[`v${index}`] = `var(--v${index + 1})`;
  }
  chain[`v${VALUE_ACCEPTS_LIMITS.depthMax + 3}`] = '400';
  assert.equal(resolveVariableValue('var(--v0)', lookupOf(chain)), undefined);
});

test('variableAccepted combines resolution and the predicate', () => {
  const lookup = lookupOf({
    weight: 'var(--primary-medium)',
    'primary-medium': '500',
    border: '0.0625rem',
    display: 'clamp(2rem, 5vw, 4rem)',
    none: 'none',
    loop: 'var(--loop)',
  });
  assert.equal(variableAccepted('var(--primary-medium)', lookup, isOfferedFontWeight), true);
  assert.equal(variableAccepted('var(--weight)', lookup, isOfferedFontWeight), true);
  assert.equal(variableAccepted('var(--border)', lookup, isOfferedFontWeight), false);
  assert.equal(variableAccepted('var(--display)', lookup, isOfferedFontWeight), false);
  assert.equal(variableAccepted('var(--none)', lookup, isOfferedFontWeight), false);
  assert.equal(variableAccepted('var(--loop)', lookup, isOfferedFontWeight), false);
  assert.equal(variableAccepted('var(--nope)', lookup, isOfferedFontWeight), false);
  assert.equal(variableAccepted('bold', lookup, isOfferedFontWeight), true);
});

test('the Weight picker offers multiples of 50 from 100 to 1000 only', () => {
  for (const weight of ['100', '150', '200', '250', '350', '400', '500', '700', '950', '1000', '4e2', '400.0']) {
    assert.equal(isOfferedFontWeight(weight), true, weight);
  }
  for (const weight of [
    '143',
    '114',
    '256',
    '181',
    '361',
    '128',
    '274',
    '320',
    '999.5',
    '400.5',
    '1050',
    '99',
    '90',
    '45',
    '23',
    '13',
    '7',
    '1.5',
    '0',
    '1001',
    '-100',
    '1rem',
    'none',
    'inherit',
    '',
  ]) {
    assert.equal(isOfferedFontWeight(weight), false, weight);
  }
  for (const keyword of ['normal', 'bold', 'bolder', 'lighter']) {
    assert.equal(isOfferedFontWeight(keyword), true, keyword);
  }
  // CSS itself still accepts the small weights.
  assert.equal(isValidFontWeight('99'), true);
});

test('font-family accepts quoted, unquoted, generic and listed families', () => {
  const valid = [
    '"Inter"',
    "'Open Sans'",
    'Helvetica Neue',
    'Arial',
    'sans-serif',
    'system-ui',
    'ui-monospace',
    '"Inter", sans-serif',
    'Inter, "Helvetica Neue", Arial, sans-serif',
    '"Normal"',
    '"a,b", serif',
  ];
  for (const value of valid) {
    assert.equal(isValidFontFamily(value), true, value);
  }
});

test('font-family refuses other properties keywords, numbers, lengths, functions and leftovers', () => {
  const invalid = [
    'none',
    'balance',
    'pretty',
    'uppercase',
    'normal',
    'auto',
    'bold',
    'italic',
    'center',
    'inherit',
    'initial',
    'unset',
    'revert',
    'revert-layer',
    '1.5',
    '400',
    '0.0625rem',
    '50%',
    'clamp(1rem, 2vw, 3rem)',
    'calc(1rem + 2px)',
    'min(1px, 2px)',
    '#fff',
    'rgb(0 0 0)',
    'red',
    'var(--x)',
    'Inter, var(--y)',
    '',
    ',',
    'Inter,',
    '"unterminated',
    'Inter, none',
  ];
  for (const value of invalid) {
    assert.equal(isValidFontFamily(value), false, JSON.stringify(value));
  }
  assert.equal(valuePredicateFor('font-family'), isValidFontFamily);
});

test('font-family variables resolve through chains and fall back when missing', () => {
  const lookup = lookupOf({ 'display-font-family': 'var(--primary-family)', 'primary-family': '"Inter", sans-serif', transform: 'none' });
  assert.equal(variableAccepted('var(--primary-family)', lookup, isValidFontFamily), true);
  assert.equal(variableAccepted('var(--display-font-family)', lookup, isValidFontFamily), true);
  assert.equal(variableAccepted('var(--nope, Arial)', lookup, isValidFontFamily), true);
  assert.equal(variableAccepted('var(--transform)', lookup, isValidFontFamily), false);
  assert.equal(variableAccepted('var(--nope)', lookup, isValidFontFamily), false);
});

test('line-height offers unitless numbers from 0 through 3 only', () => {
  for (const value of ['0', '1', '1.1', '1.5', '3', '.5', '2.999']) {
    assert.equal(isLineHeightMultiplier(value), true, value);
  }
  for (const value of [
    '3.01',
    '-0.1',
    '4',
    '1.5rem',
    '150%',
    '24px',
    'normal',
    'calc(1.5 * 1)',
    'clamp(1, 2, 3)',
    'var(--x)',
    'none',
    '',
    'inherit',
    '0.0625rem',
  ]) {
    assert.equal(isLineHeightMultiplier(value), false, JSON.stringify(value));
  }
  assert.equal(valuePredicateFor('line-height'), isLineHeightMultiplier);
});

test('line-height resolves chains and an ancestor override', () => {
  const lookup = lookupOf({ 'display-line-height': 'var(--line-height-small)', 'line-height-small': '1.1', border: '0.0625rem' });
  assert.equal(variableAccepted('var(--display-line-height)', lookup, isLineHeightMultiplier), true);
  assert.equal(variableAccepted('var(--border)', lookup, isLineHeightMultiplier), false);
  // An ancestor that redefines the variable changes the verdict: the lookup is the cascade there.
  const overridden = lookupOf({ 'line-height-small': '150%' });
  assert.equal(variableAccepted('var(--line-height-small)', overridden, isLineHeightMultiplier), false);
});

test('text-transform accepts its keywords, CSS-wide keywords and spec combinations', () => {
  const valid = [
    'none',
    'capitalize',
    'uppercase',
    'LOWERCASE',
    'full-width',
    'full-size-kana',
    'inherit',
    'initial',
    'unset',
    'revert',
    'revert-layer',
    'capitalize full-width',
    'full-width uppercase',
    'uppercase full-size-kana',
    'lowercase full-width full-size-kana',
  ];
  for (const value of valid) {
    assert.equal(isValidTextTransform(value), true, value);
  }
  assert.equal(valuePredicateFor('text-transform'), isValidTextTransform);
});

test('text-transform refuses everything else', () => {
  const invalid = [
    'balance',
    'ease',
    '200ms',
    '"Inter", sans-serif',
    'Arial',
    '1.5',
    '0.0625rem',
    'math-auto',
    'auto',
    'normal',
    'bold',
    '',
    'uppercase lowercase',
    'full-width full-width',
    'none uppercase',
    'inherit uppercase',
    'uppercase full-width full-size-kana capitalize',
    'var(--x)',
    'clamp(1rem, 2vw, 3rem)',
  ];
  for (const value of invalid) {
    assert.equal(isValidTextTransform(value), false, JSON.stringify(value));
  }
});

test('text-transform resolves chains and keeps none', () => {
  const lookup = lookupOf({ 'display-text-transform': 'none', 'h1-text-transform': 'var(--display-text-transform)', 'text-wrap': 'balance', ease: 'ease' });
  assert.equal(variableAccepted('var(--h1-text-transform)', lookup, isValidTextTransform), true);
  assert.equal(variableAccepted('var(--text-wrap)', lookup, isValidTextTransform), false);
  assert.equal(variableAccepted('var(--ease)', lookup, isValidTextTransform), false);
});

test('letter-spacing offers 0 and em or rem lengths from -1 to 1', () => {
  for (const value of ['0', '-0.05em', '0.02rem', '1em', '-1rem', '1rem', '-1em', '.5em', '0em', '0.0625rem']) {
    assert.equal(isLetterSpacingLength(value), true, value);
  }
  for (const value of [
    '1.01em',
    '-1.01rem',
    '-1.5rem',
    '2em',
    '1px',
    '0.5px',
    '5%',
    '1vh',
    '0.5',
    '1',
    'normal',
    'inherit',
    'initial',
    'calc(1em + 0.1em)',
    'calc(1em + 1rem)',
    'clamp(0em, 1em, 2em)',
    'var(--x)',
    '',
    '0.5 em',
  ]) {
    assert.equal(isLetterSpacingLength(value), false, JSON.stringify(value));
  }
  assert.equal(valuePredicateFor('letter-spacing'), isLetterSpacingLength);
});

test('letter-spacing resolves chains and an ancestor override', () => {
  const lookup = lookupOf({ 'display-letter-spacing': 'var(--letter-spacing-tight)', 'letter-spacing-tight': '-0.04em' });
  assert.equal(variableAccepted('var(--display-letter-spacing)', lookup, isLetterSpacingLength), true);
  const overridden = lookupOf({ 'letter-spacing-tight': '2em' });
  assert.equal(variableAccepted('var(--letter-spacing-tight)', overridden, isLetterSpacingLength), false);
});
