// Goal: the Style panel's selector well lists the element's tag first when a rule
// styles it, then every other chip by CSS specificity, least specific first, so the
// list builds up the way the cascade does and the chip whose values win is the last
// one read. Chips of equal specificity keep the order they came in: the sort is stable.
// Method: the specificity calculator (selectorSpecificity, the parser the cascade uses)
// is pinned on each rule that is easy to get wrong: :where() counts nothing, :is(),
// :not() and :has() count their strongest argument, attributes and pseudo-classes count
// as classes, pseudo-elements as types. Then a real stylesheet goes through the panel's
// own parser, matcher and chip list (chipsFor) for the user's `p.cta_lede.text-style-large`,
// with the tag styled and unstyled, nested `&` rules and `:where()`, and bySpecificity
// and wellOrder are checked on their own for ties, invalid input and bounds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'selector-specificity.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { parseRegion } from './src/features/style/model/cssRegions';",
      "export { collectRules } from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      "export { selectorSpecificity } from './src/features/style/model/selectorParse';",
      "export { bySpecificity, chipsFor, isBareTagSelector, wellOrder } from './src/features/style/embed/editorModel';",
      "export { classifySelector } from './src/features/style/embed/LayoutRows';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const model = require(bundle);

// The tree: body > main > p.cta_lede.text-style-large.
const NODES = {
  body: { tag: 'body', classes: [], parent: undefined, children: ['main'] },
  main: { tag: 'main', classes: [], parent: 'body', children: ['lede'] },
  lede: { tag: 'p', classes: ['cta_lede', 'text-style-large'], parent: 'main', children: [] },
};
const view = {
  truncated: false,
  parentKey: (key) => NODES[key].parent,
  childKeys: (key) => NODES[key].children,
  elementChildKeys: (key) => NODES[key].children,
  snapshot: async (key) => ({ tag: NODES[key].tag, id: undefined, classes: NODES[key].classes, classList: NODES[key].classes, attributes: {} }),
};
const BASE = { key: '', label: 'Base', breakpoint: undefined, embedAtContext: '' };

async function modelOf(css) {
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
  return model.computeRuleModel(rules, { rootKey: 'lede', view });
}

function chipTexts(ruleModel, active = {}) {
  return model
    .chipsFor({
      model: ruleModel,
      nativeModel: undefined,
      currentContext: BASE,
      activeSelector: active.selector ?? '',
      selectedSelectorText: active.selector,
      tokens: [],
      classList: NODES.lede.classes,
      removedClasses: new Set(),
      pseudo: '',
    })
    .map((chip) => chip.text);
}

// The user's stylesheet, in the order the well listed it before it was sorted.
const LEDE_CSS = `
p { margin: 0; }
.cta_lede { color: red; }
.text-style-large { font-size: 2rem; }
[class*="text-style-"] { line-height: 1.2; }
:target { scroll-margin-top: 4rem; }
:focus-visible { outline: 2px solid; }
`;

test('the calculator counts ids, classes and types', () => {
  const cases = [
    ['p', [0, 0, 1]],
    ['*', [0, 0, 0]],
    ['.a', [0, 1, 0]],
    ['#a', [1, 0, 0]],
    ['#a.b c', [1, 1, 1]],
    ['main > p + p ~ p', [0, 0, 4]],
    ['a:hover', [0, 1, 1]],
    [':target', [0, 1, 0]],
    [':focus-visible', [0, 1, 0]],
    [':nth-child(2n + 1)', [0, 1, 0]],
  ];
  for (const [selector, expected] of cases) {
    assert.deepEqual(model.selectorSpecificity(selector), expected, selector);
  }
});

test('attribute selectors count as classes, whatever their operator', () => {
  const cases = [
    ['[class*="text-style-"]', [0, 1, 0]],
    ['[data-open]', [0, 1, 0]],
    ['[lang|=en i]', [0, 1, 0]],
    ['a[href^="http"][target]', [0, 2, 1]],
  ];
  for (const [selector, expected] of cases) {
    assert.deepEqual(model.selectorSpecificity(selector), expected, selector);
  }
});

