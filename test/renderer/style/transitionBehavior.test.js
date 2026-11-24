// Goal: editing a transition list keeps both the easing and `allow-discrete`.
// The behaviour keyword was read as the easing, so `display 0.3s ease
// allow-discrete` was written back without `ease`.
// Method: values are read by the panel's parser, one field is edited as the layer
// editor does (a spread over the layer), and the written text is compared. The
// negative space: a list with no behaviour keyword gains none.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadModule = require('../../helpers/rendererModule');

const { parseTransitions, serializeTransitions } = loadModule('src/features/style/model/transition.ts');

test('the easing survives beside allow-discrete', () => {
  const value = 'display 0.3s ease allow-discrete, overlay 0.3s ease-out 0.1s allow-discrete';
  assert.equal(serializeTransitions(parseTransitions(value)), value);
});

test('a new easing leaves the behaviour in place', () => {
  const [first] = parseTransitions('display 0.3s allow-discrete');
  assert.equal(first.timing, '');
  assert.equal(serializeTransitions([{ ...first, timing: 'linear' }]), 'display 0.3s linear allow-discrete');
});

test('a plain transition gains no behaviour', () => {
  assert.deepEqual(parseTransitions('opacity 200ms ease'), [{ property: 'opacity', duration: '200ms', delay: '', timing: 'ease' }]);
});
