// Goal: class search exposes matches beyond the former twelve-row cutoff.
// Method: query a large utility family, select its last match, and check
// exclusion and prefix ranking using the same search as the rendered menu.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classMatches } = require('../../helpers/rendererModule')('src/features/props/ClassInput.tsx');

test('all matching classes remain available to the scrollable menu', () => {
  const suggestions = Array.from({ length: 100 }, (_, index) => `margin-bottom-${index}`);
  const matches = classMatches('margin', suggestions, ['margin-bottom-0']);
  assert.equal(matches.length, 99);
  assert.equal(matches.at(-1), 'margin-bottom-99');
  assert.equal(matches.includes('margin-bottom-0'), false);
  assert.deepEqual(classMatches('', suggestions, []), []);
  assert.deepEqual(classMatches('margin', ['my-margin', 'margin'], []), ['margin', 'my-margin']);
});

test('class search is fuzzy: the letters typed, in order, anywhere in the name', () => {
  const suggestions = ['button-primary', 'hero_title', 'text-style-h1', 'primary-button'];
  assert.deepEqual(classMatches('btnprim', suggestions, []), ['button-primary'], 'scattered letters find the class');
  assert.deepEqual(classMatches('hrtit', suggestions, []), ['hero_title']);
  assert.deepEqual(classMatches('prim', suggestions, [])[0], 'primary-button', 'a prefix outranks a later word');
  assert.deepEqual(classMatches('BTN', suggestions, []), ['button-primary', 'primary-button'], 'case does not matter');
  assert.deepEqual(classMatches('zzz', suggestions, []), [], 'letters not in order find nothing');
  assert.deepEqual(classMatches('btnprim', suggestions, ['button-primary']), [], 'a class already on the element is not offered');
});
