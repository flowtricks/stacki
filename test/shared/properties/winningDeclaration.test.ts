// Goal: the canvas's report of a custom property's winning declaration is parsed and bounded before
// the picker shows it as a row's text. Methodology: a known-good declaration passes, each field of
// each known-bad shape fails, the reply's dictionary is bounded, and the whitespace-only comparison
// treats runs of spaces as equal while a different expression is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOUNDARY_LIMITS } from '#dist/shared/core/boundary.js';
import { parseWinningDeclaration, sameExpression } from '#dist/shared/properties/winningDeclaration.js';

const good = { expression: 'var(--brand)', selector: '.theme-dark', file: '/src/styles/theme.css', depth: 1, ancestor: '.theme-dark' };

test('a known-good declaration parses, with or without a file', () => {
  assert.deepEqual(parseWinningDeclaration(good), good);
  const withoutFile = { expression: good.expression, selector: good.selector, depth: good.depth, ancestor: good.ancestor };
  assert.equal(parseWinningDeclaration(withoutFile).file, undefined);
});

test('each malformed field is refused', () => {
  for (const bad of [
    undefined,
    'var(--brand)',
    [],
    { ...good, expression: 1 },
    { ...good, selector: undefined },
    { ...good, depth: -1 },
    { ...good, depth: 1.5 },
    { ...good, depth: '1' },
    { ...good, ancestor: {} },
    { ...good, file: 7 },
    { ...good, expression: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) },
  ]) {
    assert.throws(() => parseWinningDeclaration(bad), Error, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('expressions compare by their words, not their spacing', () => {
  assert.equal(sameExpression('calc( 1rem  +  2px )', 'calc( 1rem + 2px )'), true);
  assert.equal(sameExpression(' var(--a) ', 'var(--a)'), true);
  assert.equal(sameExpression('var(--a)', 'var(--b)'), false);
  assert.throws(() => sameExpression('x'.repeat(9000), 'x'), /exceeds the attribute limit/);
});
