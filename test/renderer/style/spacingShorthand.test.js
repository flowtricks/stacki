// Goal: a box shorthand shows in the spacing box, and a padding edit leaves the
// rule compact. The box has one field per side, so `padding: 1rem 2rem` filled
// none of them while applying on the page, and dragging one side of it left a
// longhand beside the shorthand it overrode: four drags, five declarations.
// Method: two halves, both on the panel's own modules, bundled as the panel
// loads them. Reading goes through the real parser (parseRegion, collectRules),
// cascade (computeRuleModel) and resolver (resolveStyle), and names what each
// side resolves to, where its edit goes (editableRuleFor) and what a clear
// empties (selectedRulesSetting); the stylesheet is compared before and after,
// as reading must not rewrite it. Writing drives setPaddingDeclaration and
// clearPaddingSides on postcss rules and lists the padding declarations left,
// through the paths that set a property on an existing rule and the two that
// create one (createRuleAtRoot, createRuleInQuery). The negative space is
// covered on both halves: values with too many parts, properties the box does
// not read, a var() that may hold several lengths, and a non-padding property
// handed to the padding writer, whose assertion message is pinned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const postcss = require('postcss');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'spacing-shorthand.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { parseRegion } from './src/features/style/model/cssRegions';",
      'export { collectRules, createRuleAtRoot, createRuleInQuery }',
      "  from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      'export { editableRuleFor, resolveStyle, selectedRulesSetting }',
      "  from './src/features/style/model/resolved';",
      'export { clearPaddingSides, isPaddingProperty, setPaddingDeclaration, spacingSides }',
      "  from './src/features/style/model/spacingShorthand';",
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

const SIDES = ['top', 'right', 'bottom', 'left'];
const MEDIA = '@media (max-width: 600px)';

// The picked selector's resolved style over `css`, in `context`, for an element
// every selector of the sheet matches. Fails if reading changed the stylesheet.
async function resolve(css, activeSelector = '.card', context = '') {
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
  const domMatched = new Map(selectors.map((text) => [text, true]));
  const ruleModel = await model.computeRuleModel(rules, {
    rootKey: 'root',
    view: undefined,
    domMatched,
  });
  const resolved = model.resolveStyle(ruleModel, context, activeSelector);
  assert.equal(region.root.toString(), css, 'reading spacing does not rewrite the CSS');
  return resolved;
}

// What the four sides of `box` resolve to, clockwise from the top.
const sidesOf = (resolved, box = 'padding') => SIDES.map((side) => resolved.props.get(`${box}-${side}`)?.winner.value);

// The padding declarations written directly on `rule`, in source order.
const paddingOf = (rule) =>
  rule.nodes
    .filter((node) => node.type === 'decl' && node.prop.startsWith('padding'))
    .map((declaration) => [declaration.prop, declaration.value, declaration.important === true]);

// `.card { source }` after each `[prop, value, important]` edit, in order.
function edited(source, edits) {
  const rule = postcss.parse(`.card { ${source} }`).first;
  for (const [prop, value, important = false] of edits) {
    model.setPaddingDeclaration(rule, prop, { value, important });
  }
  return rule;
}

const eachSide = (values) => SIDES.map((side, index) => [`padding-${side}`, values[index]]);

// Four ungrouped sides holding `value`, in the order the compact form writes them.
const eachSideOrdered = (value) => ['top', 'bottom', 'right', 'left'].map((side) => [`padding-${side}`, value, false]);

test('a shorthand of one to four values fills the four sides, as CSS expands it', async () => {
  const cases = [
    ['1rem', ['1rem', '1rem', '1rem', '1rem']],
    ['1px 2px', ['1px', '2px', '1px', '2px']],
    ['1px 2px 3px', ['1px', '2px', '3px', '2px']],
    ['1px 2px 3px 4px', ['1px', '2px', '3px', '4px']],
    ['var(--space-3, 6px) calc(1rem + 2px)', ['var(--space-3, 6px)', 'calc(1rem + 2px)', 'var(--space-3, 6px)', 'calc(1rem + 2px)']],
  ];
  for (const [value, expected] of cases) {
    assert.deepEqual(sidesOf(await resolve(`.card { padding: ${value} }`)), expected, value);
  }
  const margin = await resolve('.card { margin: 0 auto }');
  assert.deepEqual(sidesOf(margin, 'margin'), ['0', 'auto', '0', 'auto']);
});

