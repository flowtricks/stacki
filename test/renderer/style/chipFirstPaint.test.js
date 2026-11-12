// The selector chips are coloured on the first paint and stay so while data loads.
//
//   node test/renderer/style/chipFirstPaint.test.js
//
// Goal: a user reported that the Style panel's selector chips are grey for a while and
// gain their colours later. The cause was a neutral "provenance pending" state, applied
// to every chip of a component instance whenever its component file was being read
// (on selection before the read, and again after every save, because the cache is
// cleared on each style change). Now the colour comes from the selector text at once
// (selectorKind: class chips blue, plain chips grey) and the last settled answer for the
// component's green chips is remembered (chipProvenanceMemory.ts); the read only refines.
//
// Method, in three parts. (1) selectorKind over known-good shapes and the negative space
// (empty, odd characters, a selector past the parse bound). (2) The memory: set, merge,
// bounds. (3) The real SelectorPicker is mounted in jsdom over chips built by chipsFor
// with the component source still pending: every chip already carries its kind class
// and none the removed neutral class; the source then resolves and each chip keeps
// its colour class in between (`.icon` green from the first paint when remembered, blue
// when it was never seen, then green only as a true refinement).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'chip-first-paint.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { SelectorPicker } from './src/features/style/EmbedEditor';",
      "export { selectorKind, SELECTOR_KIND_PARSE_MAX } from './src/features/style/model/selectorParse';",
      "export { parseRegion, collectRules } from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      "export { chipsFor } from './src/features/style/embed/editorModel';",
      "export { classifySelector } from './src/features/style/embed/LayoutRows';",
      "export { selectedInstanceMarkup, selectedInstanceMarkupPending, selectedInstanceScope } from './src/features/style/model/webflowElement';",
      "export { rememberChipProvenance, rememberedGreenChips, forgetChipProvenance, PROVENANCE_CHIPS_MAX, PROVENANCE_SCOPES_MAX } from './src/features/style/model/chipProvenanceMemory';",
      "export { selectorKey } from './src/features/style/model/resolved';",
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

test('selectorKind decides the colour family from the text alone', () => {
  const cases = {
    svg: 'plain',
    ':target': 'plain',
    ':focus-visible': 'plain',
    '*': 'plain',
    'p::before': 'plain',
    '.icon': 'class',
    '#hero': 'class',
    '[data-open]': 'class',
    '.icon {&.large}': 'class',
    '.layout > *': 'class',
    'ul > li': 'plain',
    '.layout > :first-child': 'class',
    'a:hover': 'plain',
    '.a.b:hover': 'class',
    ':is(.a, .b)': 'class',
  };
  for (const [text, kind] of Object.entries(cases)) {
    assert.equal(model.selectorKind(text), kind, text);
  }
});

test('selectorKind never throws on the negative space, and bounds its work', () => {
  assert.equal(model.selectorKind(''), 'plain');
  assert.equal(model.selectorKind('   '), 'plain');
  for (const odd of ['(((', '..', '\u0000', '{&', ':', '::', '\\', '"', '🙂']) {
    assert.ok(['class', 'plain'].includes(model.selectorKind(odd)), odd);
  }
  const longPlain = 'div '.repeat(model.SELECTOR_KIND_PARSE_MAX);
  assert.equal(model.selectorKind(longPlain), 'plain');
  assert.equal(model.selectorKind(`${longPlain}.x`), 'class');
  assert.throws(() => model.selectorKind(undefined), /selectorKind: the selector is text/);
});

test('the remembered answer merges, forgets what turned plain, and is bounded', () => {
  model.forgetChipProvenance();
  assert.equal(model.rememberedGreenChips('/a.astro'), undefined);
  model.rememberChipProvenance('/a.astro', { greenKeys: ['.x', '.y'], plainKeys: [] });
  model.rememberChipProvenance('/a.astro', { greenKeys: ['.z'], plainKeys: ['.x'] });
  assert.deepEqual([...model.rememberedGreenChips('/a.astro')].sort(), ['.y', '.z']);
  model.rememberChipProvenance('/a.astro', { greenKeys: [], plainKeys: ['.y', '.z'] });
  assert.equal(model.rememberedGreenChips('/a.astro').size, 0, 'settled, with nothing green, is an answer too');
  const many = Array.from({ length: model.PROVENANCE_CHIPS_MAX + 40 }, (_, index) => `.c${index}`);
  model.rememberChipProvenance('/big.astro', { greenKeys: many, plainKeys: [] });
  assert.equal(model.rememberedGreenChips('/big.astro').size, model.PROVENANCE_CHIPS_MAX);
  for (let index = 0; index < model.PROVENANCE_SCOPES_MAX + 5; index += 1) {
    model.rememberChipProvenance(`/f${index}.astro`, { greenKeys: [], plainKeys: [] });
  }
  assert.equal(model.rememberedGreenChips('/a.astro'), undefined, 'the oldest component is dropped past the bound');
  assert.throws(() => model.rememberedGreenChips(''), /a scope is never empty/);
  model.forgetChipProvenance();
});

