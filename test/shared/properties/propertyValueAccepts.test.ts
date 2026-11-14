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

test('the Weight picker offers numbers from 100 to 1000 only', () => {
  for (const weight of ['100', '400', '700', '1000', '320', '999.5']) {
    assert.equal(isOfferedFontWeight(weight), true, weight);
  }
  for (const weight of ['99', '90', '45', '23', '13', '7', '1.5', '0', '1001', '-100', '1rem', 'none', 'inherit', '']) {
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
