// Goal: a list of plain values is edited in its rows, each row its own typed,
// bindable field.
//
//   node test/renderer/props/listScalarRows.test.js
//
// `widths: number[]` shows number rows: the number icon at the left, the normal
// number input (arrow keys, numeric parsing; empty is invalid and never
// written), the purple binding dot on every row, and no generic "Value" popup.
// Add item makes a blank of the list's own type. A list of words, of yes/no and
// of choices gets the text input, the switch and the dropdown by the same
// mapping (listItemType.ts), and an undeclared list is read from its values.
// A row bound to data reads back as the chip any bound field shows, and the
// list stays one array literal.
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
const rows = () => [...document.querySelectorAll('.list-scalar-item')];

test('a number list shows the number icon, the number input and the binding dot on every row', async () => {
  await draw(WIDTHS, '[320, 480, 640]');
  assert.equal(rows().length, 3);
  assert.equal(document.querySelectorAll('.list-field-text').length, 0, 'no row opens a generic popup');
  for (const row of rows()) {
    assert.ok(row.querySelector('.prop-label-icon.is-number'), 'the number icon leads the row');
    assert.ok(row.querySelector('.num-field input'), 'the normal number input');
    assert.ok(row.querySelector('.bind-handle .bind-dot'), 'the purple binding dot');
  }
  assert.deepEqual(
    rows().map((row) => row.querySelector('.num-field input').value),
    ['320', '480', '640'],
  );
  await clear();
});

test('typing a number writes a number; an emptied input is invalid and is not written', async () => {
  const writes = await draw(WIDTHS, '[320, 480]');
  await typeInto(rows()[1].querySelector('.num-field input'), '500');
  assert.equal(writes.at(-1), '[320, 500]', 'a number, not a word');
  const before = writes.length;
  await typeInto(rows()[1].querySelector('.num-field input'), '');
  assert.equal(writes.length, before, 'empty writes nothing');
  assert.ok(rows()[1].classList.contains('is-invalid'), 'and is shown as invalid');
  await typeInto(rows()[1].querySelector('.num-field input'), '-');
  assert.equal(writes.length, before, 'a lone sign is held, not written');
  await typeInto(rows()[1].querySelector('.num-field input'), '720');
  assert.equal(writes.at(-1), '[320, 720]');
  assert.ok(!rows()[1].classList.contains('is-invalid'));
  await clear();
});

test('Add item makes a typed default at once, and a row binds to data', async () => {
  const writes = await draw(WIDTHS, '[320]');
  await click(document.querySelector('.list-field-add'));
  assert.equal(writes.at(-1), '[320, 100]', 'a number inside the declared bounds');

  await click(rows()[0].querySelector('.bind-handle'));
  await flush();
  const row = [...document.querySelectorAll('.dp-row')].find((candidate) => candidate.querySelector('.dp-key')?.textContent === 'width');
  assert.ok(row, 'the same data picker lists what is in scope');
  await click(row);
  await flush();
  assert.equal(writes.at(-1), '[card.width, 100]', 'one value of code in the literal');
  assert.ok(rows()[0].querySelector('.expr-chip'), 'and it reads back as a chip');
  await clear();
});

test('words, yes/no and choices get the text input, the switch and the dropdown', async () => {
  await draw({ name: 'tags', type: 'code', optional: true, itemKind: 'text' }, '["a", "b"]');
  assert.ok(rows()[0].querySelector('.prop-label-icon.is-string'));
  assert.ok(rows()[0].querySelector('input'));
  assert.ok(rows()[0].querySelector('.bind-handle'));
  await clear();

  await draw({ name: 'flags', type: 'code', optional: true, itemKind: 'switch' }, '[true, false]');
  assert.ok(rows()[0].querySelector('.prop-label-icon.is-boolean'));
  assert.ok(rows()[0].querySelector('.bind-handle'));
  await clear();

  const writes = await draw({ name: 'sizes', type: 'code', optional: true, itemKind: 'choice', options: ['s', 'm'] }, '["s"]');
  assert.ok(rows()[0].querySelector('.prop-label-icon.is-enum'));
  assert.ok(rows()[0].querySelector('.bind-handle'));
  await click(document.querySelector('.list-field-add'));
  assert.equal(writes.at(-1), '["s", "s"]', 'a choice starts at its first word');
  await clear();
});

test('an undeclared list is read from its values', async () => {
  await draw({ name: 'widths', type: 'code', optional: true }, '[320, 480]');
  assert.ok(rows()[0].querySelector('.prop-label-icon.is-number'), 'numbers are number rows');
  await clear();
  const writes = await draw({ name: 'tags', type: 'code', optional: true }, '["a"]');
  assert.ok(rows()[0].querySelector('.prop-label-icon.is-string'));
  await click(document.querySelector('.list-field-add'));
  assert.equal(writes.at(-1), '["a", ""]');
  await clear();
});

test('an object item keeps its popup, and a program stays code', async () => {
  await draw({ name: 'items', type: 'code', optional: true, shapeIsList: true, shape: [{ name: 'title', type: 'string' }] }, '[{ title: "One" }]');
  assert.equal(rows().length, 0, 'objects are not scalar rows');
  assert.equal(document.querySelectorAll('.list-field-text').length, 1);
  await clear();
  await draw(WIDTHS, '[...more]');
  assert.ok(!document.querySelector('.list-field'), 'a spread stays code');
  await clear();
});