test('an axis shorthand fills its two sides and leaves the other axis unset', async () => {
  const inline = await resolve('.card { padding-inline: 1rem 2rem }');
  assert.deepEqual(sidesOf(inline), [undefined, '2rem', undefined, '1rem']);
  const block = await resolve('.card { padding-block: 3rem }');
  assert.deepEqual(sidesOf(block), ['3rem', undefined, '3rem', undefined]);
});

test('each projected side reads as set by the picked selector, in its own sheet', async () => {
  const resolved = await resolve('.card { padding: var(--space-3) }');
  assert.equal(resolved.props.get('padding').selectedValue.value, 'var(--space-3)');
  for (const side of SIDES) {
    const shown = resolved.props.get(`padding-${side}`);
    assert.equal(shown.source, 'selected', side);
    assert.equal(shown.winner.embedKey, 'file:/site.css', side);
    assert.equal(shown.overridden, false, side);
  }
});

test('within a rule the later declaration wins, unless an earlier one is important', async () => {
  const after = await resolve('.card { padding: 1rem; padding-left: 2rem }');
  assert.deepEqual(sidesOf(after), ['1rem', '1rem', '1rem', '2rem']);
  const before = await resolve('.card { padding-left: 2rem; padding: 1rem }');
  assert.deepEqual(sidesOf(before), ['1rem', '1rem', '1rem', '1rem']);
  const shorthand = await resolve('.card { padding: 1rem !important; padding-left: 2rem }');
  assert.deepEqual(sidesOf(shorthand), ['1rem', '1rem', '1rem', '1rem']);
  assert.equal(shorthand.props.get('padding-left').winner.important, true);
  const longhand = await resolve('.card { padding-left: 2rem !important; padding: 1rem }');
  assert.deepEqual(sidesOf(longhand), ['1rem', '1rem', '1rem', '2rem']);
  const twice = await resolve('.card { padding: 1rem !important; padding: 2rem !important }');
  assert.deepEqual(sidesOf(twice), ['2rem', '2rem', '2rem', '2rem']);
});

test('a projected side takes part in the cascade across rules and queries', async () => {
  const overridden = await resolve('.card { padding: 1rem } .card.special { padding-left: 4rem }');
  const left = overridden.props.get('padding-left');
  assert.equal(left.winner.value, '4rem');
  assert.equal(left.selectedValue.value, '1rem');
  assert.equal(left.overridden, true);

  const elsewhere = await resolve('.card { padding: 1rem }', '.other');
  assert.equal(elsewhere.props.get('padding-top').source, 'other');

  const css = `.card { padding: 1rem } ${MEDIA} { .card { padding-left: 2rem } }`;
  const narrow = await resolve(css, '.card', MEDIA);
  assert.equal(narrow.props.get('padding-top').source, 'other', 'inherited from the base');
  assert.equal(narrow.props.get('padding-left').source, 'selected');
  assert.equal(narrow.props.get('padding-left').winner.value, '2rem');
});

test('a side set through a shorthand is edited and cleared in the shorthand’s rule', async () => {
  const css = '.card { padding: 1rem }\n.card { color: red }';
  const resolved = await resolve(css);
  const rules = [...resolved.selectedRules.values()];
  assert.equal(rules.indexOf(model.editableRuleFor(resolved, 'padding-left')), 0);
  const cleared = model.selectedRulesSetting(resolved, 'padding-left');
  assert.deepEqual(
    cleared.map((rule) => rules.indexOf(rule)),
    [0],
  );
  // A side set nowhere still goes to the last rule, where a new value wins a tie.
  assert.equal(rules.indexOf(model.editableRuleFor(resolved, 'margin-left')), 1);
});

