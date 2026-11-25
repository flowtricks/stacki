// Goal: an element's starting selector is its own, never a utility's
// (src/features/style/model/defaultSelector.ts, used by upgradedDefault).
// Method: the pure priority as a table with its negative space. A regular class rule beats
// everything; with none, the component's `:where(.base)` beats utilities and the tag, the
// base class before a modifier unless only the modifier has a rule; with none the tag; with
// only utilities there is no pick here (the caller's older rules apply). Then upgradedDefault
// itself for the owner's element, `h2.heading.heading--2.u-text-center.u-text-balance`, and a
// manual pick: the upgrade only runs while a default is pending, which a pick clears.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const model = load('src/features/style/model/defaultSelector.ts');

const CLASSES = ['heading', 'heading--2', 'u-text-center', 'u-text-balance'];
const pick = (styled, classes = CLASSES, tag = 'h2') => model.defaultSelectorPick({ styled, classes, tag });

test('a regular class selector beats :where, utilities and the tag', () => {
  assert.equal(pick(['h2', ':where(.heading)', '.u-text-center', '.heading']), '.heading');
  assert.equal(pick(['.u-text-center', '.heading--2', ':where(.heading)']), '.heading--2');
});

test(':where(.base) beats utilities and the tag', () => {
  assert.equal(pick(['.u-text-center', '.u-text-balance', 'h2', ':where(.heading)', ':where(.heading--2)']), ':where(.heading)');
});

test('a modifier is chosen only when its base has no rule', () => {
  assert.equal(pick(['.u-text-center', ':where(.heading--2)', ':where(.heading)']), ':where(.heading)');
  assert.equal(pick(['.u-text-center', ':where(.heading--2)', 'h2']), ':where(.heading--2)');
  assert.equal(pick([':where(.card__title)', ':where(.card)'], ['card__title', 'card']), ':where(.card)');
});

test('only utilities: no pick; only the tag: the tag', () => {
  assert.equal(pick(['.u-text-center', '.u-text-balance']), undefined);
  assert.equal(pick(['.u-text-center', 'h2']), 'h2');
  assert.equal(pick([]), undefined);
});

test('selectors that are not this element’s are not picked', () => {
  assert.equal(pick([':where(.other)', '.other', ':where(.heading):hover', '.heading .x'], CLASSES, 'h2'), undefined);
  assert.equal(pick(['h3'], CLASSES, 'h2'), undefined);
  assert.equal(model.defaultSelectorPick({ styled: ['h2'], classes: CLASSES, tag: undefined }), undefined);
});

test('utility classes are recognised by the u- prefix only', () => {
  assert.equal(model.isUtilityClassName('u-text-center'), true);
  assert.equal(model.isUtilityClassName('user-card'), false);
  assert.equal(model.isUtilityClassName('heading'), false);
});

// ── upgradedDefault, with the owner's element ───────────────────────────────
const editor = load('src/features/style/embed/editorModel.ts');
const tokens = [{ name: 'tag:h2', label: 'h2', kind: 'tag' }, ...CLASSES.map((name) => ({ name: `class:${name}`, label: name, kind: 'class' }))];
const entry = (text) => ({ text, specificity: [0, 0, 0], state: '', simple: true, key: text, inContext: true });
const upgraded = (texts, defaultTokens = ['class:heading']) => editor.upgradedDefault(texts.map(entry), { tokens, classList: CLASSES, defaultTokens })?.text;

test('upgradedDefault: the heading starts on :where(.heading), not a utility', () => {
  assert.equal(upgraded(['.u-text-center', '.u-text-balance', ':where(.heading)', ':where(.heading--2)', 'h2']), ':where(.heading)');
});

test('upgradedDefault: a utility default is replaced, a styled regular default is kept', () => {
  assert.equal(upgraded(['.u-text-center', ':where(.heading)'], ['class:u-text-center']), ':where(.heading)');
  assert.equal(upgraded(['.heading', ':where(.heading)']), undefined);
});
