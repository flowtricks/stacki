// Goal: shared/properties/valueSlot.ts decides whether a variable's computed value is valid at
// the place it would be inserted: the same value is refused directly in `width` and accepted in
// `calc(2rem * [slot])`, refused for `color` and accepted as a `color-mix` percentage.
// Methodology: `supports` is injected, so the module is pure. The fake below is a small stand-in
// for the engine's grammar covering exactly the fixture's properties and expressions; the real
// `CSS.supports` call is exercised in the renderer test through the picker. Each case states the
// expression the engine would be asked, so a change in how the string is built fails loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterBySlot, isWholeSlot, slotAccepts, SLOT_MARK, slotOfMarked, VerdictCache, VALUE_SLOT_LIMITS } from '#dist/shared/properties/valueSlot.js';

const LENGTH = /^-?[\d.]+(?:rem|em|px)$/;
const NUMBER = /^-?[\d.]+$/;
const PERCENT = /^-?[\d.]+%$/;
const COLOR = /^(?:#[0-9a-f]{3,8}|red|currentcolor|transparent)$/i;

// A stand-in for the engine's grammar over the fixture's properties.
const asked: string[] = [];
const supports = (property: string, value: string): boolean => {
  asked.push(`${property}: ${value}`);
  const calculate = /^calc\((.+)\)$/.exec(value);
  if (calculate !== null) {
    const parts = (calculate[1] ?? '').split(/\s+([*+/-])\s+/);
    const [left = '', operator = '', right = ''] = parts;
    if (operator === '*') {
      return (LENGTH.test(left) && NUMBER.test(right)) || (NUMBER.test(left) && LENGTH.test(right));
    }
    if (operator === '+' || operator === '-') {
      return LENGTH.test(left) && LENGTH.test(right);
    }
    return false;
  }
  const mix = /^color-mix\(in srgb, red (.+), transparent 90%\)$/.exec(value);
  if (mix !== null) {
    return PERCENT.test(mix[1] ?? '');
  }
  switch (property) {
    case 'width':
    case 'font-size':
      return LENGTH.test(value) || PERCENT.test(value) || value === 'auto';
    case 'color':
      return COLOR.test(value);
    case 'margin':
      return value.split(/\s+/).every((part) => LENGTH.test(part) || part === '0' || part === 'auto');
    case 'font-weight':
      return NUMBER.test(value) || ['normal', 'bold'].includes(value);
    default:
      return false;
  }
};
const slot = (marked: string) => slotOfMarked(marked.replace('[slot]', SLOT_MARK));

test('slotOfMarked splits at the mark and refuses two', () => {
  assert.deepEqual(slotOfMarked(`calc(2rem * ${SLOT_MARK})`), { before: 'calc(2rem * ', after: ')' });
  assert.equal(slotOfMarked('1rem'), undefined);
  assert.throws(() => slotOfMarked(`${SLOT_MARK}${SLOT_MARK}`), /one insertion point/);
});

test('the whole value is the slot when only space and !important surround it', () => {
  assert.equal(isWholeSlot(undefined), true);
  assert.equal(isWholeSlot(slot('[slot]')), true);
  assert.equal(isWholeSlot(slot('  [slot] !important')), true);
  assert.equal(isWholeSlot(slot('calc(2rem * [slot])')), false);
  assert.equal(isWholeSlot(slot('1rem [slot]')), false);
});

test('a unitless number is refused for width and font-size directly, accepted as a calc() factor', () => {
  for (const property of ['width', 'font-size']) {
    assert.equal(slotAccepts(property, undefined, '1.5', supports), false, property);
    assert.equal(slotAccepts(property, slot('calc(2rem * [slot])'), '1.5', supports), true, property);
  }
  assert.equal(slotAccepts('width', undefined, '1rem', supports), true);
});

test('a length is valid after + and refused after * in calc()', () => {
  assert.equal(slotAccepts('width', slot('calc(2rem + [slot])'), '1rem', supports), true);
  assert.equal(slotAccepts('width', slot('calc(2rem * [slot])'), '1rem', supports), false);
});

test('a percentage is refused for color directly and accepted in a color-mix slot', () => {
  assert.equal(slotAccepts('color', undefined, '10%', supports), false);
  assert.equal(slotAccepts('color', slot('color-mix(in srgb, red [slot], transparent 90%)'), '10%', supports), true);
  assert.equal(slotAccepts('color', undefined, '#ff0000', supports), true);
});

test('a shorthand slot judges the whole multi-value string', () => {
  assert.equal(slotAccepts('margin', slot('1rem [slot]'), '2rem', supports), true);
  assert.equal(slotAccepts('margin', slot('1rem [slot]'), '1.5', supports), false);
  assert.equal(slotAccepts('margin', slot('1rem [slot] 3rem'), 'red', supports), false);
});

test('a custom property accepts anything, and an unknown computed value is refused', () => {
  assert.equal(slotAccepts('--anything', undefined, 'whatever', supports), true);
  assert.equal(slotAccepts(undefined, undefined, 'whatever', supports), true);
  assert.equal(slotAccepts('width', undefined, undefined, supports), false);
  assert.equal(slotAccepts('width', undefined, '  ', supports), false);
});

test('the curated narrowing applies to the whole value only, never inside an expression', () => {
  // font-weight 450 is a number the engine takes; the curated step-of-50 rule refuses it directly...
  assert.equal(slotAccepts('font-weight', undefined, '450', supports), true);
  assert.equal(slotAccepts('font-weight', undefined, '400', supports), true);
  assert.equal(slotAccepts('font-weight', undefined, '274', supports), false);
  // ...and the same 274 is not narrowed when the slot is inside an expression the engine accepts.
  assert.equal(
    slotAccepts('font-weight', slot('calc(1 + [slot])'), '274', () => true),
    true,
  );
});

test('the engine is asked the expression with the candidate in place', () => {
  asked.length = 0;
  slotAccepts('width', slot('calc(2rem * [slot])'), '1.5', supports);
  assert.equal(asked[0], 'width: calc(2rem * 1.5)');
});

const candidates = (computed: readonly (string | undefined)[], keepIndex = -1) =>
  computed.map((value, index) => ({ item: `v${index}`, computed: value, keep: index === keepIndex }));

test('filterBySlot keeps what fits, plus the applied variable even when it fails', () => {
  const cache = new VerdictCache();
  const list = candidates(['1rem', '1.5', '10%', undefined], 1);
  assert.deepEqual(filterBySlot(list, 'width', undefined, supports, cache), ['v0', 'v1', 'v2']);
});

test('filterBySlot never empties the list because the surroundings are half typed', () => {
  const cache = new VerdictCache();
  const list = candidates(['1rem', '2rem']);
  // `calc(2rem * ` is not a complete expression, so nothing passes in the slot: use the property.
  assert.deepEqual(filterBySlot(list, 'width', slot('calc(2rem * [slot]'), supports, cache), ['v0', 'v1']);
  // A slot that does admit some candidates is not widened.
  assert.deepEqual(filterBySlot(candidates(['1rem', '1.5']), 'width', slot('calc(2rem * [slot])'), supports, new VerdictCache()), ['v1']);
});

test('the verdict cache answers repeats without asking and stays within its bound', () => {
  const cache = new VerdictCache(3);
  asked.length = 0;
  const list = candidates(['1rem', '2rem']);
  filterBySlot(list, 'width', undefined, supports, cache);
  const first = asked.length;
  filterBySlot(list, 'width', undefined, supports, cache);
  assert.equal(asked.length, first, 'the second pass asked nothing');
  for (let index = 0; index < 20; index += 1) {
    filterBySlot(candidates([`${index}rem`]), 'width', undefined, supports, cache);
  }
  assert.equal(cache.size, 3);
  assert.throws(() => new VerdictCache(0), /positive whole number/);
});

test('past the per-pass bound the remaining candidates are offered unasked', () => {
  const many = candidates(Array.from({ length: VALUE_SLOT_LIMITS.checksPerPassMax + 5 }, () => '1.5'));
  const result = filterBySlot(many, 'width', undefined, supports, new VerdictCache(10));
  assert.equal(result.length, 5, 'the five past the bound are offered; the asked ones were refused');
});