test(':where() counts nothing, however strong its arguments', () => {
  assert.deepEqual(model.selectorSpecificity(':where(#a, .b, p)'), [0, 0, 0]);
  assert.deepEqual(model.selectorSpecificity(':where(#a) .b'), [0, 1, 0]);
  assert.deepEqual(model.selectorSpecificity('p:where(.a.b.c)'), [0, 0, 1]);
});

test(':is(), :not() and :has() count their most specific argument', () => {
  const cases = [
    [':is(#a, .b, p)', [1, 0, 0]],
    [':is(.a, p)', [0, 1, 0]],
    [':not(.a, #b)', [1, 0, 0]],
    [':not(p)', [0, 0, 1]],
    ['p:not(.a):not(.b)', [0, 2, 1]],
    ['.card:has(> img, #hero)', [1, 1, 0]],
    [':is(:where(#a), .b)', [0, 1, 0]],
    [':not(:is(#a, .b))', [1, 0, 0]],
  ];
  for (const [selector, expected] of cases) {
    assert.deepEqual(model.selectorSpecificity(selector), expected, selector);
  }
});

test('pseudo-elements count as types, legacy spellings too', () => {
  assert.deepEqual(model.selectorSpecificity('p::before'), [0, 0, 2]);
  assert.deepEqual(model.selectorSpecificity('.a:after'), [0, 1, 1]);
  assert.deepEqual(model.selectorSpecificity('.a:hover::after'), [0, 2, 1]);
});

test('a list weighs its strongest member; text that does not parse weighs nothing', () => {
  assert.deepEqual(model.selectorSpecificity('p, .a, #b'), [1, 0, 0]);
  assert.deepEqual(model.selectorSpecificity('.a .b, #c'), [1, 0, 0]);
  assert.deepEqual(model.selectorSpecificity('.a[unclosed'), [0, 0, 0]);
});

test('the user’s p.cta_lede.text-style-large lists its styled tag first, then least specific first', async () => {
  const chips = chipTexts(await modelOf(LEDE_CSS));
  assert.deepEqual(chips, ['p', '.cta_lede', '.text-style-large', '[class*="text-style-"]', ':target', ':focus-visible']);
});

test('an unstyled tag takes its place by specificity, after a (0,0,0) chip', async () => {
  const css = LEDE_CSS.replace('p { margin: 0; }', '') + '\n:where(.cta_lede) { margin: 1rem; }\n';
  const chips = chipTexts(await modelOf(css), { selector: 'p' });
  assert.deepEqual(chips, [':where(.cta_lede)', 'p', '.cta_lede', '.text-style-large', '[class*="text-style-"]', ':target', ':focus-visible']);
});

test('nested rules rank by the full selector they resolve to', async () => {
  const css = `${LEDE_CSS}\n.text-style-large { &.cta_lede { color: blue; } }\nmain { & > p { padding: 0; } }\n`;
  const chips = chipTexts(await modelOf(css));
  // `main > p` is (0,0,2), `.text-style-large.cta_lede` is (0,2,0).
  assert.equal(chips[0], 'p', 'the styled tag still leads');
  assert.equal(chips[1], 'main > p', '(0,0,2) sorts before every (0,1,0) chip');
  assert.equal(chips[chips.length - 1], '.text-style-large.cta_lede', '(0,2,0) sorts last');
});

test('chips of equal specificity keep the order they came in', async () => {
  // The four (0,1,0) global and attribute chips, written in reverse: the two
  // pseudo-classes tie on every readable rank too, so their stylesheet order decides.
  const reversed = `
:focus-visible { outline: 2px solid; }
:target { scroll-margin-top: 4rem; }
[class*="text-style-"] { line-height: 1.2; }
.text-style-large { font-size: 2rem; }
.cta_lede { color: red; }
p { margin: 0; }
`;
  const chips = chipTexts(await modelOf(reversed));
  assert.deepEqual(chips, ['p', '.cta_lede', '.text-style-large', '[class*="text-style-"]', ':focus-visible', ':target']);
});

