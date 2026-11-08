// Goal: a rule styling an element's ::before or ::after belongs to that navigator row,
// not to the element. The element's selector list showed `&::after` and `&:hover::after`
// beside its own rules, so its counts, query dots and picks all read a generated box as
// the element. Everything that reads the list has to agree on which box a rule styles.
// Method: real stylesheets through the panel's own parser (parseRegion, collectRules),
// matcher (computeRuleModel, over a small tree shaped like the Pidgin FAQ) and models
// (chipsFor, resolveStyle, indexPlacedContexts). The first fixture is that page's CSS.
// Nothing is hand-matched, so a selector the matcher attributes wrongly fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'pseudo-layers.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { parseRegion } from './src/features/style/model/cssRegions';",
      "export { collectRules } from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      "export { compileSelectorList } from './src/features/style/model/selectorParse';",
      "export { editableRuleFor, groupMemberToSplit, resolveStyle, selectedRulesSetting } from './src/features/style/model/resolved';",
      "export { contextKeysWithStyles, indexPlacedContexts } from './src/features/style/model/queryWrapper';",
      "export { wrapperOnLayer } from './src/features/style/model/queryReach';",
      "export { buildCssRuleView } from './src/features/style/model/cssRuleView';",
      "export { chipsFor, pseudoPickFor, pseudoPickPending, readPanelLayer } from './src/features/style/embed/editorModel';",
      "export { classifySelector } from './src/features/style/embed/LayoutRows';",
      "export { cssRuleForLayer, cssRuleMatchesSelector, cssRuleMatchesVisibleSelector } from './src/features/style/embed/QueryForms';",
      "export { setHost, getHost } from './src/features/style/model/host';",
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

// The FAQ rules of the user's `src/pages/index.astro`, as that page writes them.
const FAQ = `
section.faq {
  details {
    border-bottom-style: solid;
    summary {
      display: flex;
      &:hover::after { background-color: red; color: white; }
      font-size: 1.5rem;
      &::after { content: "+"; width: 1.9rem; }
      :open > &::after { transform: rotate(45deg); }
    }
  }
}`;
const FAQ_ELEMENT = 'section.faq details summary';
const FAQ_AFTER = 'section.faq details summary::after';
const FAQ_HOVER_AFTER = 'section.faq details summary:hover::after';
const FAQ_OPEN_AFTER = ':open > section.faq details summary::after';

// The tree every case matches against: body > section.faq > details > summary.a > span.child.
const NODES = {
  body: { tag: 'body', classes: [], parent: undefined, children: ['section'] },
  section: { tag: 'section', classes: ['faq'], parent: 'body', children: ['details'] },
  details: { tag: 'details', classes: [], parent: 'section', children: ['summary'] },
  summary: { tag: 'summary', classes: ['a'], parent: 'details', children: ['child'] },
  child: { tag: 'span', classes: ['child'], parent: 'summary', children: [] },
};
const view = {
  truncated: false,
  parentKey: (key) => NODES[key].parent,
  childKeys: (key) => NODES[key].children,
  elementChildKeys: (key) => NODES[key].children,
  snapshot: async (key) => ({ tag: NODES[key].tag, id: undefined, classes: NODES[key].classes, classList: NODES[key].classes, attributes: {} }),
};
const BASE = { key: '', label: 'Base', breakpoint: undefined, embedAtContext: '' };

async function modelOf(css, rootKey = 'summary') {
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
  return model.computeRuleModel(rules, { rootKey, view });
}

function chips(ruleModel, pseudo, activeSelector = '') {
  return model.chipsFor({
    model: ruleModel,
    nativeModel: undefined,
    currentContext: BASE,
    activeSelector,
    selectedSelectorText: activeSelector || undefined,
    tokens: [],
    classList: [],
    removedClasses: new Set(),
    pseudo,
  });
}
const texts = (ruleModel, pseudo, activeSelector) =>
  chips(ruleModel, pseudo, activeSelector)
    .map((chip) => chip.text)
    .sort();
const resolveOn = (ruleModel, activeSelector, pseudoLayer) =>
  model.resolveStyle(ruleModel, '', activeSelector, { source: 'embed', contribs: [], selectedIndex: undefined, pseudoLayer });

test('the element lists its own rules, and none of its ::after', async () => {
  const faq = await modelOf(FAQ);
  assert.deepEqual(texts(faq, ''), [FAQ_ELEMENT]);
});

test('the ::after row lists exactly its rules, state variants included', async () => {
  const faq = await modelOf(FAQ);
  assert.deepEqual(texts(faq, '::after'), [FAQ_AFTER, FAQ_HOVER_AFTER, FAQ_OPEN_AFTER].sort());
  assert.deepEqual(texts(faq, '::before'), [], '::after rules are not the ::before row');
});

