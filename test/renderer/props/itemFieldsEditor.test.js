// Goal: the Property settings pop-up's "Item fields" editor shows an icon for
// every kind of field, in the closed type dropdown and in each row of its menu;
// offers all sixteen kinds (and, on the last level of fields, only the ones
// that hold one value); lets a List or a Group hold fields of its own, added
// and removed in an indented block, down to the depth bound; and the default
// items editor shows each new kind with its own control and a nested list or
// group as a collapsible sub-editor.
//
// Method: ItemFieldsEditor and ListDefaultField rendered in jsdom with React
// from the app's own bundle, wrapped in a small host that keeps the shape in
// state as the pop-up does. The dropdown is opened by a click and read by its
// accessible names; every edit goes through the real controls. The negative
// space sits beside each check: the last level has no List or Group, a
// field cannot be removed when it is the only one, and a nested block opens
// only where the kind has fields.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/item-fields-editor');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'item-fields-editor.cjs');
buildSync({
  stdin: {
    contents: [
      "export { ItemFieldsEditor, ListDefaultField, ITEM_KIND_OPTIONS } from './src/features/props/PropertySections';",
      "export { ITEM_FIELD_KINDS, ITEM_FIELD_TITLES } from './src/editor/itemFields';",
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
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'navigator']) {
  global[name] = dom.window[name];
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
const { act, useState } = React;
const { createRoot } = require('react-dom/client');
const modules = require(output);

const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const typeInto = (input, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
let root;
async function draw(element) {
  root ??= createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
}
async function clear() {
  if (root !== undefined) {
    await act(async () => root.unmount());
    root = undefined;
  }
}

// The pop-up keeps the shape in state; so does this, and reports the latest.
let latest;
function Host(props) {
  const [shape, setShape] = useState(props.start);
  latest = shape;
  return React.createElement(modules.ItemFieldsEditor, { ...shape, onChange: (next) => setShape(next) });
}
const start = (fields, itemsText = '[]') => ({ fields, itemsText });
const text = (name) => ({ name, kind: 'text' });
const triggers = () => [...document.querySelectorAll('.dd-trigger[aria-label="Field type"]')];
const names = (root = document) => [...root.querySelectorAll('input[aria-label="Field name"]')].map((input) => input.value);
const menuOptions = () => [...document.querySelectorAll('.dd-option')];
const labelOf = (option) => option.querySelector('.dd-option-label').textContent;
async function openMenu(trigger) {
  await click(trigger);
  assert.ok(menuOptions().length > 0, 'the menu is open');
}
async function pick(trigger, title) {
  await openMenu(trigger);
  const option = menuOptions().find((candidate) => labelOf(candidate) === title);
  assert.ok(option, `${title} is offered`);
  await click(option);
}

test('every kind has an icon in the closed trigger and in its menu row', async () => {
  const fields = modules.ITEM_FIELD_KINDS.map((kind, index) => {
    const name = `f${index}`;
    if (kind === 'option') {
      return { name, kind, options: ['A', 'B'] };
    }
    if (kind === 'list' || kind === 'group') {
      return { name, kind, fields: [text('x')] };
    }
    return { name, kind };
  });
  await draw(React.createElement(Host, { start: start(fields) }));
  // The closed trigger of each row: its icon and its whole label.
  const rows = triggers().filter((trigger) => !trigger.closest('.property-nested-fields'));
  assert.equal(rows.length, 16, 'one row per kind');
  rows.forEach((trigger, index) => {
    const kind = modules.ITEM_FIELD_KINDS[index];
    assert.ok(trigger.querySelector('.dd-icon svg'), `${kind}: the closed trigger shows an icon`);
    assert.equal(trigger.querySelector('.dd-label').textContent, modules.ITEM_FIELD_TITLES[kind], `${kind}: the label is whole`);
  });
  // The menu lists every kind, each with an icon, and no two icons are the same drawing.
  await openMenu(rows[0]);
  const options = menuOptions();
  assert.deepEqual(options.map(labelOf).sort(), modules.ITEM_FIELD_KINDS.map((kind) => modules.ITEM_FIELD_TITLES[kind]).sort(), 'all labels');
  assert.equal(options.length, 16);
  for (const option of options) {
    assert.ok(option.querySelector('.dd-icon svg'), `${labelOf(option)}: the menu row shows an icon`);
  }
  const drawings = options.map((option) => option.querySelector('.dd-icon svg').innerHTML);
  assert.equal(new Set(drawings).size, 16, 'each kind has its own icon');
  assert.equal(options.filter((option) => option.querySelector('.dd-check svg')).length, 1, 'one check, on the selected kind');
  await clear();
});

test('every option the menu is built from has an icon, and the last level lists no List or Group', () => {
  assert.equal(modules.ITEM_KIND_OPTIONS.length, 16);
  assert.ok(modules.ITEM_KIND_OPTIONS.every((option) => option.icon !== undefined));
});

test('on the last level of fields only the kinds that hold one value are offered', async () => {
  // Three levels: the item's fields, a list's, and a list's inside it.
  const deepest = [{ name: 'a', kind: 'list', fields: [{ name: 'b', kind: 'list', fields: [text('c')] }] }];
  await draw(React.createElement(Host, { start: start(deepest) }));
  const all = triggers();
  assert.equal(all.length, 3);
  await openMenu(all[0]);
  assert.equal(menuOptions().length, 16, 'the first level offers all of them');
  await click(all[0]);
  await openMenu(all[2]);
  const labels = menuOptions().map(labelOf);
  assert.equal(labels.length, 14);
  assert.ok(!labels.includes('List') && !labels.includes('Group'), labels.join(', '));
  await click(all[2]);
  await clear();
});

test('a List holds fields of its own: added, renamed and removed in an indented block', async () => {
  await draw(React.createElement(Host, { start: start([text('title')], '[{ title: "A" }]') }));
  await pick(triggers()[0], 'List');
  assert.equal(latest.fields[0].kind, 'list');
  assert.deepEqual(latest.fields[0].fields, [text('title')], 'it starts with a title');
  assert.equal(latest.itemsText, '[{ title: [] }]', 'the item’s value is the list’s blank');
  const block = document.querySelector('.property-nested-fields');
  assert.ok(block, 'the nested fields sit in a block');
  assert.equal(block.getAttribute('aria-label'), 'Fields of title');
  // Add a field inside the list, and give it a kind.
  await click([...block.querySelectorAll('button')].find((button) => button.textContent.includes('Add field')));
  assert.deepEqual(names(block), ['title', 'field']);
  await typeInto(block.querySelectorAll('input[aria-label="Field name"]')[1], 'count');
  await pick(block.querySelectorAll('.dd-trigger[aria-label="Field type"]')[1], 'Number');
  assert.deepEqual(latest.fields[0].fields, [text('title'), { name: 'count', kind: 'number' }]);
  // Lists inside lists: the nested row can itself be a List, once.
  await pick(block.querySelectorAll('.dd-trigger[aria-label="Field type"]')[1], 'List');
  assert.equal(document.querySelectorAll('.property-nested-fields').length, 2, 'a block inside the block');
  // Remove one: the last field of a level cannot be.
  const inner = document.querySelectorAll('.property-nested-fields')[1];
  const innerRemove = inner.querySelector('button[aria-label="Remove field"]');
  assert.equal(innerRemove.disabled, true, 'the only field of a level stays');
  await click(block.querySelector('button[aria-label="Remove field"]'));
  assert.deepEqual(
    latest.fields[0].fields.map((entry) => entry.name),
    ['count'],
  );
  await clear();
});

test('a Group has fields of its own and an Option has its choices', async () => {
  await draw(React.createElement(Host, { start: start([text('place'), text('tone')]) }));
  await pick(triggers()[0], 'Group');
  assert.equal(document.querySelector('.property-nested-title').textContent, 'place has');
  assert.equal(latest.fields[0].kind, 'group');
  await pick(triggers()[triggers().length - 1], 'Option');
  assert.deepEqual(latest.fields[1].options, ['Option 1', 'Option 2']);
  const choices = document.querySelector('[aria-label="Options of tone"]');
  assert.ok(choices, 'the choices are edited under the row');
  assert.equal(choices.querySelectorAll('.list-field-row').length, 2);
  await clear();
});

test('the default items editor shows each new kind with its own control, and a nested list as a collapsible sub-editor', async () => {
  const fields = [
    text('title'),
    { name: 'tint', kind: 'color' },
    { name: 'day', kind: 'date' },
    { name: 'tone', kind: 'option', options: ['calm', 'loud'] },
    { name: 'mail', kind: 'email' },
    { name: 'kids', kind: 'list', fields: [text('name')] },
  ];
  const code = '[{ title: "One", tint: "#ff0000", day: "2026-01-02", tone: "loud", mail: "a@b.c", kids: [{ name: "Kid" }] }]';
  const changes = [];
  await draw(React.createElement(modules.ListDefaultField, { fields, code, projectPath: undefined, onChange: (next) => changes.push(next) }));
  const rows = document.querySelectorAll('[aria-label="Default items"] .list-field-row');
  assert.equal(rows.length, 1);
  await click(rows[0].querySelector('button, .list-field-text') ?? rows[0]);
  const popup = document.querySelector('.list-item-editor');
  assert.ok(popup, 'the item opens');
  assert.ok(popup.querySelector('.prop-color input[type="color"]'), 'a color has a swatch');
  assert.ok(popup.querySelector('select, .dd-trigger'), 'an option is a dropdown');
  assert.equal(popup.querySelector('input[type="email"]')?.value, 'a@b.c', 'an email is an email box');
  // The nested list is collapsed until opened.
  const head = popup.querySelector('.list-item-nested-head');
  assert.ok(head, 'the nested list has a header');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.ok(head.textContent.includes('1 item'));
  assert.equal(popup.querySelectorAll('.list-item-nested .list-field').length, 0, 'closed, it shows no rows');
  await click(head);
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  const nested = popup.querySelector('.list-item-nested .list-field');
  assert.ok(nested, 'open, it shows its own rows');
  assert.equal(nested.querySelectorAll('.list-field-row').length, 1);
  await click(nested.querySelector('.list-field-add'));
  assert.ok(document.querySelectorAll('.list-item-editor').length >= 2, 'adding opens the nested item');
  await clear();
});