const COMPONENT_PATH = '/project/src/components/Icon.astro';
const COMPONENT_SOURCE = '---\n---\n<svg class="icon"><slot /></svg>\n';
const NODES = { svg: { tag: 'svg', classes: ['icon', 'text'], parent: undefined, children: [] } };
const view = {
  truncated: false,
  parentKey: () => undefined,
  childKeys: () => [],
  elementChildKeys: () => [],
  snapshot: async () => ({ tag: 'svg', id: undefined, classes: NODES.svg.classes, classList: NODES.svg.classes, attributes: {} }),
};
const BASE = { key: '', label: 'Base', breakpoint: undefined, embedAtContext: '' };

async function ruleModel() {
  const css = 'svg { fill: red; }\n.icon { color: blue; }\n.text { color: red; }\n';
  const region = model.parseRegion({ start: 0, end: css.length, css, root: undefined });
  const rules = model.collectRules(region, {
    embedKey: 'k',
    embedLabel: 'k',
    fromComponent: false,
    componentName: undefined,
    regionIndex: 0,
    idSeed: 'k',
    order: { n: 0 },
  });
  return model.computeRuleModel(rules, { rootKey: 'svg', view });
}

function chipsNow(rules, { markup, rememberedGreen }) {
  return model.chipsFor({
    model: rules,
    nativeModel: undefined,
    currentContext: BASE,
    activeSelector: '',
    selectedSelectorText: undefined,
    tokens: [],
    classList: ['icon', 'text'],
    removedClasses: new Set(),
    pseudo: '',
    componentMarkup: markup,
    rememberedGreen,
  });
}

test('mounted chips carry their colour with the component source pending, and keep it when it resolves', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  Object.assign(global, {
    window: dom.window,
    Window: dom.window.Window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  const store = new Map();
  global.localStorage = { getItem: (key) => store.get(key), setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const reactRoot = createRoot(document.getElementById('root'));
  const show = (chips) =>
    act(async () => {
      reactRoot.render(
        React.createElement(model.SelectorPicker, {
          selectors: chips,
          suggestions: [],
          activeSelector: '',
          activePicked: false,
          busy: false,
          loading: false,
          onSelect: () => {},
          onDeselect: () => {},
          onAdd: () => {},
        }),
      );
    });
  const classesByText = () =>
    Object.fromEntries(
      [...document.querySelectorAll('.embed-editor_selector-chip')].map((chip) => [
        chip.querySelector('.embed-editor_selector-chip-text')?.textContent ?? chip.textContent,
        chip.className,
      ]),
    );

  model.setHost({
    ...model.getHost(),
    nodes: [{ id: 'n1', kind: 'component', name: 'Icon', props: {} }],
    selectedId: 'n1',
    openFileKind: 'page',
    openFilePath: '/project/src/pages/index.astro',
    selectedComponentPath: COMPONENT_PATH,
    renderedClasses: [],
    renderedClassesKnown: true,
  });
  const scope = model.selectedInstanceScope();
  assert.equal(scope, COMPONENT_PATH);
  const rules = await ruleModel();

  // Never seen: the source is pending and nothing is remembered. The colour is the one the text decides.
  model.forgetChipProvenance();
  assert.equal(
    model.selectedInstanceMarkupPending([], () => true),
    true,
  );
  const pendingMarkup = model.selectedInstanceMarkup([], () => undefined);
  await show(chipsNow(rules, { markup: pendingMarkup, rememberedGreen: model.rememberedGreenChips(scope) }));
  const unseen = classesByText();
  assert.equal(Object.keys(unseen).length, 3, JSON.stringify(unseen));
  for (const [text, className] of Object.entries(unseen)) {
    assert.ok(className.includes(text.startsWith('.') ? 'is-class' : 'is-plain'), `${text}: ${className}`);
    assert.ok(!className.includes('is-provenance-pending'), `${text}: no neutral waiting state`);
    assert.ok(!className.includes('is-component'), `${text}: nothing is guessed green`);
  }

  // Seen before: the last settled answer is used while the file is read again.
  model.rememberChipProvenance(scope, { greenKeys: [model.selectorKey('.icon')], plainKeys: [model.selectorKey('svg'), model.selectorKey('.text')] });
  await show(chipsNow(rules, { markup: pendingMarkup, rememberedGreen: model.rememberedGreenChips(scope) }));
  const whilePending = classesByText();
  assert.ok(whilePending['.icon'].includes('is-component'), whilePending['.icon']);
  assert.ok(whilePending['.text'].includes('is-class') && !whilePending['.text'].includes('is-component'));
  assert.ok(whilePending.svg.includes('is-plain'));

  // The file arrives: only true refinements may differ, and no chip went neutral on the way.
  const markup = model.selectedInstanceMarkup([], () => COMPONENT_SOURCE);
  await show(chipsNow(rules, { markup, rememberedGreen: undefined }));
  const settled = classesByText();
  assert.deepEqual(settled, whilePending, 'the settled chips are the ones already shown');
  model.forgetChipProvenance();
});
