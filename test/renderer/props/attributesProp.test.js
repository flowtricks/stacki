// Goal: an element connected to a component's attributes prop keeps the order
// that gives it meaning, and attribute names get honest advice.
//
// Method: the pure modules, bundled as the app bundles them. An element's
// props are an ordered record, a spread keyed by its source (`...rest`), as
// the page parser writes them. Connecting puts the prop's defaults before the
// spread and the element's own attributes after it; the cases read that back,
// replace the defaults, disconnect, and check the negative space: a default
// named like an own attribute, an element with no spread, class and
// directives never counted as defaults. Then the advisory name table: per-tag
// validity, the names that are always valid, reserved names, and a custom
// element that takes any name.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const binding = load('src/editor/attributesBinding.ts');
const names = load('src/editor/htmlAttributes.ts');

const text = (value) => ({ type: 'string', value });

test('connecting writes the defaults before the spread and keeps the element’s own after it', () => {
  const own = { class: text('card'), 'data-text': { type: 'bare' } };
  const bound = binding.boundAttributes(own, 'rest', [{ name: 'data-testing', value: '1' }]);
  assert.deepEqual(Object.keys(bound), ['data-testing', '...rest', 'class', 'data-text']);
  assert.deepEqual(bound['...rest'], { type: 'spread', value: 'rest' });
  assert.deepEqual(binding.readAttributesBinding(bound, 'rest'), { defaults: [{ name: 'data-testing', value: '1' }], own: ['class', 'data-text'] });
});

test('an existing `{...rest}` element reads back with its before and after attributes', () => {
  const parsed = { class: text('wrap'), 'data-a': text('x'), hidden: { type: 'bare' }, '...rest': { type: 'spread', value: 'rest' }, 'data-text': text('') };
  assert.deepEqual(binding.readAttributesBinding(parsed, 'rest'), {
    defaults: [
      { name: 'data-a', value: 'x' },
      { name: 'hidden', value: '' },
    ],
    own: ['data-text'],
  });
  assert.equal(binding.readAttributesBinding(parsed, 'other'), undefined, 'a spread of another value is not this prop');
  assert.equal(binding.readAttributesBinding({ class: text('x') }, 'rest'), undefined);
});

test('editing the defaults replaces only them; a default named like an own attribute is dropped', () => {
  const bound = binding.boundAttributes({ id: text('a') }, 'rest', [{ name: 'data-one', value: '1' }]);
  const edited = binding.boundAttributes(bound, 'rest', [
    { name: 'data-two', value: '2' },
    { name: 'id', value: 'shadowed' },
  ]);
  assert.deepEqual(Object.keys(edited), ['data-two', '...rest', 'id']);
  assert.deepEqual(edited.id, text('a'), 'the element’s own id wins, as it would in the browser');
});

test('disconnecting takes out the spread and the defaults, leaving the element’s own attributes', () => {
  const bound = binding.boundAttributes({ class: text('card') }, 'rest', [{ name: 'data-x', value: '1' }]);
  const out = binding.unboundAttributes(bound, 'rest');
  assert.deepEqual(out, { class: text('card') });
  assert.deepEqual(binding.unboundAttributes({ id: text('a'), gone: undefined }, 'rest'), { id: text('a') }, 'nothing to disconnect leaves the attributes');
  assert.throws(() => binding.spreadKey('not valid'), /rest binding is an identifier/);
});

test('attribute names are checked against the tag, with the always-valid names allowed everywhere', () => {
  assert.equal(names.attributeValidOn('required', 'input'), true);
  assert.equal(names.attributeValidOn('required', 'div'), false);
  assert.equal(names.attributeValidOn('data-anything', 'div'), true);
  assert.equal(names.attributeValidOn('aria-label', 'span'), true);
  assert.equal(names.attributeValidOn('onclick', 'p'), true);
  assert.equal(names.attributeValidOn('role', 'section'), true);
  assert.equal(names.attributeValidOn('anything', 'my-widget'), true, 'a custom element takes any name');
  const on = (tag, more = {}) => ({ tag, reserved: [], own: undefined, taken: [], ...more });
  assert.equal(names.attributeNameNote('required', on('div')), 'required isn’t an attribute of <div>.');
  assert.equal(names.attributeNameNote('href', on('a')), undefined);
  assert.equal(names.attributeNameNote('set:html', on('div')), 'This is a reserved name.');
  assert.equal(names.attributeNameNote('client:load', on('div')), 'This is a reserved name.');
  assert.equal(names.attributeNameNote('title', on(undefined, { reserved: ['title'] })), 'This is a reserved name.', 'an instance attribute named like a prop');
  assert.equal(names.attributeNameNote('anything', on(undefined)), undefined, 'an instance without a tag notes reserved names only');
  assert.equal(names.attributeNameNote('', on('div')), undefined);
});

test('a name is noted only as it is typed for a new or renamed attribute, never as the attribute already has it', () => {
  const on = (tag, more = {}) => ({ tag, reserved: [], own: undefined, taken: [], ...more });
  assert.equal(names.attributeNameNote('class:list', on('div', { own: 'class:list' })), undefined, 'an existing class:list is what the file says');
  assert.equal(names.attributeNameNote('set:html', on('div', { own: 'set:html' })), undefined, 'and so is any existing directive');
  assert.equal(names.attributeNameNote('class:list', on('div')), 'Classes are edited in the Style panel.', 'adding one gets a calm hint');
  assert.equal(names.attributeNameNote('class', on('div', { own: 'id' })), 'Classes are edited in the Style panel.', 'renaming onto one too');
  assert.equal(names.attributeNameNote('class', on(undefined)), undefined, 'a tag with no class field takes class like any attribute');
  assert.equal(names.attributeNameNote('id', on('div', { taken: ['id'] })), 'id is already on this element.');
  assert.equal(names.attributeNameNote('id', on('div', { own: 'id', taken: [] })), undefined);
});
