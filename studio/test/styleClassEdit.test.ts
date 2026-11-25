// Goal: adding and removing a class preserve authored expressions and surrounding source.
// Method: real source edits across static and computed attributes (class:list included),
// plus invalid names and computed classes Stacki refuses to rewrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addStyleClass, removeStyleClass } from '../src/features/settings/styleClassEdit';
import { flatten, nodesOf, nodeId } from '../src/features/source/source';

for (const [before, after] of [
  ['class="one"', 'class="one two"'],
  ['class:list={["one", dynamic]}', 'class:list={["one", dynamic, "two"]}'],
  ['class:list={classes}', 'class:list={[classes, "two"]}'],
  ['class={`one ${dynamic}`}', 'class={`one ${dynamic} two`}'],
  ['class={cx(a, b)}', 'class:list={[(cx(a, b)), "two"]}'],
] as const) {
  test(`adding a selector preserves surrounding source with ${before}`, () => {
    const source = `---\nconst dynamic = 'other';\n---\n<!-- preserve -->\n<p id="target" ${before}>Text</p>\n<style>p { color: red; }</style>\n`;
    const node = flatten(nodesOf(source)).find((node) => node.name === 'p');
    assert.ok(node);
    const result = addStyleClass(source, nodeId(node), 'two');
    assert.equal(result, source.replace(before, after));
    assert.equal(addStyleClass(result, nodeId(node), 'two'), result);
  });
}
test('invalid names fail without rewriting source', () => {
  const source = '<p class={cx(a, b)}>Text</p>';
  const node = flatten(nodesOf(source)).find((node) => node.name === 'p');
  assert.ok(node);
  for (const name of ['', 'two classes', '"injected"', '`expression`']) {
    assert.throws(() => addStyleClass(source, nodeId(node), name), /single class name/);
  }
});

for (const [before, after] of [
  ['class="one two"', 'class="one"'],
  ["class:list={['one', 'two']}", "class:list={['one']}"],
  ["class:list={['one', { two: on }]}", "class:list={['one']}"],
  ["class:list={['one', on && 'two']}", "class:list={['one']}"],
  ['class:list={[`one two ${size}`]}', 'class:list={[`one ${size}`]}'],
  ["class=\"two\" class:list={['one', 'two']}", "class:list={['one']}"],
] as const) {
  test(`removing a class edits only its text with ${before}`, () => {
    const source = `---\nconst on = true;\n---\n<!-- preserve -->\n<p id="target" ${before}>Text</p>\n<style>p { color: red; }</style>\n`;
    const node = flatten(nodesOf(source)).find((node) => node.name === 'p');
    assert.ok(node);
    const result = removeStyleClass(source, nodeId(node), 'two');
    assert.equal(result.tag, 'applied', JSON.stringify(result));
    assert.ok(result.tag === 'applied');
    // Studio's attribute removal leaves the space that stood before the attribute; the rest is byte for byte.
    assert.equal(result.source.replace(/ {2,}/g, ' '), source.replace(before, after));
    const again = removeStyleClass(result.source, nodeId(node), 'two');
    assert.equal(again.tag, 'refused', 'a second removal finds nothing to remove');
  });
}

test('a class from a computed entry is refused with the code it comes from', () => {
  const source = '<p class:list={["one", className]}>Text</p>';
  const node = flatten(nodesOf(source)).find((node) => node.name === 'p');
  assert.ok(node);
  const result = removeStyleClass(source, nodeId(node), 'two');
  assert.equal(result.tag, 'refused');
  assert.ok(result.tag === 'refused');
  assert.match(result.message, /className/);
});
