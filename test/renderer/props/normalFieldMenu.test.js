// Goal: the Properties panel's {} toggle and its label menu never destroy a
// prop's value. "Use the normal field" turns a literal-equivalent expression
// into the plain attribute in one immediate write; for code (an identifier, a
// call) the item is disabled with the reason "Value comes from code" as its
// tooltip and a click writes nothing; "Reset to default property value" is
// disabled on a required prop, which has no default to return to, and stays
// available on an optional one. The app's undo of the conversion is in
// test/renderer/app/normalFieldUndo.test.js.
// Method: the real PropsPanel, bundled with esbuild and mounted in jsdom over
// a hand-made schema (the shape of `<MachineMode content={...} position=...>`),
// onSetProp recording every write. Each case opens the label's menu and reads
// the items a designer sees, then clicks them, including the refused ones.
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
fs.writeFileSync(entry, [`export { default as PropsPanel } from ${JSON.stringify(repoPath('src/features/props/PropsPanel.tsx'))};`].join('\n'));
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
  { name: 'tone', type: 'enum', optional: true, options: ['soft', 'bold'] },
];
const expr = (value) => ({ type: 'expr', value });
const menuItem = (words) => [...document.querySelectorAll('.prop-menu-item')].find((item) => item.textContent.startsWith(words));
function openMenu(name) {
  act(() => label(name).click());
}
const finish = () => act(() => root.render(React.createElement(React.Fragment)));

test('code is not converted: the item is disabled with its reason, and a click writes nothing', () => {
  const values = { content: expr('customerStoriesMachineMode'), position: { type: 'string', value: 'customers' } };
  const panel = mount(SCHEMA, values);
  openMenu('content');
  const item = menuItem('Use the normal field');
  assert.ok(item, 'the menu still offers the item');
  assert.equal(item.getAttribute('aria-disabled'), 'true');
  assert.ok(item.classList.contains('disabled'));
  assert.equal(item.getAttribute('title'), 'Value comes from code');
  act(() => item.click());
  assert.deepEqual(panel.writes, [], 'nothing is written');
  assert.deepEqual(panel.values.content, expr('customerStoriesMachineMode'), 'the expression is still there');
  const toggle = label('content').closest('label').querySelector('.prop-expr-toggle');
  assert.equal(toggle.getAttribute('title'), 'Value comes from code', 'the {} button says why too');
  act(() => toggle.click());
  assert.deepEqual(panel.writes, [], 'the {} button writes nothing either');
  assert.equal(document.querySelector('.props-field .prop-field-note.required') ?? undefined, undefined, 'the prop is still set, so no Required error');
  finish();
});

test('a literal-equivalent expression becomes the plain attribute in one immediate write', () => {
  for (const [source, expected] of [
    ['"text"', 'text'],
    ['`text`', 'text'],
    ['42', '42'],
  ]) {
    const panel = mount(SCHEMA, { content: expr(source) });
    openMenu('content');
    const item = menuItem('Use the normal field');
    assert.equal(item.getAttribute('aria-disabled'), 'false', source);
    act(() => item.click());
    assert.deepEqual(panel.writes, [{ name: 'content', value: { type: 'string', value: expected }, immediate: true }], source);
    assert.deepEqual(panel.values.content, { type: 'string', value: expected });
    finish();
  }
});

test('an enum takes a literal that is an option, and refuses one that is not', () => {
  const good = mount(SCHEMA, { tone: expr('"bold"') });
  openMenu('tone');
  act(() => menuItem('Use the').click());
  assert.deepEqual(good.writes, [{ name: 'tone', value: { type: 'string', value: 'bold' }, immediate: true }]);
  finish();
  const bad = mount(SCHEMA, { tone: expr('"loud"') });
  openMenu('tone');
  const item = menuItem('Use the');
  assert.equal(item.getAttribute('title'), 'This value is not valid for the normal field');
  act(() => item.click());
  assert.deepEqual(bad.writes, []);
  finish();
});

test('Reset to default is disabled on a required prop and works on an optional one', () => {
  const panel = mount(SCHEMA, { content: { type: 'string', value: 'Hi' }, position: { type: 'string', value: 'customers' } });
  openMenu('content');
  const refused = menuItem('Reset to default');
  assert.equal(refused.getAttribute('aria-disabled'), 'true');
  assert.equal(refused.getAttribute('title'), 'Required — there is no default to go back to');
  act(() => refused.click());
  assert.deepEqual(panel.writes, [], 'a required prop is not removed');
  assert.deepEqual(panel.values.content, { type: 'string', value: 'Hi' });
  finish();
  const optional = mount(SCHEMA, { content: { type: 'string', value: 'Hi' }, position: { type: 'string', value: 'customers' } });
  openMenu('position');
  const allowed = menuItem('Reset to default');
  assert.equal(allowed.getAttribute('aria-disabled'), 'false');
  act(() => allowed.click());
  assert.deepEqual(optional.writes, [{ name: 'position', value: undefined, immediate: true }]);
  finish();
});
