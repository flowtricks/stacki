// Goal: a list prop whose type says what its items are carries that kind, so
// the panel draws every item with the control for it (a `number[]` as number
// rows) instead of guessing from the values.
//
// Methodology: one tiny component per declared type, run through
// parsePropSchema as the scan does. The table is the contract: each declared
// type -> the item kind (and a choice's words, a number's bounds). The negative
// space is pinned beside it: a list of objects, a tuple, an unknown element
// type and a plain (non-list) prop carry no item kind.
// Run on its own with `node test/electron/parse/listItemKind.test.js`.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parsePropSchema } = require('#dist/electron/parse/astroParser.js');

const read = (typeText) => parsePropSchema(`---\ninterface Props {\n  x?: ${typeText};\n}\n---\n<div />`).find((entry) => entry.name === 'x');

test('a list of plain values states its item kind', () => {
  assert.equal(read('number[]').itemKind, 'number');
  assert.equal(read('Array<number>').itemKind, 'number');
  assert.equal(read('readonly number[]').itemKind, 'number');
  assert.equal(read('string[]').itemKind, 'text');
  assert.equal(read('Array<string>').itemKind, 'text');
  assert.equal(read('boolean[]').itemKind, 'switch');
});

test('a list of choices carries its words', () => {
  const choices = read("('a' | 'b')[]");
  assert.equal(choices.itemKind, 'choice');
  assert.deepEqual(choices.options, ['a', 'b']);
});

test('what is not a list of plain values has no item kind', () => {
  assert.equal(read('{ title: string }[]').itemKind, undefined, 'a list of objects is described by its shape');
  assert.equal(read('[number, number]').itemKind, undefined, 'a tuple');
  assert.equal(read('any[]').itemKind, undefined, 'an unknown element type');
  assert.equal(read('number').itemKind, undefined, 'a plain number');
  assert.equal(read('string').itemKind, undefined, 'a plain string');
});
