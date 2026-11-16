// What each item of a plain list is, and the control that draws it.
//
//   node test/renderer/props/listItemType.test.js
//
// `widths: number[]` must draw number fields, not text rows. The kind comes
// from the prop's declared type, else from the literal items; bound items
// abstain, and anything mixed has no one kind. Checked here, on the pure model:
// the inference table (declared wins, every literal mix, empty, bound), the
// kind -> control mapping for every kind, the typed blank Add item makes
// (including a number held inside its declared bounds), and that a list with an
// item bound to data is read as a list in `bindable` mode and as code in the
// default `literal` mode (so every caller that reads items as words is
// unchanged). Fixtures are generated here.

const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { arrayItems, arrayText, itemHoldsCode } = load('src/features/props/arrayValue.ts');
const { listItemKindOf, kindOfItem, controlOfItemKind, defaultItemOf, itemRowField, declaredItemTypeOf } = load('src/features/props/listItemType.ts');

const items = (source) => arrayItems(source, 0, 'bindable');
const kindOf = (source, declared, shape) => listItemKindOf(declared, items(source), shape);

// Inference from the values.
assert.equal(kindOf('[320, 480, 640]'), 'number');
assert.equal(kindOf('["a", "b"]'), 'text');
assert.equal(kindOf('[true, false]'), 'switch');
assert.equal(kindOf('[1, "a"]'), 'mixed', 'numbers and words have no one kind');
assert.equal(kindOf('[true, 1]'), 'mixed');
assert.equal(kindOf('[]'), 'mixed', 'an empty list declaring nothing has no kind');
assert.equal(kindOf('[{ a: 1 }, { a: 2 }]'), 'object');
assert.equal(kindOf('[{ a: 1 }, 2]'), 'mixed', 'objects beside plain values');
// Bound items abstain: they are values of whatever kind the data is.
assert.equal(kindOf('[320, card.width, 640]'), 'number');
assert.equal(kindOf('[card.width]'), 'mixed', 'only bound items: nothing to infer from');
// A declared type wins, and so does a declared object shape.
assert.equal(kindOf('["a"]', { kind: 'number' }), 'number');
assert.equal(kindOf('[]', { kind: 'switch' }), 'switch');
assert.equal(kindOf('[]', undefined, [{ name: 'a', kind: 'text' }]), 'object');

// A single item by its own value.
assert.equal(kindOfItem({ text: '5', quote: undefined }), 'number');
assert.equal(kindOfItem({ text: 'true', quote: undefined }), 'switch');
assert.equal(kindOfItem({ text: 'x', quote: '"' }), 'text');
assert.equal(kindOfItem({ text: 'card.title', quote: undefined }), 'text', 'code is shown as the value it is bound to');

// The declared type a prop field carries.
assert.equal(declaredItemTypeOf({}), undefined);
assert.deepEqual(declaredItemTypeOf({ itemKind: 'number', min: 1, max: 9, step: 2 }), {
  kind: 'number',
  options: undefined,
  numeric: undefined,
  min: 1,
  max: 9,
  step: 2,
});

// The mapping: one control and one field type per kind.
assert.deepEqual(controlOfItemKind('text'), { control: 'text', fieldType: 'string' });
assert.deepEqual(controlOfItemKind('number'), { control: 'number', fieldType: 'number' });
assert.deepEqual(controlOfItemKind('switch'), { control: 'toggle', fieldType: 'boolean' });
assert.deepEqual(controlOfItemKind('choice'), { control: 'dropdown', fieldType: 'enum' });
assert.deepEqual(controlOfItemKind('object'), { control: 'fields', fieldType: 'other' });
assert.deepEqual(controlOfItemKind('mixed'), { control: 'generic', fieldType: 'other' });

// The field a row is drawn with carries the kind's type and bounds.
const numberField = itemRowField('number', '1', { kind: 'number', min: 100, max: 2000, step: 10 });
assert.equal(numberField.type, 'number');
assert.deepEqual([numberField.min, numberField.max, numberField.step], [100, 2000, 10]);
assert.equal(itemRowField('text', '1', undefined).type, 'string');
assert.equal(itemRowField('switch', '1', undefined).type, 'boolean');
const choice = itemRowField('choice', '1', { kind: 'choice', options: ['a', 'b'], numeric: true });
assert.deepEqual([choice.type, choice.options, choice.numeric], ['enum', ['a', 'b'], true]);

// Add item makes a typed blank.
assert.deepEqual(defaultItemOf('number', undefined, '"'), { text: '0', quote: undefined });
assert.deepEqual(defaultItemOf('number', { kind: 'number', min: 320 }, '"'), { text: '320', quote: undefined }, 'inside the lower bound');
assert.deepEqual(defaultItemOf('number', { kind: 'number', max: -5 }, '"'), { text: '-5', quote: undefined }, 'inside the upper bound');
assert.deepEqual(defaultItemOf('switch', undefined, '"'), { text: 'false', quote: undefined });
assert.deepEqual(defaultItemOf('choice', { kind: 'choice', options: ['x', 'y'] }, "'"), { text: 'x', quote: "'" });
assert.deepEqual(defaultItemOf('text', undefined, "'"), { text: '', quote: "'" });
assert.throws(() => defaultItemOf('text', undefined, 'x'), /a quote is one/);

// Items bound to data: a list in bindable mode, code in the default mode.
assert.equal(arrayItems('[320, card.width]'), undefined, 'literal mode keeps the old reading');
assert.equal(items('[320, card.width]').length, 2);
assert.equal(itemHoldsCode(items('[320, card.width]')[1]), true);
assert.equal(itemHoldsCode(items('[320, card.width]')[0]), false);
assert.equal(arrayText(items('[320, card.width, "a"]')), '[320, card.width, "a"]', 'and it writes back as it was');
// Negative space: what stays a program.
for (const program of ['[...rest]', '[a, ...rest]', '[{ a: 1 }, ...x]', '[1, , 2]', '[[1], [2]]', '[1', 'widths']) {
  assert.equal(items(program), undefined, `${program} is code`);
}
console.log('listItemType ok');
