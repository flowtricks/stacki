// Goal: the CSS the Style panel writes into a `<style>` tag reads like hand-written CSS, byte for
// byte: no blank line inside a new rule, none between a rule and its wrapper's closing brace, every
// new block on lines of its own, and the file's own line endings. The bug this pins: with the
// template `@layer components {\n\n}` (a blank line to type into), "Create <style>" then
// `padding: 1.25rem` for `.my-class` left a blank line after the declaration and another before the
// layer's closing brace, because the wrapper kept its blank inside and PostCSS copied it into the
// new rule. Also pinned: a first breakpoint style ran onto the end of a one-line rule
// (`.grid { … }@media (width < 48rem) {.grid { … } }`).
//
// Method: real postcss regions written through css.ts exactly as the panel writes them
// (src/features/style/model/webflow.ts blankStyleDocument for a new tag: the template's skeleton,
// then createRuleAtRoot inside its wrappers). A table of templates × property sequences compares the
// exact text; each case is also written twice to show a repeated write changes nothing. The user's
// scenario is carried through styleBlockInner (firstStyleBlock.ts), the text that lands between the
// tags. Then the negative space: a tag that already holds rules keeps its layout, removing the last
// property leaves no blank line, and a CRLF region keeps CRLF.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const css = load('src/features/style/model/css.ts');
const { templateFrame } = load('shared/properties/newStyleTag.ts');
const { styleBlockInner } = load('src/features/style/model/firstStyleBlock.ts');

const declared = (value) => ({ value, important: false });
const region = (text) => css.parseRegion({ start: 0, end: text.length, css: text, root: undefined });

// A new tag's document: the template's skeleton, written into as the panel writes a first rule.
function newTag(template, writes) {
  const frame = templateFrame(template);
  assert.equal(frame.ok, true, `the template ${JSON.stringify(template)} parses`);
  const tag = region(frame.frame.skeleton);
  for (const [selector, prop, value] of writes) {
    assert.equal(css.createRuleAtRoot(tag, selector, prop, declared(value), frame.frame.wrappers), true);
  }
  return { tag, wrappers: frame.frame.wrappers };
}

const ONE = [['.my-class', 'padding', '1.25rem']];
const QUICK = [
  ['.my-class', 'padding', '1.25rem'],
  ['.my-class', 'color', 'red'],
  ['.my-class', 'gap', '1rem'],
];
const TWO_CLASSES = [
  ['.my-class', 'padding', '1.25rem'],
  ['.other', 'color', 'blue'],
];

const LAYER_ONE = '@layer components {\n\t.my-class {\n\t\tpadding: 1.25rem;\n\t}\n}';
const LAYER_QUICK = '@layer components {\n\t.my-class {\n\t\tpadding: 1.25rem;\n\t\tcolor: red;\n\t\tgap: 1rem;\n\t}\n}';
const LAYER_TWO = '@layer components {\n\t.my-class {\n\t\tpadding: 1.25rem;\n\t}\n\t.other {\n\t\tcolor: blue;\n\t}\n}';
const ROOT_ONE = '\n.my-class {\n\tpadding: 1.25rem;\n}';
const ROOT_TWO = '\n.my-class {\n\tpadding: 1.25rem;\n}\n.other {\n\tcolor: blue;\n}';

const CASES = [
  { template: '@layer components {\n\n}', writes: ONE, expected: LAYER_ONE },
  { template: '@layer components {\n\n}', writes: QUICK, expected: LAYER_QUICK },
  { template: '@layer components {\n\n}', writes: TWO_CLASSES, expected: LAYER_TWO },
  { template: '@layer components {\n  \n\n}', writes: ONE, expected: LAYER_ONE },
  { template: '@layer components {\n}', writes: ONE, expected: LAYER_ONE },
  { template: '@layer components {\n}', writes: TWO_CLASSES, expected: LAYER_TWO },
  { template: '@layer components { }', writes: ONE, expected: LAYER_ONE },
  { template: '@layer components {}', writes: QUICK, expected: LAYER_QUICK },
  { template: '@layer components {\n  /* stacki:rules */\n}', writes: ONE, expected: LAYER_ONE },
  { template: '@layer components {\n  /* stacki:rules */\n}', writes: TWO_CLASSES, expected: LAYER_TWO },
  { template: '', writes: ONE, expected: ROOT_ONE },
  { template: '', writes: TWO_CLASSES, expected: ROOT_TWO },
  { template: '/* stacki:rules */', writes: TWO_CLASSES, expected: ROOT_TWO },
  { template: '@media screen {\n\n}', writes: ONE, expected: '@media screen {\n\t.my-class {\n\t\tpadding: 1.25rem;\n\t}\n}' },
  {
    template: '@layer components {\n\n}',
    writes: [['.my-class:hover', 'color', 'red']],
    expected: '@layer components {\n\t.my-class:hover {\n\t\tcolor: red;\n\t}\n}',
  },
];

for (const { template, writes, expected } of CASES) {
  test(`template ${JSON.stringify(template)}, ${writes.length} write(s): exact text, and a repeat changes nothing`, () => {
    const { tag, wrappers } = newTag(template, writes);
    const text = tag.root.toString();
    assert.equal(text, expected);
    assert.doesNotMatch(text, /\n[ \t]*\n/, 'no blank line anywhere in a new tag');
    assert.doesNotMatch(text, /[ \t]\n/, 'no trailing whitespace');
    for (const [selector, prop, value] of writes) {
      css.createRuleAtRoot(tag, selector, prop, declared(value), wrappers);
    }
    assert.equal(tag.root.toString(), expected, 'writing the same values again is idempotent');
  });
}

