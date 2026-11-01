// Exercise the pure union core through variant changes, restoration, invalid
// existing markup and bounded inputs. Frozen inputs make accidental mutation loud.
const assert = require('node:assert/strict');
const { createPropRules } = require('../../helpers/rendererModule')('src/features/props/propRules.ts');
const branch = (pins, forbids, defaults = {}, rules = {}) => Object.freeze({ pins, forbids, defaults, rules, docs: {} });
const union = Object.freeze({
  names: ['variant', 'label', 'pressed', 'emphasis'],
  branches: [
    branch(
      { variant: ['play'], emphasis: ['primary', 'secondary'] },
      [],
      {},
      {
        label: { prop: 'pressed', is: 'true', then: 'Pause', otherwise: 'Play' },
      },
    ),
    branch({ variant: ['close'], emphasis: ['primary', 'secondary', 'link'] }, ['pressed'], {
      label: 'Close',
    }),
  ],
});
const schema = Object.freeze([
  Object.freeze({ name: 'variant', type: 'enum', options: ['play', 'close'], unions: [union] }),
  Object.freeze({ name: 'label', type: 'string' }),
  Object.freeze({ name: 'pressed', type: 'boolean' }),
  Object.freeze({ name: 'emphasis', type: 'enum', options: ['primary', 'secondary', 'link'] }),
]);
const text = (value) => Object.freeze({ type: 'string', value });
const props = Object.freeze({ variant: text('play'), pressed: Object.freeze({ type: 'bare' }) });
const rules = createPropRules(schema, props);
assert.equal(rules.branchDefault('label'), 'Pause');
assert.deepEqual(rules.narrowOptions(schema[0]).options, ['play', 'close']);
assert.deepEqual(rules.narrowOptions(schema[3]).options, ['primary', 'secondary']);
const held = Object.freeze({ label: text('Custom') });
const change = rules.cascade({ fieldName: 'variant', value: text('close'), stash: held });
assert.deepEqual(change.patch, {
  variant: text('close'),
  pressed: undefined,
  label: text('Custom'),
});
assert.deepEqual(change.stash, { pressed: { type: 'bare' } });
assert.deepEqual(held, { label: text('Custom') });
assert.equal(props.variant.value, 'play');
const closed = createPropRules(schema, { ...props, ...change.patch });
assert.equal(closed.appliesNow(schema[2]), false);
assert.equal(closed.branchDefault('label'), 'Close');
const restored = closed.cascade({ fieldName: 'variant', value: text('play'), stash: change.stash });
assert.deepEqual(restored.patch, { variant: text('play'), pressed: { type: 'bare' } });
assert.deepEqual(restored.stash, {});
const rewritten = closed.cascade({ fieldName: 'pressed', value: undefined, stash: change.stash });
assert.deepEqual(rewritten.stash, {});
const invalid = createPropRules(schema, { variant: text('unknown') });
assert.equal(invalid.appliesNow(schema[2]), true);
assert.equal(invalid.branchDefault('label'), undefined);
const existing = createPropRules(schema, { variant: text('play'), emphasis: text('link') });
assert.deepEqual(existing.narrowOptions(schema[3]).options, ['primary', 'secondary', 'link']);
const independent = rules.cascade({
  fieldName: 'title',
  value: text('Hello'),
  stash: Object.freeze({ pressed: { type: 'bare' } }),
});
assert.deepEqual(independent.patch, { title: text('Hello') });
assert.deepEqual(independent.stash, { pressed: { type: 'bare' } });
assert.throws(() => createPropRules(Array(513).fill(schema[0]), {}), /schema limit exceeded/);
assert.throws(() => createPropRules([], Object.fromEntries(Array.from({ length: 257 }, (_, index) => [index, text('x')]))), /prop limit exceeded/);
assert.throws(() => createPropRules([{ ...schema[0], unions: Array(257).fill(union) }], {}), /union limit exceeded/);
assert.throws(() => createPropRules([{ ...schema[0], unions: [{ ...union, branches: Array(257).fill(union.branches[0]) }] }], {}), /branch limit exceeded/);
assert.throws(() => rules.cascade({ fieldName: 'x'.repeat(8193), value: undefined, stash: {} }), /field name limit exceeded/);
assert.throws(
  () =>
    rules.cascade({
      fieldName: 'variant',
      value: undefined,
      stash: Object.fromEntries(Array.from({ length: 513 }, (_, index) => [index, text('x')])),
    }),
  /stash limit exceeded/,
);
console.log('prop-rules: variant transitions, immutable snapshots, invalid markup and limits passed');
