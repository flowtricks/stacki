// Goal: the grammar slot at the caret decides which kinds of variable belong there, so a reference
// typed after `transparent` in a color-mix() offers percentages and nothing else.
// Method: the pure reader (shared/properties/functionSlot.ts) is driven with a table of expressions
// cut at the caret: the reported color-mix() case, the colour space slot, colour and component
// functions, the right side of `*` and `/`, nesting, a caret in the middle of an expression, chips
// (var() read through a resolver) and slots that are not modelled (undefined: the property decides).
// The negative space: a variable of unknown kind is refused in a strict slot, an empty slot is an
// empty set, and an over-deep text is not read.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { functionSlotAt, valueClassOf, ruleAccepts } = load('shared/properties/functionSlot.ts');

let checked = 0;
const known = { '--dark-900': '#111', '--full': '100%', '--small': '70rem', '--ratio': '1.5', '--gap': '2rem' };
const resolve = (name) => known[name];
const classes = (before) => {
  const rule = functionSlotAt(before, resolve);
  return rule === undefined ? undefined : [...rule.classes].sort();
};
const equal = (before, expected, message) => {
  assert.deepEqual(classes(before), expected, `${message}: ${JSON.stringify(before)}`);
  checked++;
};

// The reported case: a percentage after a colour, in the second colour-mix argument.
equal('color-mix(in srgb, var(--dark-900) 10%, transparent ', ['percentage'], 'after a keyword colour');
equal('color-mix(in srgb, red ', ['percentage'], 'after a colour');
equal('color-mix(in srgb, var(--dark-900) ', ['percentage'], 'after a chip that is a colour');
equal('color-mix(in srgb, 10% ', ['color'], 'after a percentage the colour');
equal('color-mix(in srgb, ', ['color', 'percentage'], 'a fresh argument: a colour or a percentage');
equal('color-mix(in srgb, red 10%, ', ['color', 'percentage'], 'the second argument starts fresh');
equal('color-mix(in srgb, red 10% ', [], 'a colour and a percentage fill the slot');
equal('color-mix(', [], 'the colour space slot takes no variable');
equal('color-mix(in ', [], 'still the colour space');
equal('color-mix(in srgb, red, blue, ', [], 'no third argument');
equal('calc(1px + color-mix(in srgb, red ', ['percentage'], 'nested in a calc');
equal('color-mix(in srgb, var(--unknown) ', ['color', 'percentage'], 'an unreadable chip allows either');

// Colour component slots.
equal('rgb(', ['none', 'number', 'percentage'], 'rgb red');
equal('rgb(1 2 ', ['none', 'number', 'percentage'], 'rgb blue');
equal('rgb(1 2 3 / ', ['none', 'number', 'percentage'], 'rgb alpha');
equal('rgb(1 2 3 / 50% ', [], 'nothing after the alpha');
equal('hsl(', ['angle', 'none', 'number'], 'hsl hue');
equal('hsl(120deg, ', ['none', 'number', 'percentage'], 'hsl saturation with commas');
equal('oklch(50% 0.2 ', ['angle', 'none', 'number'], 'oklch hue');
equal('rgb(from red ', undefined, 'relative colours are the property’s');

// Operators in math.
equal('calc(2rem * ', ['number'], 'a length times: the right side is a number');
equal('calc(2 * ', ['angle', 'length', 'number', 'percentage', 'time'], 'a number times: anything numeric');
equal('calc(var(--ratio) * ', ['angle', 'length', 'number', 'percentage', 'time'], 'a chip that is a number times');
equal('calc(var(--gap) * ', ['number'], 'a chip that is a length times');
equal('calc(100% / ', ['number'], 'a divisor is a number');
equal('calc(2rem + ', undefined, 'plus is the property’s');
equal('clamp(1rem, 2 * ', ['angle', 'length', 'number', 'percentage', 'time'], 'after a comma in clamp');
equal('calc(min(1px, 2px) * ', ['number'], 'a nested call is the left side');
equal('calc((1rem + 2rem) * ', undefined, 'a parenthesised left side is not read');
equal('calc(unknown * ', undefined, 'an unknown left side is the property’s');

// Not modelled, and the middle of an expression.
equal('var(--x, ', undefined, 'a var() fallback');
equal('linear-gradient(red, ', undefined, 'gradients');
equal('2rem ', undefined, 'no function');
equal('', undefined, 'an empty value');
equal('color-mix(in srgb, red ', ['percentage'], 'the text after the caret never matters');
assert.equal(functionSlotAt('('.repeat(40), resolve), undefined);
checked++;

// What a value is.
const kind = (value, hint) => valueClassOf(value, hint);
for (const [value, expected] of [
  ['100%', 'percentage'],
  ['70rem', 'length'],
  ['1.5', 'number'],
  ['#fff', 'color'],
  ['rgb(1 2 3)', 'color'],
  ['color-mix(in srgb, red, blue)', 'color'],
  ['calc(100% - 2rem)', 'length'],
  ['calc(1rem + 2px)', 'length'],
  ['clamp(1rem, 2vw, 3rem)', 'length'],
  ['calc(2 * 3)', 'number'],
  ['45deg', 'angle'],
  ['200ms', 'time'],
  ['none', 'none'],
  ['balance', 'keyword'],
  ['transparent', 'color'],
  ['var(--x)', 'unknown'],
  ['', 'unknown'],
]) {
  assert.equal(kind(value), expected, value);
  checked++;
}
assert.equal(kind('rebeccapurple', 'Color'), 'color', 'a colour name by its declared type');
assert.equal(kind(undefined), 'unknown', 'no value is unknown');
checked += 2;

// The screenshot: only percentage variables appear after transparent.
const rule = functionSlotAt('color-mix(in srgb, var(--dark-900) 10%, transparent ', resolve);
const offered = [
  ['full', '100%'],
  ['small', '70rem'],
  ['main', 'calc(100vw - 2rem)'],
  ['transform', 'none'],
  ['wrap', 'balance'],
  ['ink', '#111'],
  ['mystery', undefined],
]
  .filter(([, value]) => ruleAccepts(rule, value, undefined))
  .map(([name]) => name);
assert.deepEqual(offered, ['full']);
checked++;

console.log(`function-slot: ${checked} passed`);
