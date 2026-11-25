// Goal: a field of a list's item binds to data as a top-level prop's field does.
// Each field in the Item popup has the bind dot; picking a value writes it into
// the list as code (`{ title: entry.data.title, number: 0 }`); that literal reads
// back as a row and as a chip, and the `{}` code view shows it as written. Code
// that is not yet one value is never written, and what cannot be a row (an
// object inside a field) stays the code it was. A list's default keeps its
// bound fields as code rather than quoting them into words.
//
// Method: the real PropField over a declared list, bundled as the app bundles
// it and rendered in jsdom with React. The field holds whatever it last wrote,
// so reopening a row reads the written text back through the parser. Clicks and
// typing are dispatched as a person makes them; the data picker is the real one
// over a small tree. The literal rules run on the pure model.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/list-item-binding');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'list-item-binding.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as PropField } from './src/features/props/PropField';",
      "export { default as NewPropForm } from './src/features/props/NewPropForm';",
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

const LIST_FIELD = {
  name: 'features',
  type: 'code',
  optional: true,
  shapeIsList: true,
  shape: [
    { name: 'title', type: 'string' },
    { name: 'number', type: 'number' },
  ],
};
const BIND_CONTEXT = { frontmatter: 'const { entry } = Astro.props;', propsSample: { entry: { title: 'Hello' } } };

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const click = (element) =>
  act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
const popup = () => document.querySelector('.list-item-editor') ?? undefined;
const typeNumber = (input, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });

let root;
// A field that holds what it writes, as the page does.
function Host({ initial, writes }) {
  const [value, setValue] = React.useState(initial);
  return React.createElement(modules.PropField, {
    nodeKey: 'list',
    field: LIST_FIELD,
    value: { type: 'expr', value },
    bindContext: BIND_CONTEXT,
    onChange: (next) => {
      writes.push(next.value);
      setValue(next.value);
    },
  });
}
async function draw(initial) {
  const writes = [];
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Host, { initial, writes })));
  return writes;
}
async function clear() {
  await act(async () => root.unmount());
}
const openRow = async () => {
  await click(document.querySelector('.list-field-text'));
  await flush();
  assert.ok(popup(), 'the Item popup opened');
};

test('every field of an item has the bind dot', async () => {
  await draw('[{ title: "One", number: 0 }]');
  await openRow();
  const fields = [...popup().querySelectorAll('.props-field')];
  assert.equal(fields.length, 2);
  for (const field of fields) {
    assert.ok(field.querySelector(':scope > label .bind-dot'), 'the field has the dot');
    assert.ok(field.querySelector(':scope > label .prop-expr-toggle'), 'and its {}');
  }
  await clear();
});

test('binding a field writes the expression into the list, and it reads back as a chip', async () => {
  const writes = await draw('[{ title: "One", number: 0 }]');
  await openRow();
  await click(popup().querySelector('.props-field .bind-dot').closest('button'));
  await flush();
  const row = [...document.querySelectorAll('.dp-row')].find((candidate) => candidate.querySelector('.dp-key')?.textContent === 'title');
  assert.ok(row, 'the picker lists what is in scope');
  await click(row);
  await flush();
  assert.equal(writes.at(-1), '[{ title: entry.title, number: 0 }]');

  // Close and reopen: everything now comes from the text that was written.
  await click(popup().querySelector('[title="Close"]'));
  assert.equal(document.querySelector('.list-field-text').textContent, 'entry.title', 'the list is still rows');
  await openRow();
  const chip = popup().querySelector('.expr-chip');
  assert.ok(chip, 'the binding is a chip');
  assert.equal(chip.textContent, 'entry.title');
  await clear();
});

test('the code view shows a bound list as written', async () => {
  await draw('[{ title: entry.title, number: 0 }]');
  assert.ok(document.querySelector('.list-field'), 'it opens as a list');
  await click(document.querySelector('.prop-expr-toggle'));
  await flush();
  assert.equal(document.querySelector('.cm-content').textContent, '[{ title: entry.title, number: 0 }]');
  await clear();
});

test('a list with code a field cannot hold stays code', async () => {
  await draw('[{ title: { ...rest } }]');
  assert.ok(!document.querySelector('.list-field'), 'it stays code');
  assert.ok(document.querySelector('.cm-content, .bind-input'));
  await clear();
});