test('every spelling of a pseudo-element subject leaves the element for its row', async () => {
  const forms = [
    'summary::after',
    'section.faq summary::after',
    'summary:after',
    'section.faq summary:after',
    'summary::AFTER',
    'summary:hover::after',
    'summary.a:hover:after',
    'summary::after:hover',
    ':is(summary, .x)::after',
    ':global(summary::after)',
    'details > summary::after',
  ];
  for (const form of forms) {
    const ruleModel = await modelOf(`${form} { color: red; }`);
    assert.deepEqual(texts(ruleModel, ''), [], `${form} is not the element's`);
    assert.deepEqual(texts(ruleModel, '::after'), [form], `${form} is the ::after row's`);
    assert.deepEqual(texts(ruleModel, '::before'), [], `${form} is not the ::before row's`);
  }
});

test('::before and ::after are told apart, nested and flat', async () => {
  const ruleModel = await modelOf('summary { &::before { color: red; } } summary:before { top: 0; } summary::after { color: blue; }');
  assert.deepEqual(texts(ruleModel, '::before'), ['summary::before', 'summary:before'].sort());
  assert.deepEqual(texts(ruleModel, '::after'), ['summary::after']);
});

test('rules for the element itself stay on the element', async () => {
  const ruleModel = await modelOf('summary { &:hover { color: red; } &[open] { top: 0; } } .a:not(.b) { left: 0; }');
  assert.deepEqual(texts(ruleModel, ''), ['.a:not(.b)', 'summary:hover'].sort(), 'and an unmatched [open] does not join them');
  assert.deepEqual(texts(ruleModel, '::after'), []);
});

test('a descendant’s pseudo-element is not this element’s', async () => {
  const css = 'summary { &:hover .child::after { color: red; } }';
  const summary = await modelOf(css);
  assert.deepEqual(texts(summary, ''), []);
  assert.deepEqual(texts(summary, '::after'), [], 'the rule is about .child, not summary');
  const child = await modelOf(css, 'child');
  assert.deepEqual(texts(child, ''), [], 'on .child it is still its ::after');
  assert.deepEqual(texts(child, '::after'), ['summary:hover .child::after']);
});

test('a pseudo-element off the subject is no target', () => {
  const [selector] = model.compileSelectorList('.a::before .b');
  assert.equal(selector.pseudoElement, undefined);
});

test('a mixed list shows on both rows, each for its own part', async () => {
  const lists = [
    { css: 'summary, summary::after { color: red; }', element: 'summary', after: 'summary::after' },
    { css: 'section.faq summary, section.faq summary::after { color: red; }', element: 'section.faq summary', after: 'section.faq summary::after' },
    { css: 'section.faq summary::after, section.faq summary { color: red; }', element: 'section.faq summary', after: 'section.faq summary::after' },
    { css: 'section.faq summary { &, &::after { color: red; } }', element: 'section.faq summary', after: 'section.faq summary::after' },
  ];
  for (const { css, element, after } of lists) {
    const ruleModel = await modelOf(css);
    assert.deepEqual(texts(ruleModel, ''), [element], css);
    assert.deepEqual(texts(ruleModel, '::after'), [after], css);
    assert.equal(chips(ruleModel, '::after')[0].display, undefined, 'a member reads as itself, not as the whole list');
    // Both keep a write target: the rule, and in it the one member to split out.
    const onElement = resolveOn(ruleModel, element, undefined);
    const onAfter = resolveOn(ruleModel, after, '::after');
    assert.equal(onElement.props.get('color').source, 'selected', css);
    assert.equal(onAfter.props.get('color').source, 'selected', css);
    const rule = model.editableRuleFor(onAfter, 'color');
    assert.equal(rule, model.editableRuleFor(onElement, 'color'), 'one rule serves both until an edit splits it');
    const written = rule.node.selectors;
    assert.equal(written.length, 2);
    assert.notEqual(model.groupMemberToSplit(rule, element), model.groupMemberToSplit(rule, after), css);
    assert.match(written[model.groupMemberToSplit(rule, after)], /::after/, css);
    assert.doesNotMatch(written[model.groupMemberToSplit(rule, element)], /::after/, css);
  }
});

test('a ::before, ::after list is one chip per row, not its first member’s', async () => {
  const ruleModel = await modelOf('section.faq summary::before, section.faq summary::after { color: red; }');
  assert.deepEqual(texts(ruleModel, '::before'), ['section.faq summary::before']);
  assert.deepEqual(texts(ruleModel, '::after'), ['section.faq summary::after']);
  assert.deepEqual(texts(ruleModel, ''), []);
});

