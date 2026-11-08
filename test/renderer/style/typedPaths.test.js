// Goal: a selector typed with nesting (`.faq_summary{&::before}`) is written as
// nested CSS inside the existing `.faq_summary` rule, even when the panel
// re-picks the selector before its first edit (it does so on its own as the
// canvas reports matches; a single slot cleared on every pick lost the path).
// Method: the keyed paths directly (remember, re-pick, take once, per context,
// bounded), then the nested write into a parsed region.
const assert = require('node:assert/strict');
const postcss = require('postcss');
const load = require('../../helpers/rendererModule');
const { pseudoLayerChips, pseudoPickFor, pseudoSelectorInput, rememberTypedPath, takeTypedPath } = load('src/features/style/embed/editorModel.ts');
const { parseNestedInput, createNestedRule } = load('src/features/style/model/css.ts');

const parsed = parseNestedInput('.faq_summary{&::before}');
assert.equal(parsed.selector, '.faq_summary::before');
assert.deepEqual(
  parsed.path.map((step) => step.selector),
  ['.faq_summary', '&::before'],
);

const paths = new Map();
rememberTypedPath(paths, parsed.selector, '', parsed.path);
// Picking other selectors, or this one again, leaves the path for its first edit.
rememberTypedPath(paths, '.faq_item:hover', '', parseNestedInput('.faq_item{&:hover}').path);
assert.equal(takeTypedPath(paths, parsed.selector, '@media (width < 40rem)'), undefined, 'another context has no path');
assert.deepEqual(takeTypedPath(paths, ' .faq_summary::before ', ''), parsed.path);
assert.equal(takeTypedPath(paths, parsed.selector, ''), undefined, 'taken once: its rule now exists');
assert.throws(() => rememberTypedPath(paths, '.x', '', [{ kind: 'selector', selector: '.x' }]), /A typed path nests at least one level/);
for (let index = 0; index < 40; index++) {
  rememberTypedPath(paths, `.c${index}::after`, '', parseNestedInput(`.c${index}{&::after}`).path);
}
assert.equal(paths.size, 32, 'bounded: the oldest go');
assert.equal(takeTypedPath(paths, '.c0::after', ''), undefined);
assert.ok(takeTypedPath(paths, '.c39::after', '') !== undefined);

