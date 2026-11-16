// Goal: a selector with no rules defaults to the open file's own <style> tag, or to the virtual
// "Create <style>" entry when the file has none (src/features/style/model/newStyleTarget.ts), and a
// rule written into a tag that follows the project's template lands inside its wrapper
// (css.ts createRuleAtRoot) while a tag that does not is written as ever.
// Method: a table over tags (none, one, several, define:vars, scoped before global), the preferred
// scope and whether the file can hold a tag; then real postcss regions written through
// createRuleAtRoot with and without a layer wrapper, comparing the exact bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const target = require('../../helpers/rendererModule')('src/features/style/model/newStyleTarget.ts');
const css = require('../../helpers/rendererModule')('src/features/style/model/css.ts');

const tag = (key, order, scope = 'scoped', variables = 'none') => ({ key, order, scope, variables });
const pick = (tags, preferredScope = 'global', fileCanHoldTag = 'yes') => target.defaultStyleTarget({ tags, preferredScope, fileCanHoldTag });

test('no tag: the virtual create entry, unless the file cannot hold a tag', () => {
  assert.deepEqual(pick([]), { kind: 'create' });
  assert.equal(target.defaultTargetKey(pick([])), target.CREATE_STYLE_TAG_KEY);
  assert.deepEqual(pick([], 'global', 'no'), { kind: 'none' });
  assert.equal(target.defaultTargetKey(pick([], 'global', 'no')), undefined);
});

test('with tags: the first usable, preferring the configured scope', () => {
  assert.deepEqual(pick([tag('a', 0)], 'scoped'), { kind: 'tag', key: 'a' });
  assert.deepEqual(pick([tag('a', 0, 'scoped'), tag('b', 1, 'global')], 'global'), { kind: 'tag', key: 'b' });
  assert.deepEqual(pick([tag('a', 0, 'scoped'), tag('b', 1, 'global')], 'scoped'), { kind: 'tag', key: 'a' });
  assert.deepEqual(pick([tag('a', 0, 'scoped'), tag('b', 1, 'scoped')], 'global'), { kind: 'tag', key: 'a' }, 'none matches: the first');
  assert.deepEqual(pick([tag('b', 1), tag('a', 0)], 'scoped'), { kind: 'tag', key: 'a' }, 'order, not list position');
});

test('define:vars tags are skipped unless they are all there is', () => {
  assert.deepEqual(pick([tag('v', 0, 'global', 'defined'), tag('a', 1, 'scoped')], 'global'), { kind: 'tag', key: 'a' });
  assert.deepEqual(pick([tag('v', 0, 'global', 'defined'), tag('w', 1, 'global', 'defined')], 'global'), { kind: 'tag', key: 'v' });
});

const region = (code) => css.parseRegion({ start: 0, end: code.length, css: code, root: undefined });
const declared = { value: 'red', important: false };
const layer = [{ name: 'layer', params: 'components' }];

test('a layer wrapper takes the rule inside it, after the rules there; an empty layer works', () => {
  const empty = region('@layer components {}');
  assert.ok(css.createRuleAtRoot(empty, '.a', 'color', declared, layer));
  assert.ok(css.createRuleAtRoot(empty, '.b', 'color', declared, layer));
  const text = empty.root.toString();
  assert.match(text, /^@layer components \{[\s\S]*\.a \{[\s\S]*color: red[\s\S]*\.b \{[\s\S]*\}\s*\}$/);
  assert.ok(text.indexOf('.a') < text.indexOf('.b'));
  assert.equal(empty.root.nodes.length, 1, 'nothing was added beside the layer');
});

test('a tag without the wrapper is written as ever, and a layer-less chain writes at the root', () => {
  const own = region('.mine { color: blue; }');
  assert.ok(css.createRuleAtRoot(own, '.a', 'color', declared, layer));
  assert.equal(own.root.nodes.length, 2);
  assert.equal(own.root.nodes[0].toString(), '.mine { color: blue; }', 'their rule is untouched');
  const plain = region('');
  assert.ok(css.createRuleAtRoot(plain, '.a', 'color', declared));
  assert.equal(plain.root.nodes[0].selector, '.a');
});