test('a stronger chip moves behind a later, weaker one', async () => {
  const css = `${LEDE_CSS}\nmain > p.cta_lede { padding: 0; }\n:where(.cta_lede) { margin: 1rem; }\n`;
  const chips = chipTexts(await modelOf(css));
  assert.equal(chips[0], 'p', 'the styled tag leads whatever its specificity');
  assert.equal(chips[1], ':where(.cta_lede)', '(0,0,0) comes before every other chip');
  assert.equal(chips[chips.length - 1], 'main > p.cta_lede', '(0,1,2) outranks every (0,1,0) chip, so it sorts last');
});

test('a pending chip is ranked by its own text, not as (0,0,0)', async () => {
  const chips = chipTexts(await modelOf(LEDE_CSS), { selector: '.cta_lede.text-style-large:hover' });
  assert.equal(chips[chips.length - 1], '.cta_lede.text-style-large:hover', 'the picked (0,3,0) selector ends the well');
});

test('global and inherited chips keep their category after the sort', async () => {
  const css = `${LEDE_CSS}\nmain p { color: blue; }\n`;
  const chips = chipTexts(await modelOf(css));
  const categories = chips.map((text) => {
    const entry = model.classifySelector({ text });
    return entry.inherited ? 'inherited' : entry.global ? 'global' : 'own';
  });
  assert.deepEqual(chips, ['p', 'main p', '.cta_lede', '.text-style-large', '[class*="text-style-"]', ':target', ':focus-visible']);
  assert.deepEqual(categories, ['global', 'inherited', 'own', 'own', 'own', 'global', 'global']);
});

test('bySpecificity is stable, ranks weakest first, and keeps every chip', () => {
  const chip = (text, specificity) => ({ text, specificity });
  const input = [chip('a', [0, 1, 0]), chip('b', [0, 0, 1]), chip('c', [0, 1, 0]), chip('d', [1, 0, 0]), chip('e', [0, 1, 0]), chip('f', [0, 0, 0])];
  const sorted = model.bySpecificity(input);
  assert.deepEqual(
    sorted.map((entry) => entry.text),
    ['f', 'b', 'a', 'c', 'e', 'd'],
  );
  assert.deepEqual(
    input.map((entry) => entry.text),
    ['a', 'b', 'c', 'd', 'e', 'f'],
    'the input is not reordered in place',
  );
  const ties = Array.from({ length: 50 }, (_, index) => chip(`t${index}`, [0, 1, 0]));
  assert.deepEqual(
    model.bySpecificity(ties).map((entry) => entry.text),
    ties.map((entry) => entry.text),
    'fifty ties come out as they went in',
  );
  assert.deepEqual(model.bySpecificity([]), []);
});

test('a class count outranks any number of types, and an id any number of classes', () => {
  const chip = (text, specificity) => ({ text, specificity });
  const sorted = model.bySpecificity([chip('types', [0, 0, 12]), chip('classes', [0, 11, 0]), chip('id', [1, 0, 0])]);
  assert.deepEqual(
    sorted.map((entry) => entry.text),
    ['types', 'classes', 'id'],
  );
});

test('wellOrder puts a styled bare tag first and leaves an unstyled one in place', () => {
  const chip = (text, specificity, pending) => ({ text, specificity, ...(pending ? { pending: true } : {}) });
  const styled = model.wellOrder([chip('.heading', [0, 1, 0]), chip(':target', [0, 1, 0]), chip('h2', [0, 0, 1])]);
  assert.deepEqual(
    styled.map((entry) => entry.text),
    ['h2', '.heading', ':target'],
  );
  const unstyled = model.wellOrder([chip('.heading', [0, 1, 0]), chip('h2', [0, 0, 1], true), chip(':where(.x)', [0, 0, 0])]);
  assert.deepEqual(
    unstyled.map((entry) => entry.text),
    [':where(.x)', 'h2', '.heading'],
  );
  assert.deepEqual(model.wellOrder([]), []);
  // Only the tag alone leads: a tag with anything on it is a selector like any other.
  for (const text of ['h2:hover', 'h2::before', 'main h2', 'h2.heading', 'h2[data-x]', ':is(h2)', '*']) {
    assert.equal(model.isBareTagSelector(text), false, text);
  }
  assert.equal(model.isBareTagSelector('h2'), true);
});