// The write lands inside the existing rule, not as a flat rule beside it.
const css = '\n    .faq_summary {\n      cursor: pointer;\n    }\n    ';
const region = { start: 0, end: css.length, css, root: postcss.parse(css) };
assert.ok(createNestedRule(region, parsed.path, 'content', { value: '"+"', important: false }));
const written = region.root.toString();
assert.match(written, /\.faq_summary \{[^}]*cursor: pointer;[\s\S]*&::before \{[\s\S]*content: "\+"/);
assert.doesNotMatch(written, /\.faq_summary::before/);
// In an indented <style> block, a nested rule and its declarations line up one
// level inside their parent, closing brace under the selector, and a new
// top-level rule lines up with the rules beside it.
{
  const { createRuleAtRoot } = load('src/features/style/model/css.ts');
  const block = '\n    /* faq */\n    .faq_layout {\n      display: grid;\n    }\n    .faq_summary {\n      display: flex;\n    }\n    ';
  const indented = { start: 0, end: block.length, css: block, root: postcss.parse(block) };
  const after = parseNestedInput('.faq_summary{&::after}');
  assert.ok(createNestedRule(indented, after.path, 'content', { value: '"+"', important: false }));
  assert.ok(createNestedRule(indented, after.path, 'width', { value: '1.5rem', important: false }));
  assert.ok(createRuleAtRoot(indented, '.faq_detail', 'border-radius', { value: '100vw', important: false }));
  assert.equal(
    indented.root.toString(),
    [
      '',
      '    /* faq */',
      '    .faq_layout {',
      '      display: grid;',
      '    }',
      '    .faq_summary {',
      '      display: flex;',
      '      &::after {',
      '        content: "+";',
      '        width: 1.5rem;',
      '      }',
      '    }',
      '    .faq_detail {',
      '      border-radius: 100vw;',
      '    }',
      '    ',
    ].join('\n'),
  );
}
// A navigator ::before / ::after row picks the pseudo-element nested in the
// element's first class, or its tag with no class; nothing for neither.
const element = (props, name = 'summary') => ({ id: 'n1', kind: 'element', name, props });
assert.equal(pseudoSelectorInput(element({ class: { type: 'string', value: 'faq_summary is-open' } }), 'after'), '.faq_summary{&::after}');
assert.equal(pseudoSelectorInput(element({}), 'before'), 'summary{&::before}');
assert.equal(pseudoSelectorInput(element({ class: { type: 'expr', value: 'cls' } }, 'p'), 'before'), 'p{&::before}', 'an expression class is not a name');
assert.equal(pseudoSelectorInput({ id: 'c', kind: 'component', name: 'Card' }, 'after'), undefined);
assert.equal(pseudoSelectorInput(undefined, 'after'), undefined);
assert.equal(parseNestedInput(pseudoSelectorInput(element({}), 'before')).selector, 'summary::before');
// The rule that already styles the pseudo-element wins: `section.stat_wrap.divider`
// whose ::before is styled by `.divider::before` picks that, not `.stat_wrap::before`.
// The cascade files pseudo-element rules with the conditional ones (cascade.ts
// classifyHit), so the fixture does too: the pick once searched `base` alone,
// found nothing, and typed `.stat_wrap{&::before}` beside the real rule.
{
  const section = { id: 's1', kind: 'element', name: 'section', props: { class: { type: 'string', value: 'stat_wrap divider' } } };
  const snapshot = { tag: 'section', webflowType: '', id: undefined, classes: ['stat_wrap', 'divider'], classList: ['stat_wrap', 'divider'] };
  const matched = (text, pseudoElement, order, atContext = []) => ({
    rule: { order, atContext },
    matchedSelectors: [{ text, pseudoElement, specificity: [0, 1, pseudoElement ? 1 : 0] }],
  });
  const model = {
    base: [matched('.stat_wrap', undefined, 0)],
    conditional: [matched('.divider::before', '::before', 1), matched('.divider::after', ':after', 2)],
    matchedRuleCount: 3,
  };
  assert.deepEqual(pseudoPickFor(section, 'before', { snapshot, model }), { kind: 'existing', selector: '.divider::before' });
  assert.deepEqual(pseudoPickFor(section, 'after', { snapshot, model }), { kind: 'existing', selector: '.divider::after' }, 'a legacy :after counts');
  // Specificity decides, then source order.
  const stronger = { ...model, conditional: [matched('section.divider::before', '::before', 0), ...model.conditional] };
  stronger.conditional[0].matchedSelectors[0].specificity = [0, 1, 2];
  assert.deepEqual(pseudoPickFor(section, 'before', { snapshot, model: stronger }), { kind: 'existing', selector: 'section.divider::before' });
  const later = { ...model, conditional: [...model.conditional, matched('.stat_wrap::before', '::before', 5)] };
  assert.deepEqual(pseudoPickFor(section, 'before', { snapshot, model: later }), { kind: 'existing', selector: '.stat_wrap::before' });
  // A rule only inside a query styles the pseudo-element there alone: not picked.
  const queried = { ...model, conditional: [matched('.divider::before', '::before', 1, ['@media (max-width: 40em)'])] };
  assert.deepEqual(pseudoPickFor(section, 'before', { snapshot, model: queried }), { kind: 'typed', input: '.stat_wrap{&::before}' });
  const unstyled = { ...model, conditional: [] };
  assert.deepEqual(pseudoPickFor(section, 'before', { snapshot, model: unstyled }), { kind: 'typed', input: '.stat_wrap{&::before}' });
  // A scan of another element (or none yet) says nothing about this one: wait.
  assert.deepEqual(pseudoPickFor(section, 'before', { snapshot: { ...snapshot, tag: 'summary' }, model }), { kind: 'wait' });
  assert.deepEqual(pseudoPickFor(section, 'before', { snapshot: { ...snapshot, classList: ['faq_summary'], classes: [] }, model }), { kind: 'wait' });
  assert.deepEqual(pseudoPickFor(section, 'before', { snapshot: undefined, model }), { kind: 'wait' });
}
// A ::before layer lists only the selectors that style its ::before: the
// element's own `.stat_wrap` and the ::after rule are left out. The element's list
// leaves those out in turn; only a host with no such rows lists every chip.
{
  const chip = (text) => ({ text, specificity: [0, 1, 0], state: '', simple: false, key: text, inContext: true, fromComponent: false });
  const list = [chip('.stat_wrap'), chip('.divider::before'), chip('.divider::after'), chip(':open > .stat_wrap::before')];
  const shown = (pseudo) => pseudoLayerChips(list, pseudo).map((entry) => entry.text);
  assert.deepEqual(shown('::before').sort(), [':open > .stat_wrap::before', '.divider::before'].sort());
  assert.deepEqual(shown('::after'), ['.divider::after']);
  assert.deepEqual(shown(''), ['.stat_wrap'], 'the element lists its own');
  assert.equal(shown('every').length, list.length, 'a host with no pseudo-element rows lists every chip');
}
console.log('typed paths: ok');
