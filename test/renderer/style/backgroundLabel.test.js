// Goal: the "Image & gradient" label lights up for layers written with the
// `background` shorthand. `.divider::before { background: radial-gradient(…) }`
// filled the layer list (read from the shorthand) while the label checked only
// `background-image`, so it stayed unlit. Method: the label's property choice
// over each way the layers can be set, and the negative space: nothing set,
// and `background-image: none` beside a shorthand.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { layerSourceProp } = load('src/features/style/BackgroundSection.tsx');

const prop = (value) => ({ source: 'selected', overridden: false, winner: { selectorText: '.divider::before', value, important: false }, contributors: [] });
const reader = (values) => (name) => (values[name] === undefined ? undefined : prop(values[name]));

assert.equal(layerSourceProp(reader({ 'background-image': 'linear-gradient(red, blue)' })), 'background-image');
assert.equal(layerSourceProp(reader({ background: 'radial-gradient(red, blue) 0 0 / 10px repeat-x' })), 'background', 'only the shorthand sets them');
assert.equal(layerSourceProp(reader({ 'background-image': 'none', background: 'radial-gradient(red, blue)' })), 'background');
assert.equal(layerSourceProp(reader({ 'background-image': 'url(a.png)', background: 'red' })), 'background-image', 'a longhand image wins over a shorthand');
assert.equal(layerSourceProp(reader({})), 'background-image', 'nothing set: the image property, unlit');
console.log('background label: ok');