test('a list on one box stays one chip, and edits whole', async () => {
  const ruleModel = await modelOf('section.faq summary, section.faq .a { color: red; }');
  assert.deepEqual(texts(ruleModel, ''), ['section.faq summary, section.faq .a']);
  const rule = model.editableRuleFor(resolveOn(ruleModel, 'section.faq summary, section.faq .a', undefined), 'color');
  assert.equal(model.groupMemberToSplit(rule, 'section.faq summary, section.faq .a'), undefined);
});

test('::marker keeps its place with the element, and no row claims it', async () => {
  const ruleModel = await modelOf('details summary { top: 0; } details summary::marker { color: red; } summary::placeholder { color: blue; }');
  assert.deepEqual(texts(ruleModel, ''), ['details summary', 'details summary::marker', 'summary::placeholder'].sort());
  assert.deepEqual(texts(ruleModel, '::after'), []);
  assert.equal(resolveOn(ruleModel, 'details summary', undefined).props.has('color'), false, 'its value is not the element’s');
  assert.equal(resolveOn(ruleModel, 'details summary::marker', undefined).props.get('color').source, 'selected', 'picking it shows that box');
});

test('the element’s fields read its own rules, and the ::after row reads the ::after’s', async () => {
  const faq = await modelOf(FAQ);
  const element = resolveOn(faq, FAQ_ELEMENT, undefined);
  assert.equal(element.props.has('content'), false, 'an ::after rule’s content is not the element’s');
  assert.equal(element.props.has('transform'), false);
  assert.equal(element.props.get('display').source, 'selected');
  assert.equal(model.editableRuleFor(element, 'color').selectorText, FAQ_ELEMENT, 'a new style goes to the element rule');

  const after = resolveOn(faq, FAQ_AFTER, '::after');
  assert.equal(after.props.get('content').selectedValue.value, '"+"');
  assert.equal(after.props.has('display'), false, 'the element’s value is not the ::after’s');
  assert.equal(model.editableRuleFor(after, 'color').selectorText, FAQ_AFTER, 'a new style goes to the pseudo-element rule');
  assert.deepEqual(
    model.selectedRulesSetting(after, 'width').map((rule) => rule.selectorText),
    [FAQ_AFTER],
  );
});

test('a list’s first member does not decide which box the panel views', async () => {
  const ruleModel = await modelOf('section.faq summary::after, section.faq .x { color: red; } section.faq summary { top: 0; }');
  const folded = 'section.faq summary::after, section.faq .x';
  assert.deepEqual(texts(ruleModel, '::after'), [folded], 'only one member matches, so it stays whole');
  assert.equal(resolveOn(ruleModel, folded, '::after').props.get('color').source, 'selected');
  assert.equal(
    resolveOn(ruleModel, 'section.faq .x, section.faq summary::after', undefined).props.has('top'),
    true,
    'a list naming the element views the element',
  );
});

test('the filter counts follow the list', async () => {
  const faq = await modelOf(FAQ);
  const inherited = (layer) =>
    chips(faq, layer)
      .map(model.classifySelector)
      .filter((entry) => entry.inherited).length;
  assert.equal(inherited(''), 1);
  assert.equal(inherited('::after'), 3);
  const global = await modelOf('summary { top: 0; } summary::after { top: 0; } summary:hover::after { top: 0; }');
  const globals = (layer) =>
    chips(global, layer)
      .map(model.classifySelector)
      .filter((entry) => entry.global).length;
  assert.equal(globals(''), 1);
  assert.equal(globals('::after'), 2);
});

test('a query’s dot and listing are about the box in view', async () => {
  const media = '@media (width < 50rem)';
  const css = `summary { top: 0; } ${media} { summary::after { color: red; } }`;
  const ruleModel = await modelOf(css);
  const context = { key: media, label: media, breakpoint: undefined, embedAtContext: media };
  const dot = (layer) => model.indexPlacedContexts(ruleModel, [context], new Map(), layer)[0].hasStyles;
  assert.equal(dot(''), false, 'only the ::after has styles in the query');
  assert.equal(dot('::after'), true);
  assert.equal(dot('::before'), false);
  assert.equal(dot('every'), true);
  assert.equal(model.contextKeysWithStyles(ruleModel, '').size, 0);
  assert.equal(model.contextKeysWithStyles(ruleModel, '::after').size, 1);
});

test('a query nested in a pseudo-element reaches only that row', () => {
  assert.equal(model.wrapperOnLayer('section.faq summary::after', ''), false);
  assert.equal(model.wrapperOnLayer('section.faq summary::after', '::before'), false);
  assert.equal(model.wrapperOnLayer('section.faq summary::after', '::after'), true);
  assert.equal(model.wrapperOnLayer('section.faq summary', '::after'), true, 'the element’s rule holds its ::after’s nested rules');
  assert.equal(model.wrapperOnLayer('.a, .a::after', ''), true);
  assert.equal(model.wrapperOnLayer('.a::after', 'every'), true);
});

