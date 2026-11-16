// Goal: the {} icon on a field that holds an expression switches it to the
// field's plain control in ONE click, with no menu, and never loses the user's
// code silently. A literal-equivalent expression (`{"text"}`, `{42}`) becomes
// the plain value; code (`{card.image}`) is replaced by the control's empty
// value (the one Reset gives; a valid empty value on a required prop, so the
// attribute is never left missing) and a "Binding removed · Undo" toast brings
// the code back with one click. The label menu no longer has a "Use the ..."
// item: it holds only "Reset to default property value". A plain value's {}
// still switches to expression mode. The app's undo is in
// test/renderer/app/normalFieldUndo.test.js.
// Method: the real PropsPanel, bundled with esbuild and mounted in jsdom over
// a hand-made schema, onSetProp recording every write; toasts are collected
// from the app's own toast channel. Each control kind (text, media src,
// number, enum, switch) is driven by one click on its {} button.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/normal-field-menu');
fs.mkdirSync(directory, { recursive: true });
const entry = path.join(directory, 'entry.js');
fs.writeFileSync(
  entry,
  [
    `export { default as PropsPanel } from ${JSON.stringify(repoPath('src/features/props/PropsPanel.tsx'))};`,
    `export { subscribeErrorToasts } from ${JSON.stringify(repoPath('src/ui/errorNotices.ts'))};`,
  ].join('\n'),
);
const output = path.join(directory, 'bundle.cjs');
buildSync({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window']) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const ux = require(output);
require('../../helpers/popupDom.js').installPopupDOM(dom.window);

const root = createRoot(document.getElementById('root'));
const noop = () => {};
const BASE = {
  slotOptions: [],
  takesSlotText: false,
  tagOptions: [],
  projectClasses: [],
  layouts: [],
  bindContext: {},
  allowAttrs: false,
  onSetProps: noop,
  onRenameProp: noop,
  onSetText: noop,
  onSetContent: noop,
  onSetInline: noop,
  onOpenCode: noop,
  onSetComment: noop,
};

// One mounted panel: its values, the writes it made, and a way to re-render.
function mount(schema, initial = {}, policy = 'instance') {
  // The write re-renders through the panel object, as the app's state update would.
  const panel = { values: { ...initial }, writes: [], render: noop };
  panel.render = () =>
    root.render(
      React.createElement(ux.PropsPanel, {
        ...BASE,
        schema,
        valuePolicy: policy,
        node: { id: 'n0', kind: 'component', name: 'Card', props: panel.values, children: undefined },
        onSetProp: (name, value, immediate) => {
          panel.writes.push({ name, value, immediate });
          const next = { ...panel.values };
          if (value === undefined) {
            delete next[name];
          } else {
            next[name] = value;
          }
          panel.values = next;
          panel.render();
        },
      }),
    );
  act(panel.render);
  return panel;
}

function label(name) {
  const found = [...document.querySelectorAll('.prop-label')].find((item) => item.firstChild?.textContent === name || item.textContent === name);
  assert.ok(found, `a label for ${name}`);
  return found;
}
const field = (name) => label(name).closest('.props-field');
// The first match under an element, undefined when there is none.
const one = (element, selector) => element.querySelector(selector) ?? undefined;

const SCHEMA = [
  { name: 'content', type: 'string', optional: false },
  { name: 'position', type: 'string', optional: true },
  { name: 'src', type: 'string', optional: true },
  { name: 'count', type: 'number', optional: true },
  { name: 'total', type: 'number', optional: false },
  { name: 'tone', type: 'enum', optional: true, options: ['soft', 'bold'] },
  { name: 'kind', type: 'enum', optional: false, options: ['soft', 'bold'] },
  { name: 'open', type: 'boolean', optional: true },
  { name: 'shut', type: 'boolean', optional: false },
];
const expr = (value) => ({ type: 'expr', value });
const menuItems = () => [...document.querySelectorAll('.prop-menu-item')].map((item) => item.textContent);
const toggle = (name) => label(name).closest('label').querySelector('.prop-expr-toggle');
const finish = () => act(() => root.render(React.createElement(React.Fragment)));
const toasts = [];
ux.subscribeErrorToasts(
  (notice) => toasts.push(notice),
  () => {},
);

test('one click on {} replaces code with the control empty value, and the toast Undo brings the code back', () => {
  const cases = [
    ['content', expr('customerStoriesMachineMode'), { type: 'string', value: '' }],
    ['position', expr('page.title'), undefined],
    ['src', expr('card.image'), undefined],
    ['count', expr('items.length'), undefined],
    ['total', expr('items.length'), expr('0')],
    ['tone', expr('theme'), undefined],
    ['kind', expr('theme'), { type: 'string', value: 'soft' }],
    ['open', expr('isOpen'), undefined],
    ['shut', expr('isShut'), expr('false')],
  ];
  for (const [name, code, empty] of cases) {
    toasts.length = 0;
    const panel = mount(SCHEMA, { [name]: code });
    assert.equal(menuItems().length, 0);
    act(() => toggle(name).click());
    assert.deepEqual(panel.writes, [{ name, value: empty, immediate: true }], `${name}: one immediate write, no menu`);
    assert.equal(menuItems().length, 0, `${name}: no menu opened`);
    assert.equal(toasts.length, 1, `${name}: one toast`);
    assert.equal(toasts[0].message, 'Binding removed');
    assert.equal(toasts[0].recovery[0].label, 'Undo');
    act(() => toasts[0].recovery[0].run());
    assert.deepEqual(panel.writes[1], { name, value: code, immediate: true }, `${name}: Undo writes the exact expression back`);
    assert.deepEqual(panel.values[name], code);
    finish();
  }
});

test('a literal-equivalent expression becomes the plain value, with no toast', () => {
  for (const [name, source, expected] of [
    ['content', '"text"', { type: 'string', value: 'text' }],
    ['content', '`text`', { type: 'string', value: 'text' }],
    ['content', '42', { type: 'string', value: '42' }],
    ['tone', '"bold"', { type: 'string', value: 'bold' }],
  ]) {
    toasts.length = 0;
    const panel = mount(SCHEMA, { [name]: expr(source) });
    act(() => toggle(name).click());
    assert.deepEqual(panel.writes, [{ name, value: expected, immediate: true }], `${name} ${source}`);
    assert.equal(toasts.length, 0, 'nothing was lost, so nothing to undo');
    finish();
  }
});

test('a literal the type refuses is replaced like code, and a required prop stays set', () => {
  toasts.length = 0;
  const panel = mount(SCHEMA, { tone: expr('"loud"'), kind: expr('"loud"') });
  act(() => toggle('tone').click());
  act(() => toggle('kind').click());
  assert.deepEqual(panel.writes, [
    { name: 'tone', value: undefined, immediate: true },
    { name: 'kind', value: { type: 'string', value: 'soft' }, immediate: true },
  ]);
  assert.ok(panel.values.kind, 'a required prop is never left without its attribute');
  finish();
});

test('the label menu has no "Use the ..." item, only Reset, and Reset works on an overridden prop', () => {
  const panel = mount(SCHEMA, { content: expr('someCode'), position: expr('otherCode') });
  act(() => label('position').click());
  assert.deepEqual(menuItems(), ['Reset to default property value']);
  const item = document.querySelector('.prop-menu-item');
  assert.equal(item.getAttribute('aria-disabled'), 'false', 'overridden: enabled');
  act(() => item.click());
  assert.deepEqual(panel.writes, [{ name: 'position', value: undefined, immediate: true }]);
  finish();
});

test('Reset on a required prop without a default writes the control empty value, never removes it', () => {
  const panel = mount(SCHEMA, { content: { type: 'string', value: 'Hi' }, kind: { type: 'string', value: 'bold' } });
  act(() => label('content').click());
  const item = document.querySelector('.prop-menu-item');
  assert.equal(item.getAttribute('aria-disabled'), 'false');
  act(() => item.click());
  assert.deepEqual(panel.writes, [{ name: 'content', value: { type: 'string', value: '' }, immediate: true }]);
  assert.ok(panel.values.content, 'the attribute is still there');
  finish();
});

test('Reset is disabled, with its reason as tooltip, when a required prop already holds its empty value', () => {
  const schema = [
    { name: 'heading', type: 'string', optional: true, default: 'Welcome' },
    { name: 'alt', type: 'string', optional: false },
  ];
  const panel = mount(schema, { heading: { type: 'string', value: 'Welcome' }, alt: { type: 'string', value: '' } });
  act(() => label('heading').click());
  assert.equal(document.querySelector('.prop-menu-item').getAttribute('aria-disabled'), 'false', 'an overridden prop resets even when equal to its default');
  act(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
  for (const name of ['alt']) {
    act(() => label(name).click());
    const item = document.querySelector('.prop-menu-item');
    assert.equal(item.getAttribute('aria-disabled'), 'true', name);
    assert.equal(item.getAttribute('title'), 'Already at its default value', name);
    act(() => item.click());
    act(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
  }
  assert.deepEqual(panel.writes, []);
  finish();
  const noEmpty = mount([{ name: 'count', type: 'number', optional: false, min: 0, minExclusive: true }], { count: expr('3') });
  act(() => label('count').click());
  assert.equal(document.querySelector('.prop-menu-item').getAttribute('title'), 'Required — there is no empty value to reset to');
  assert.deepEqual(noEmpty.writes, []);
  finish();
});

test('{} on a plain value still switches to expression mode', () => {
  const panel = mount(SCHEMA, { position: { type: 'string', value: 'customers' } });
  act(() => toggle('position').click());
  assert.deepEqual(panel.writes, [], 'switching mode writes nothing');
  assert.ok(label('position').closest('.props-field') !== undefined);
  assert.equal(toggle('position').getAttribute('aria-pressed'), 'true');
  finish();
});
