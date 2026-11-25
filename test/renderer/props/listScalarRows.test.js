// Goal: a plain value of a list is edited, in the popup a row opens, by a
// typed field with its icon, its binding circle and its `{}` toggle; the rows
// themselves stay plain text.
//
//   node test/renderer/props/listScalarRows.test.js
//
// `widths: number[]` lists its items as rows reading '320', '480', ...: no
// inputs in the list. Clicking a row opens the popup, which shows the number
// icon beside the label and the normal number input (numeric parsing, declared
// step and bounds, arrow keys; emptied is invalid and never written), the
// purple binding dot and the `{}` toggle. A list of words, of yes/no and of
// choices gets the text input, the switch and the dropdown by the same mapping
// (listItemType.ts). Add item opens the popup on a typed default. A bound item
// reads back as the chip any bound field shows, and the list stays one array.
//
// Method: the real PropField over a declared list, bundled as the app bundles
// it and rendered in jsdom with React; the field holds whatever it last wrote.
// Fixtures are generated here; no project is read.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/list-scalar-rows');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'list-scalar-rows.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as PropField } from './src/features/props/PropField';",
      "export { arrayItems, arrayText, fieldHoldsCode, itemsHoldCode } from './src/features/props/arrayValue';",
      "export { itemFieldOf, itemFieldValue, itemFieldKind } from './src/features/props/listItemShape';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
  global[name] = dom.window[name] ?? dom.window.MouseEvent;
}
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
installPopupDOM(dom.window);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const modules = require(output);

const BIND_CONTEXT = { frontmatter: 'const { card } = Astro.props;', propsSample: { card: { width: 800 } } };
const WIDTHS = { name: 'widths', type: 'code', optional: true, itemKind: 'number', min: 100, max: 2000, step: 10 };

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const click = (element) =>
  act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
const typeInto = (input, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });

let root;
function Host({ field, initial, writes }) {
  const [value, setValue] = React.useState(initial);
  return React.createElement(modules.PropField, {
    nodeKey: 'list',
    field,
    value: { type: 'expr', value },
    bindContext: BIND_CONTEXT,
    onChange: (next) => {
      writes.push(next.value);
      setValue(next.value);
    },
  });
}
async function draw(field, initial) {
  const writes = [];
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Host, { field, initial, writes })));
  return writes;
}
async function clear() {
  await act(async () => root.unmount());
}
const rows = () => [...document.querySelectorAll('.list-field-row')];
const popup = () => document.querySelector('.list-item-editor') ?? undefined;
const openRow = async (at) => {
  await click(document.querySelectorAll('.list-field-text')[at]);
  await flush();
  assert.ok(popup(), 'the item popup opened');
};

test('the list view is plain rows: the value as text, no inputs', async () => {
  await draw(WIDTHS, '[320, 480, 640]');
  assert.deepEqual(
    [...document.querySelectorAll('.list-field-text')].map((button) => button.textContent),
    ['320', '480', '640'],
  );
  assert.equal(rows().length, 3);
  assert.equal(
    document.querySelectorAll('.list-field-row input, .list-field-row .bind-handle, .list-field-row .prop-expr-toggle').length,
    0,
    'nothing is edited in the row',
  );
  assert.ok(document.querySelector('.list-field-add'));
  await clear();
});

test('a number item opens a popup with the number icon, the number input, the binding dot and {}', async () => {
  await draw(WIDTHS, '[320, 480, 640]');
  await openRow(2);
  const field = popup().querySelector('.props-field');
  assert.ok(field.querySelector('.prop-label-icon.is-number'), 'the number icon beside the label');
  assert.equal(field.querySelector('.num-field input').value, '640', 'the normal number input, on the value');
  assert.ok(field.querySelector(':scope > label .bind-handle .bind-dot'), 'the purple binding dot');
  assert.ok(field.querySelector(':scope > label .prop-expr-toggle'), 'and the {} toggle');
  assert.equal(popup().querySelectorAll('input:not(.num-field input)').length, 0, 'no second, text input');
  await clear();
});

