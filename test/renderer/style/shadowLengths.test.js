// Goal: editing one layer of a shadow list, or a drop-shadow filter, keeps every
// length the author wrote. Only a few units were read as lengths, so `1pt` or
// `calc()` landed in the colour and the list was written back as
// `0 0px 0px 0px 1pt 2pt black`, which the browser drops whole.
// Method: the panel's three parsers read values written with other units and math
// functions, and the fields and the written text are compared. The negative space:
// colour functions, hex and named colours are still the colour.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadModule = require('../../helpers/rendererModule');

const box = loadModule('src/features/style/model/boxShadow.ts');
const text = loadModule('src/features/style/model/textShadow.ts');
const filter = loadModule('src/features/style/model/filter.ts');

test('a box shadow keeps lengths of any unit and math functions', () => {
  const roundTrip = (value) => box.serializeBoxShadows(box.parseBoxShadows(value));
  assert.equal(roundTrip('0 1pt 2pt black'), '0 1pt 2pt 0px black');
  assert.equal(roundTrip('0 0 calc(1px + 2px) max(1px, 2px) black'), '0 0 calc(1px + 2px) max(1px, 2px) black');
  assert.equal(roundTrip('inset +1dvh -.5lh 2cqmin 0 #123abc'), 'inset +1dvh -.5lh 2cqmin 0 #123abc');
});

test('a text shadow and a drop shadow keep them too', () => {
  assert.equal(text.serializeShadows(text.parseShadows('1ch 1lh clamp(1px, 1em, 4px) red')), '1ch 1lh clamp(1px, 1em, 4px) red');
  const value = 'drop-shadow(1pt calc(2px * 2) 0.5lh black)';
  assert.equal(filter.serializeFilters(filter.parseFilters(value)), value);
});

test('colours are still read as the colour', () => {
  for (const color of ['rgb(0 0 0 / 50%)', '#000', '#1e1e1e', 'transparent', 'oklch(0.5 0.1 200)', 'color-mix(in srgb, red, blue)', 'var(--shade)']) {
    const [shadow] = box.parseBoxShadows(`0 2px 4px 0 ${color}`);
    assert.equal(shadow.color, color);
    assert.equal(shadow.spread, '0');
  }
});
