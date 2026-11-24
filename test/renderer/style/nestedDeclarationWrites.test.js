// Goal: setting a property on a rule writes the rule's own declaration and no
// other. A rule that wraps nested CSS (`.card { .title { color: blue } }`) was
// searched whole, so adding the selector with `color` rewrote `.title`'s colour
// and left `.card` without one.
// Method: the two writers that merge into an existing rule (createRuleAtRoot and
// createRuleInQuery) run on parsed regions, and the whole stylesheet is compared.
// The negative space is a rule with its own declaration beside a nested one: only
// its own changes, and no second declaration appears.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadModule = require('../../helpers/rendererModule');

const { createRuleAtRoot, createRuleInQuery } = loadModule('src/features/style/model/css.ts');
const { parseRegion, regionText } = loadModule('src/features/style/model/cssRegions.ts');

const parsed = (css) => parseRegion({ start: 0, end: css.length, css, root: undefined });
const green = { value: 'green', important: false };

test('a nested rule keeps its value when the parent gets the property', () => {
  const region = parsed('.card {\n  margin: 0;\n  .title {\n    color: blue;\n  }\n}\n');
  assert.equal(createRuleAtRoot(region, '.card', 'color', green), true);
  assert.equal(regionText(region), '.card {\n  margin: 0;\n  color: green;\n  .title {\n    color: blue;\n  }\n}\n');
});

test('the same holds for a rule inside a query, with a nested query', () => {
  const css = '@media (width < 50rem) {\n  .card {\n    @media print {\n      color: blue;\n    }\n  }\n}\n';
  const region = parsed(css);
  assert.equal(createRuleInQuery(region, '@media (width < 50rem)', '.card', 'color', green), true);
  assert.equal(regionText(region), '@media (width < 50rem) {\n  .card {\n    color: green;\n    @media print {\n      color: blue;\n    }\n  }\n}\n');
});

test('a rule with its own declaration changes only that one', () => {
  const region = parsed('.card {\n  color: red;\n  &:hover {\n    color: blue;\n  }\n}\n');
  createRuleAtRoot(region, '.card', 'color', green);
  assert.equal(regionText(region), '.card {\n  color: green;\n  &:hover {\n    color: blue;\n  }\n}\n');
});