test('typing a number writes a number; an emptied input is invalid and is not written', async () => {
  const writes = await draw(WIDTHS, '[320, 480]');
  await openRow(1);
  await typeInto(popup().querySelector('.num-field input'), '500');
  assert.equal(writes.at(-1), '[320, 500]', 'a number, not a word');
  const before = writes.length;
  await typeInto(popup().querySelector('.num-field input'), '');
  assert.equal(writes.length, before, 'empty writes nothing');
  assert.ok(popup().querySelector('.list-scalar-item').classList.contains('is-invalid'), 'and shows as invalid');
  await typeInto(popup().querySelector('.num-field input'), '-');
  assert.equal(writes.length, before, 'a lone sign is held, not written');
  await typeInto(popup().querySelector('.num-field input'), '720');
  assert.equal(writes.at(-1), '[320, 720]');
  assert.ok(!popup().querySelector('.list-scalar-item').classList.contains('is-invalid'));
  await clear();
});

test('the arrow keys step by the declared step and stay inside the declared bounds', async () => {
  const writes = await draw(WIDTHS, '[1990]');
  await openRow(0);
  const input = popup().querySelector('.num-field input');
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  assert.equal(writes.at(-1), '[2000]', 'one step of 10');
  await act(async () =>
    popup()
      .querySelector('.num-field input')
      .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  );
  assert.equal(writes.at(-1), '[2000]', 'never past the maximum');
  await clear();
});

test('Add item opens the popup on a typed default, and the item is added when it closes', async () => {
  const writes = await draw(WIDTHS, '[320]');
  await click(document.querySelector('.list-field-add'));
  await flush();
  assert.ok(popup().querySelector('.prop-label-icon.is-number'), 'the new item is a number');
  assert.equal(popup().querySelector('.num-field input').value, '100', 'at the lowest declared bound');
  await act(async () => document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })));
  assert.equal(writes.at(-1), '[320, 100]');
  await clear();
});

test('a bound item reads back as the chip, and the list stays a list', async () => {
  const writes = await draw(WIDTHS, '[320, 480]');
  await openRow(0);
  await click(popup().querySelector('.bind-handle'));
  await flush();
  const row = [...document.querySelectorAll('.dp-row')].find((candidate) => candidate.querySelector('.dp-key')?.textContent === 'width');
  assert.ok(row, 'the same data picker lists what is in scope');
  await click(row);
  await flush();
  assert.equal(writes.at(-1), '[card.width, 480]');
  assert.ok(popup().querySelector('.expr-chip'), 'it reads back as a chip');
  assert.equal(document.querySelectorAll('.list-field-text')[0].textContent, 'card.width', 'and the row says what it is bound to');
  await clear();
});

test('words, yes/no and choices get the text input, the switch and the dropdown', async () => {
  await draw({ name: 'tags', type: 'code', optional: true, itemKind: 'text' }, '["a", "b"]');
  await openRow(0);
  assert.ok(popup().querySelector('.prop-label-icon.is-string'));
  assert.equal(popup().querySelector('input').value, 'a');
  assert.ok(popup().querySelector('.bind-handle'));
  await clear();

  await draw({ name: 'flags', type: 'code', optional: true, itemKind: 'switch' }, '[true, false]');
  await openRow(0);
  assert.ok(popup().querySelector('.prop-label-icon.is-boolean'));
  assert.ok(popup().querySelector('.bind-handle'));
  await clear();

  const writes = await draw({ name: 'sizes', type: 'code', optional: true, itemKind: 'choice', options: ['s', 'm'] }, '["s"]');
  await openRow(0);
  assert.ok(popup().querySelector('.prop-label-icon.is-enum'));
  assert.ok(popup().querySelector('.bind-handle'));
  await click(document.querySelector('.list-field-add'));
  await flush();
  await act(async () => document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })));
  assert.equal(writes.at(-1), '["s", "s"]', 'a choice starts at its first word');
  await clear();
});

test('an undeclared list is read from its values', async () => {
  await draw({ name: 'widths', type: 'code', optional: true }, '[320, 480]');
  await openRow(0);
  assert.ok(popup().querySelector('.prop-label-icon.is-number'), 'numbers are number items');
  assert.ok(popup().querySelector('.num-field input'));
  await clear();
  await draw({ name: 'tags', type: 'code', optional: true }, '["a"]');
  await openRow(0);
  assert.ok(popup().querySelector('.prop-label-icon.is-string'));
  await clear();
});

test('an object item keeps its popup of fields, and a program stays code', async () => {
  await draw({ name: 'items', type: 'code', optional: true, shapeIsList: true, shape: [{ name: 'title', type: 'string' }] }, '[{ title: "One" }]');
  await openRow(0);
  assert.equal(popup().querySelectorAll('.list-scalar-item').length, 0, 'an object is its own fields');
  await clear();
  await draw(WIDTHS, '[...more]');
  assert.ok(!document.querySelector('.list-field'), 'a spread stays code');
  await clear();
});