test('the CSS panel shows the box in view, and marks its part of a mixed list', async () => {
  const faq = await modelOf(FAQ);
  const shown = (ruleModel, layer, active) => {
    const visible = chips(ruleModel, layer).map((chip) => chip.text);
    return [...ruleModel.base, ...ruleModel.conditional]
      .filter((rule) => model.cssRuleMatchesVisibleSelector(rule, visible))
      .filter((rule) => (active ? model.cssRuleMatchesSelector(rule, active) : true))
      .map((rule) => model.cssRuleForLayer(rule, layer));
  };
  assert.deepEqual(
    shown(faq, '').map((rule) => rule.rule.selectorText),
    [FAQ_ELEMENT],
  );
  assert.equal(shown(faq, '::after').length, 3);
  const mixed = await modelOf('section.faq summary, section.faq summary::after { color: red; }');
  const view = model.buildCssRuleView(shown(mixed, '::after', 'section.faq summary::after'));
  assert.equal(view.selectors.length, 1);
  assert.equal(view.code.slice(view.selectors[0].from, view.selectors[0].to), 'section.faq summary::after');
});

test('the row picks its own rule, not a state variant of it', async () => {
  const node = { id: 'n', kind: 'element', name: 'summary', props: { class: { type: 'string', value: 'a' } } };
  const snapshot = { tag: 'summary', id: undefined, classes: ['a'], classList: ['a'], attributes: {} };
  const faq = await modelOf(FAQ);
  assert.deepEqual(model.pseudoPickFor(node, 'after', { snapshot, model: faq }), { kind: 'existing', selector: FAQ_AFTER });
  const hoverOnly = await modelOf('summary:hover::after { color: red; }');
  assert.deepEqual(model.pseudoPickFor(node, 'after', { snapshot, model: hoverOnly }), { kind: 'existing', selector: 'summary:hover::after' });
  const shouted = await modelOf('summary::AFTER { color: red; }');
  assert.deepEqual(model.pseudoPickFor(node, 'after', { snapshot, model: shouted }), { kind: 'existing', selector: 'summary::AFTER' });
});

test('a pseudo-element selector typed on the element keeps its chip', async () => {
  const faq = await modelOf(FAQ);
  assert.deepEqual(texts(faq, '', FAQ_AFTER), [FAQ_AFTER, FAQ_ELEMENT].sort());
  assert.equal(chips(faq, '', FAQ_AFTER).find((chip) => chip.text === FAQ_AFTER).pending, undefined, 'it has styles, so it is not pending');
  assert.deepEqual(texts(faq, '::after', FAQ_ELEMENT).includes(FAQ_ELEMENT), false, 'the element’s selector is no chip on the row');
});

test('a host with no pseudo-element rows lists every box, and a host with them lists one', async () => {
  const faq = await modelOf(FAQ);
  assert.equal(chips(faq, 'every').length, 4, 'a chip is Studio’s only way to reach the ::after');
  const host = model.getHost();
  const rows = (fields) => model.setHost({ ...host, selectedId: 'n', ...fields });
  rows({ pseudoRows: false, pseudoRequest: undefined });
  assert.equal(model.readPanelLayer(), 'every');
  rows({ pseudoRows: true, pseudoRequest: undefined });
  assert.equal(model.readPanelLayer(), '');
  rows({ pseudoRows: true, pseudoRequest: { nodeId: 'n', pseudo: 'after', serial: 1 } });
  assert.equal(model.readPanelLayer(), '::after');
  rows({ pseudoRows: true, pseudoRequest: { nodeId: 'other', pseudo: 'after', serial: 1 } });
  assert.equal(model.readPanelLayer(), '', 'a pick on another node is stale');
});

test('a write waits while the row’s pick is still the element’s selector', () => {
  const host = model.getHost();
  model.setHost({ ...host, selectedId: 'n', pseudoRows: true, pseudoRequest: { nodeId: 'n', pseudo: 'after', serial: 1 } });
  assert.equal(model.pseudoPickPending('.a'), true, 'it would land on the element');
  assert.equal(model.pseudoPickPending(''), true);
  assert.equal(model.pseudoPickPending('.a::after'), false);
  assert.equal(model.pseudoPickPending('.a:after'), false);
  model.setHost({ ...host, selectedId: 'n', pseudoRows: true, pseudoRequest: undefined });
  assert.equal(model.pseudoPickPending('.a'), false, 'on the element it is the target');
});
