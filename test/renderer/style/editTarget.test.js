// Goal: an edit lands in the rule whose value the panel shows, so the panel and
// the canvas both change. The panel showed the cascade winner among the picked
// selector's rules but wrote into the FIRST of them in document order. With a
// Webflow export's `.wrap, .arrow { … }` above `.wrap { display: inline-block }`,
// picking Flex split the grouped rule and wrote `display: flex` into the copy,
// the later rule still won, and the Display control kept showing In-block.
// Method: real stylesheets through the panel's own parser (parseRegion,
// collectRules), cascade (computeRuleModel) and resolver (resolveStyle). The
// canvas's answer for which selectors match is given as `domMatched`, as the
// live preview gives it. Each case names, per property, the rule an edit goes
// to (editableRuleFor) and the rules a clear empties (selectedRulesSetting).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'edit-target.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { parseRegion } from './src/features/style/model/cssRegions';",
      "export { collectRules } from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      'export { editableRuleFor, resolveStyle, selectedRulesSetting }',
      "  from './src/features/style/model/resolved';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const model = require(bundle);

// The picked selector's resolved style over `css`, for an element that matches
// exactly the selectors in `matching`.
async function resolve(css, activeSelector, matching, options) {
  const region = model.parseRegion({ start: 0, end: css.length, css, root: undefined });
  const rules = model.collectRules(region, {
    embedKey: 'file:/site.css',
    embedLabel: 'site.css',
    fromComponent: false,
    componentName: undefined,
    regionIndex: 0,
    idSeed: 'site',
    order: { n: 0 },
  });
  const selectors = rules.flatMap((rule) => rule.selectors.map((selector) => selector.text));
  const domMatched = new Map(selectors.map((text) => [text, matching.includes(text)]));
  const target = { rootKey: 'root', view: undefined, domMatched };
  const ruleModel = await model.computeRuleModel(rules, target);
  return model.resolveStyle(ruleModel, '', activeSelector, options);
}

// Which rule of the stylesheet, by its position in the file (0-based).
const position = (resolved, rule) => (rule === undefined ? undefined : [...resolved.selectedRules.values()].indexOf(rule));

test('a grouped rule above the selector’s own rule: the own rule takes the edit', async () => {
  const css = ['.wrap, .arrow { display: block; color: red; }', '.wrap { display: inline-block; }'].join('\n');
  const resolved = await resolve(css, '.wrap', ['.wrap']);
  const shown = resolved.props.get('display');
  assert.equal(shown.selectedValue.value, 'inline-block', 'the panel shows the winner');
  assert.equal(position(resolved, model.editableRuleFor(resolved, 'display')), 1);
  // Set only in the grouped rule: edited there, where it lives (the edit splits it).
  assert.equal(position(resolved, model.editableRuleFor(resolved, 'color')), 0);
  // Set nowhere: the last rule, so the new value wins a tie with the ones above.
  assert.equal(position(resolved, model.editableRuleFor(resolved, 'padding')), 1);
  assert.equal(resolved.selectedRule, model.editableRuleFor(resolved, 'padding'));
});

test('the same selector twice: edits go to the later rule, a clear empties both', async () => {
  const css = '.card { color: red; margin: 0; }\n.card { color: blue; }';
  const resolved = await resolve(css, '.card', ['.card']);
  assert.equal(resolved.props.get('color').selectedValue.value, 'blue');
  assert.equal(position(resolved, model.editableRuleFor(resolved, 'color')), 1);
  assert.equal(position(resolved, model.editableRuleFor(resolved, 'margin')), 0);
  const cleared = model.selectedRulesSetting(resolved, 'color').map((rule) => {
    return position(resolved, rule);
  });
  assert.deepEqual(cleared.sort(), [0, 1], 'clearing leaves no earlier value to surface');
  assert.deepEqual(
    model.selectedRulesSetting(resolved, 'margin').map((rule) => position(resolved, rule)),
    [0],
  );
});

test('an !important value in the earlier rule is the one shown, and edited', async () => {
  const css = '.card { color: red !important; }\n.card { color: blue; }';
  const resolved = await resolve(css, '.card', ['.card']);
  assert.equal(resolved.props.get('color').selectedValue.value, 'red');
  assert.equal(position(resolved, model.editableRuleFor(resolved, 'color')), 0);
});

test('another selector’s value is not the picked one’s rule', async () => {
  const css = '.other { color: red; }\n.card { margin: 0; }';
  const resolved = await resolve(css, '.card', ['.card', '.other']);
  assert.equal(resolved.props.get('color').source, 'other');
  // The picked selector's own rule takes the value; .other is never written.
  assert.equal(model.editableRuleFor(resolved, 'color'), resolved.selectedRule);
  assert.equal(resolved.selectedRule.selectorText, '.card');
  assert.deepEqual(model.selectedRulesSetting(resolved, 'color'), []);
});

test('no rule for the picked selector: the edit creates one', async () => {
  const resolved = await resolve('.other { color: red; }', '.card', ['.card', '.other']);
  assert.equal(resolved.selectedRule, undefined);
  assert.equal(model.editableRuleFor(resolved, 'color'), undefined);
  assert.equal(resolved.selectedRules.size, 0);
});

test('a navigator ::after layer shows the ::after styles while no ::after chip is picked', async () => {
  // Deselecting the chip falls back to the element's own selector; on the
  // ::after layer the panel still shows that box, not the element.
  const css = ['.faq_summary { color: red; }', '.faq_summary::after { border-style: solid; }', '.faq_summary:hover::after { rotate: 45deg; }'].join('\n');
  const matching = ['.faq_summary', '.faq_summary::after', '.faq_summary:hover::after'];
  const layer = { source: 'embed', contribs: [], selectedIndex: undefined, pseudoLayer: '::after' };
  const onLayer = await resolve(css, '.faq_summary', matching, layer);
  assert.ok(onLayer.props.has('border-style'), 'the ::after rule shows');
  assert.ok(!onLayer.props.has('color'), 'the element rule does not');
  const element = await resolve(css, '.faq_summary', matching);
  assert.ok(element.props.has('color'), 'without the layer, the element shows');
  assert.ok(!element.props.has('border-style'));
  const picked = await resolve(css, '.faq_summary::after', matching, { ...layer, pseudoLayer: '::before' });
  assert.ok(picked.props.has('border-style'), 'a picked pseudo-element selector names its own target');
});