test("the user's scenario: Create <style> with `@layer components {\\n\\n}`, then padding 1.25rem", () => {
  const { tag } = newTag('@layer components {\n\n}', ONE);
  const twoSpaces = { unit: '  ', eol: '\n' };
  const inner = styleBlockInner(tag.root.toString(), twoSpaces);
  const lines = inner.split('\n').slice(1, -1);
  assert.equal(lines.length, 5, 'five lines between the tags');
  const dedented = lines.map((line) => line.slice(twoSpaces.unit.length)).join('\n');
  assert.equal(dedented, '@layer components {\n  .my-class {\n    padding: 1.25rem;\n  }\n}');
  const crlf = styleBlockInner(tag.root.toString(), { unit: '  ', eol: '\r\n' });
  assert.equal(crlf, '\r\n  @layer components {\r\n    .my-class {\r\n      padding: 1.25rem;\r\n    }\r\n  }\r\n', 'a CRLF file gets CRLF');
});

test('a first breakpoint style starts and closes its own lines', () => {
  const table = [
    {
      source: '.grid { color: red; }',
      expected: '.grid { color: red; }\n@media (width < 48rem) {\n\t.grid {\n\t\tgap: 1rem;\n\t}\n}',
    },
    {
      source: '\n  .grid {\n    color: red;\n  }\n',
      expected: '\n  .grid {\n    color: red;\n  }\n  @media (width < 48rem) {\n    .grid {\n      gap: 1rem;\n    }\n  }\n',
    },
    {
      source: '@layer components {\n\t.grid {\n\t\tcolor: red;\n\t}\n}',
      expected: '@layer components {\n\t.grid {\n\t\tcolor: red;\n\t}\n}\n@media (width < 48rem) {\n\t.grid {\n\t\tgap: 1rem;\n\t}\n}',
    },
    { source: '', expected: '\n@media (width < 48rem) {\n\t.grid {\n\t\tgap: 1rem;\n\t}\n}' },
  ];
  for (const { source, expected } of table) {
    const sheet = region(source);
    assert.equal(css.createRuleInMedia(sheet, '(width < 48rem)', '.grid', 'gap', declared('1rem')), true);
    assert.equal(sheet.root.toString(), expected, JSON.stringify(source));
    assert.ok(sheet.root.toString().startsWith(source.trimEnd()), 'what was there is untouched');
  }
});

test('a nested & rule is laid out one step inside its parent', () => {
  const sheet = region('\n.a {\n\tcolor: red;\n}');
  const parsed = css.parseNestedInput('.a { &:hover { } }');
  assert.notEqual(parsed, undefined);
  assert.equal(css.createNestedRule(sheet, parsed.path, 'color', declared('blue')), true);
  assert.equal(sheet.root.toString(), '\n.a {\n\tcolor: red;\n\t&:hover {\n\t\tcolor: blue;\n\t}\n}');
});

test('a tag that already holds rules keeps its own layout; only the new rule is laid out', () => {
  const source = '\n@layer components {\n\n  .mine { color: blue; }\n\n}\n';
  const sheet = region(source);
  assert.equal(css.createRuleAtRoot(sheet, '.my-class', 'padding', declared('1.25rem'), [{ name: 'layer', params: 'components' }]), true);
  const text = sheet.root.toString();
  assert.ok(text.startsWith('\n@layer components {\n\n  .mine { color: blue; }'), 'their rule and spacing are untouched');
  assert.match(text, /\n {2}\.my-class \{\n {4}padding: 1\.25rem;\n {2}\}/);
});

test('removing the last property removes the rule and leaves no blank line', () => {
  const { tag } = newTag('@layer components {\n\n}', TWO_CLASSES);
  const rules = [];
  tag.root.walkRules((rule) => {
    rules.push(rule);
  });
  assert.equal(rules.length, 2);
  for (const rule of rules) {
    rule.nodes[0].remove();
    assert.equal(css.removeRuleIfEmpty({ node: rule }), true);
  }
  assert.equal(tag.root.toString(), '@layer components {\n}');
});

test('a CRLF region is written back in CRLF; an LF or mixed one as it was', () => {
  const crlf = region('\r\n  .grid {\r\n    color: red;\r\n  }\r\n');
  css.createRuleInMedia(crlf, '(width < 48rem)', '.grid', 'gap', declared('1rem'));
  assert.equal(
    css.regionText(crlf),
    '\r\n  .grid {\r\n    color: red;\r\n  }\r\n  @media (width < 48rem) {\r\n    .grid {\r\n      gap: 1rem;\r\n    }\r\n  }\r\n',
  );
  const lf = region('\n.grid {\n\tcolor: red;\n}\n');
  assert.equal(css.regionText(lf), '\n.grid {\n\tcolor: red;\n}\n');
  const mixed = region('\r\n.a {\n\tcolor: red;\r\n}\r\n');
  assert.equal(css.regionText(mixed), '\r\n.a {\n\tcolor: red;\r\n}\r\n', 'a mixed region is not normalised');
  const unparsed = { start: 0, end: 3, css: 'x {', root: undefined };
  assert.equal(css.regionText(unparsed), 'x {', 'an unparsed region is its own text');
});
