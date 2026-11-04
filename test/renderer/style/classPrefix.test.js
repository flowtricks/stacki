// Goal: → in the empty selector box starts a class in the parent's naming
// scheme: `.stat_card_` from a parent's `stat_card_title`. Method: the prefix
// of a class list, then the parent search over a small tree: the nearest
// ancestor element that writes a class, past classless wrappers and loops,
// and the negative space (no underscore, no parent, no selection).
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { classPrefix, parentClassPrefix } = load('src/features/style/model/classPrefix.ts');

assert.equal(classPrefix(['stat_card_title']), '.stat_card_');
assert.equal(classPrefix(['container', 'stat_card', 'faq_item_text']), '.stat_');
assert.equal(classPrefix(['container', 'is-open']), undefined, 'no underscore, no prefix');
assert.equal(classPrefix([]), undefined);

const element = (id, classes, children = []) => ({
  id,
  kind: 'element',
  name: 'div',
  props: classes === undefined ? {} : { class: { type: 'string', value: classes } },
  children,
});
const tree = [
  element('card', 'container stat_card_title', [
    element('wrapper', undefined, [{ id: 'loop', kind: 'map', children: [element('item', 'stat_card_label')] }]),
    element('plain', 'is-open', [element('inner', 'x')]),
  ]),
];
assert.equal(parentClassPrefix(tree, 'item'), '.stat_card_', 'past a classless wrapper and a loop');
assert.equal(parentClassPrefix(tree, 'wrapper'), '.stat_card_');
assert.equal(parentClassPrefix(tree, 'inner'), undefined, 'the nearest classed parent has no underscore');
assert.equal(parentClassPrefix(tree, 'card'), undefined, 'the root has no parent');
assert.equal(parentClassPrefix(tree, undefined), undefined);
console.log('class prefix: ok');