test('values the box cannot read side by side set no side', async () => {
  for (const css of ['.card { padding: 1px 2px 3px 4px 5px }', '.card { padding-inline: 1px 2px 3px }']) {
    assert.deepEqual(sidesOf(await resolve(css)), [undefined, undefined, undefined, undefined], css);
  }
  assert.equal(model.spacingSides('padding', '').size, 0, 'an empty value');
  assert.equal(model.spacingSides('padding-top', '1px 2px').size, 0, 'two parts on one side');
  assert.equal(model.spacingSides('margin-inline', '1px').size, 0, 'a property the box skips');
  assert.equal(model.spacingSides('border-width', '1px 2px').size, 0, 'another box shorthand');
  assert.deepEqual(
    [...model.spacingSides('padding-block', '1rem 3rem')],
    [
      ['padding-top', '1rem'],
      ['padding-bottom', '3rem'],
    ],
  );
});

test('a padding edit rewrites the rule’s padding in its shortest form', () => {
  const cases = [
    [['3rem', '3rem', '3rem', '3rem'], [['padding', '3rem', false]]],
    // Every side set: one `padding`, in the fewest values that say it.
    [['1rem', '2rem', '1rem', '2rem'], [['padding', '1rem 2rem', false]]],
    [['1rem', '2rem', '3rem', '2rem'], [['padding', '1rem 2rem 3rem', false]]],
    [['1rem', '2rem', '1rem', '4rem'], [['padding', '1rem 2rem 1rem 4rem', false]]],
    [['1rem', '2rem', '3rem', '4rem'], [['padding', '1rem 2rem 3rem 4rem', false]]],
  ];
  for (const [values, expected] of cases) {
    const rule = edited('color: red; padding: 2rem;', eachSide(values));
    assert.deepEqual(paddingOf(rule), expected, values.join(' '));
  }
});

test('one side dragged off a shorthand keeps the three others, and no more', () => {
  assert.deepEqual(paddingOf(edited('padding: 2rem;', [['padding-left', '3rem']])), [['padding', '2rem 2rem 2rem 3rem', false]]);
  // Only what the rule declares is compacted: no side is invented from elsewhere.
  assert.deepEqual(paddingOf(edited('', [['padding-left', '2rem']])), [['padding-left', '2rem', false]]);
  // A longhand written before the shorthand lost to it; the edit must win.
  const reordered = edited('padding-top: 9rem; padding: 2rem;', [['padding-top', '1rem']]);
  assert.deepEqual(paddingOf(reordered), [['padding', '1rem 2rem 2rem', false]]);
  // Editing the shorthand itself replaces the sides that overrode it.
  const whole = edited('padding: 2rem; padding-top: 9rem;', [['padding', '3rem']]);
  assert.deepEqual(paddingOf(whole), [['padding', '3rem', false]]);
});

test('importance is part of a side’s value when sides are grouped', () => {
  const all = edited(
    'padding: 2rem !important;',
    SIDES.map((side) => [`padding-${side}`, '3rem', true]),
  );
  assert.deepEqual(paddingOf(all), [['padding', '3rem', true]]);
  const mixed = edited('padding: 2rem;', [['padding-top', '2rem', true]]);
  assert.deepEqual(paddingOf(mixed), [
    ['padding-top', '2rem', true],
    ['padding-bottom', '2rem', false],
    ['padding-inline', '2rem', false],
  ]);
  // An unimportant edit does not win over an important shorthand: nothing to regroup.
  const losing = edited('padding: 2rem !important;', [['padding-top', '3rem']]);
  assert.deepEqual(paddingOf(losing), [['padding', '2rem', true]]);
});

test('a var() that may hold several lengths is kept whole until every side is set', () => {
  const partial = edited('padding: var(--spacing);', [['padding-top', '3rem']]);
  assert.deepEqual(paddingOf(partial), [
    ['padding', 'var(--spacing)', false],
    ['padding-top', '3rem', false],
  ]);
  const full = edited('padding: var(--spacing);', eachSide(['3rem', '3rem', '3rem', '3rem']));
  assert.deepEqual(paddingOf(full), [['padding', '3rem', false]]);
  // A variable is never grouped: the shorthand would be one the next edit could
  // not split, and the rule would depend on the order the sides were set in.
  const tokens = edited('padding: 2rem;', eachSide(Array(4).fill('var(--space-3)')));
  assert.deepEqual(paddingOf(tokens), eachSideOrdered('var(--space-3)'));
  const reversed = edited('padding: 2rem;', eachSide(Array(4).fill('var(--space-3)')).reverse());
  assert.deepEqual(paddingOf(reversed), paddingOf(tokens), 'in any order');
  // A value with too many parts is left exactly as written.
  const unread = edited('padding: 1px 2px 3px 4px 5px;', [['padding-top', '3rem']]);
  assert.deepEqual(paddingOf(unread), [
    ['padding', '1px 2px 3px 4px 5px', false],
    ['padding-top', '3rem', false],
  ]);
});