test('a half-typed number stays on screen and is never written', async () => {
  const writes = await draw('[{ title: "One", number: 0 }]');
  await openRow();
  const input = popup().querySelector('.num-field input');
  await typeNumber(input, '-');
  assert.equal(popup().querySelector('.num-field input').value, '-');
  assert.deepEqual(writes, []);
  await typeNumber(popup().querySelector('.num-field input'), '-2');
  assert.deepEqual(writes, ['[{ title: "One", number: -2 }]']);
  await clear();
});

test('the literal holds code per field, and round-trips byte for byte', () => {
  for (const source of [
    '[{ title: entry.data.title, number: 0 }]',
    '[{ title: format(entry.data.date, "a, b"), number: entry.count + 1 }]',
    '[{ title: `Hi ${name}`, on: a ? b : c }]',
    '[{ title: "One" }, { title: post.title }]',
  ]) {
    assert.equal(modules.arrayText(modules.arrayItems(source)), source);
  }
  assert.equal(modules.arrayText(modules.arrayItems('[{ a: { b: 1 } }]')), '[{ a: { b: 1 } }]', 'an object inside a field is a nested group, kept as written');
  assert.equal(modules.arrayText(modules.arrayItems('[{ a: [{ b: 1 }] }]')), '[{ a: [{ b: 1 }] }]', 'and a list a nested list');
  assert.equal(modules.arrayItems('[{ a: { b: { ...c } } }]'), undefined, 'a nested spread is still a program');
  assert.equal(modules.arrayItems('[...rest]'), undefined, 'a spread is still a program');
  assert.equal(modules.arrayItems('[a, "b"]'), undefined, 'and so is a word that is code');
});

test('code is told from a literal', () => {
  const code = (text) => modules.fieldHoldsCode({ text, quote: undefined });
  assert.equal(code('entry.title'), true);
  assert.equal(code('true'), false);
  assert.equal(code('-2.5'), false);
  assert.equal(modules.fieldHoldsCode({ text: 'entry.title', quote: '"' }), false, 'quoted words only look like code');
  assert.equal(modules.itemFieldKind({ key: 'title', keyQuote: undefined, text: 'entry.title', quote: undefined }, undefined), 'text');
});

test('a field writes only what the list can hold', () => {
  const field = { key: 'title', keyQuote: undefined, text: 'One', quote: '"' };
  const write = (value) => modules.itemFieldOf(field, value, 'text', '"');
  assert.deepEqual(write({ type: 'expr', value: ' entry.title ' }), { ...field, text: 'entry.title', quote: undefined });
  assert.deepEqual(write({ type: 'string', value: 'Two' }), { ...field, text: 'Two' });
  assert.deepEqual(write(undefined), { ...field, text: '' }, 'taken away, it is blank');
  for (const unfinished of ['format(', '-', 'a.', 'a, b']) {
    assert.equal(write({ type: 'expr', value: unfinished }), undefined, unfinished);
  }
  assert.deepEqual(modules.itemFieldValue(field), { type: 'string', value: 'One' });
  assert.deepEqual(modules.itemFieldValue({ ...field, text: 'x.y', quote: undefined }), { type: 'expr', value: 'x.y' });
  assert.equal(modules.itemFieldValue({ ...field, text: '' }), undefined);
});

test('a new List prop keeps a bound default as code, never as words', async () => {
  let declaration;
  const host = {
    componentName: 'Card.astro',
    propKeys: [],
    restLocal: undefined,
    create: (made) => {
      declaration = made;
      return { ok: true, value: made.key };
    },
  };
  root = createRoot(document.getElementById('root'));
  const seed = { fit: 'list', label: 'features', value: '[{ title: entry.title }]', itemFields: [{ name: 'title', kind: 'text' }] };
  await act(async () => root.render(React.createElement(modules.NewPropForm, { host, seed, onCreated() {}, onCancel() {} })));
  await click([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Create'));
  assert.equal(declaration.defaultExpression, '[{ title: entry.title }]');
  assert.deepEqual(declaration.list.items, []);
  await clear();
});

test('the popup spaces its fields as a form does', () => {
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  assert.match(css, /\.attr-editor\.list-item-editor \{\s*gap: 12px;/, 'the form’s gap between fields');
  assert.match(css, /\.list-item-editor \.props-field \{\s*margin: 0;/, 'and no panel margins on top of it');
});