test('compacting touches nothing but the rule’s own padding', () => {
  const source = 'color: red; padding: 2rem; /* keep */ & .child { padding: 7rem; }';
  const rule = edited(source, eachSide(['3rem', '3rem', '3rem', '3rem']));
  assert.equal(rule.toString(), '.card { color: red; padding: 3rem; /* keep */ & .child { padding: 7rem; } }');
});

test('clearing a side splits the shorthand that grouped it', () => {
  const rule = edited('padding: 2rem !important;', []);
  assert.equal(model.clearPaddingSides(rule, ['padding-top']), true);
  assert.deepEqual(paddingOf(rule), [
    ['padding-bottom', '2rem', true],
    ['padding-inline', '2rem', true],
  ]);
  assert.equal(model.clearPaddingSides(rule, ['padding-left', 'padding-right', 'padding-bottom']), true);
  assert.deepEqual(paddingOf(rule), []);
  assert.equal(model.clearPaddingSides(rule, ['padding-top']), false, 'nothing left to clear');
});

test('a clear leaves alone what it cannot or need not split', () => {
  const opaque = edited('padding: var(--spacing);', []);
  assert.equal(model.clearPaddingSides(opaque, ['padding-top']), false);
  assert.deepEqual(paddingOf(opaque), [['padding', 'var(--spacing)', false]]);
  const other = edited('padding-inline: 2rem;', []);
  assert.equal(model.clearPaddingSides(other, ['padding-top']), false, 'a side not set here');
  assert.equal(model.clearPaddingSides(other, ['color', 'margin-top', 'padding']), false);
  assert.deepEqual(paddingOf(other), [['padding-inline', '2rem', false]]);
});

test('a new rule, at the root or in a query, is compact from its first sides', () => {
  for (const context of ['', MEDIA]) {
    const region = model.parseRegion({ start: 0, end: 0, css: '', root: undefined });
    for (const side of SIDES) {
      const declared = { value: '3rem', important: false };
      if (context === '') {
        model.createRuleAtRoot(region, '.card', `padding-${side}`, declared);
      } else {
        model.createRuleInQuery(region, context, '.card', `padding-${side}`, declared);
      }
    }
    const rule = context === '' ? region.root.first : region.root.first.first;
    assert.deepEqual(paddingOf(rule), [['padding', '3rem', false]], context || 'root');
  }
});

test('the padding writer refuses a property that is not padding', () => {
  for (const prop of ['padding', 'PADDING-INLINE', ' padding-top ']) {
    assert.equal(model.isPaddingProperty(prop), true, prop);
  }
  for (const prop of ['margin', 'margin-top', 'padding-inline-start', 'padding-box', '']) {
    assert.equal(model.isPaddingProperty(prop), false, prop);
  }
  const rule = postcss.parse('.card { margin: 0 }').first;
  assert.throws(() => model.setPaddingDeclaration(rule, 'margin', { value: '1rem', important: false }), {
    message: 'Assertion failed: setPaddingDeclaration: the property is a padding property',
  });
  assert.equal(rule.toString(), '.card { margin: 0 }', 'and writes nothing');
});

// A padding side the rule has no declaration of yet joins its padding
// shorthand: `padding: 0.2em` with a left and right set is one
// `padding: 0.2em 0.59em`, not two longhands written after it.
{
  const postcss = require('postcss');
  const { addDeclaration } = require('../../helpers/rendererModule')('src/features/style/model/css.ts');
  const root = postcss.parse('code {\n  border-width: 1px;\n  padding: 0.2em;\n  border-radius: 4px;\n}');
  const rule = root.first;
  addDeclaration({ node: rule }, 'padding-left', { value: '0.59em', important: false });
  addDeclaration({ node: rule }, 'padding-right', { value: '0.59em', important: false });
  assert.equal(root.toString(), 'code {\n  border-width: 1px;\n  padding: 0.2em 0.59em;\n  border-radius: 4px;\n}');
}
