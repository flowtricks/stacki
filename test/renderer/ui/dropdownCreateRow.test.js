// Goal: the Dropdown's create row makes a new option from a name typed inside the open menu. Picking the row turns
// it into a focused field in place; Enter makes and selects the option only when `validate` has no objection (its
// reason shows in the row, the menu stays open); Escape puts the row back and a second Escape closes the menu; a
// press elsewhere puts it back too; arrow keys and Space typed in the field stay in the field. Without a create row
// a dropdown draws exactly what it drew before.
// Method: the real Dropdown bundled as the app bundles it, rendered in jsdom with React and driven by DOM events;
// each case awaits React's act, never a timer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { repoPath, ROOT } = require('../../helpers/sources');
const output = repoPath('node_modules/.stacki-test/dropdown-create-row.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: { contents: "export { default as Dropdown } from './src/ui/Dropdown';", resolveDir: ROOT, loader: 'tsx' },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

function fixture(context, overrides = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div><button id="away">away</button>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const { Dropdown } = require(output);
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  const changes = [];
  const created = [];
  let options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ];
  let value = 'a';
  const createRow = {
    label: 'New item…',
    placeholder: 'Item name',
    validate: (text) =>
      text.trim() === '' ? 'Enter a name.' : options.some((option) => option.label.toLowerCase() === text.trim().toLowerCase()) ? 'Taken.' : undefined,
    onCreate: (text) => {
      created.push(text);
      options = [...options, { value: text.trim(), label: text.trim() }];
      return text.trim();
    },
  };
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(Dropdown, {
          value,
          options,
          onChange: (next) => {
            changes.push(next);
            value = next;
          },
          createRow,
          ...overrides,
        }),
      ),
    );
  return { dom, render, changes, created };
}

const trigger = () => document.querySelector('.dd-trigger');
const field = () => document.querySelector('.dd-create-field input') ?? undefined;
const menu = () => document.querySelector('.dd-popup') ?? undefined;
const click = (element) => act(async () => element.click());
const key = (element, name) => act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const type = (setup, text) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(setup.dom.window.HTMLInputElement.prototype, 'value').set.call(field(), text);
    field().dispatchEvent(new setup.dom.window.Event('input', { bubbles: true }));
  });
const openCreate = async () => {
  await click(trigger());
  const row = document.querySelector('.dd-create');
  assert.equal(row.textContent, 'New item…');
  assert.equal(row.getAttribute('role'), 'option');
  await click(row);
};

test('Enter makes and selects a valid name, then the menu closes', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await openCreate();
  assert.equal(document.activeElement, field());
  assert.equal(field().placeholder, 'Item name');
  await type(setup, 'Gamma');
  await key(field(), 'Enter');
  assert.deepEqual(setup.created, ['Gamma']);
  assert.deepEqual(setup.changes, ['Gamma']);
  assert.equal(menu(), undefined);
  // The caller answers with its new value and options, as the dialog does.
  await setup.render();
  assert.equal(trigger().textContent, 'Gamma');
});

test('an invalid name shows its reason in the row, keeps the menu open and makes nothing', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await openCreate();
  await key(field(), 'Enter');
  assert.equal(document.querySelector('.dd-create-error').textContent, 'Enter a name.');
  assert.equal(field().getAttribute('aria-invalid'), 'true');
  await type(setup, 'BETA');
  assert.equal(document.querySelector('.dd-create-error').textContent, 'Taken.');
  await key(field(), 'Enter');
  assert.ok(menu());
  assert.ok(field());
  assert.deepEqual(setup.created, []);
  assert.deepEqual(setup.changes, []);
});

test('arrow keys and Space stay in the field; Escape puts the row back and a second Escape closes the menu', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await openCreate();
  await type(setup, 'two words');
  for (const name of ['ArrowDown', 'ArrowUp', ' ']) {
    await key(field(), name);
  }
  assert.equal(field().value, 'two words');
  assert.deepEqual(setup.changes, []);
  await key(field(), 'Escape');
  assert.equal(field(), undefined);
  assert.ok(menu(), 'the first Escape leaves the menu open');
  assert.equal(document.querySelector('.dd-create').textContent, 'New item…');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(menu(), undefined);
  assert.deepEqual(setup.changes, []);
});

test('a press elsewhere puts the row back without making anything', async (context) => {
  const setup = fixture(context);
  await setup.render();
  await openCreate();
  await type(setup, 'Delta');
  await act(async () => field().dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
  assert.equal(field(), undefined);
  assert.deepEqual(setup.created, []);
});

test('a dropdown without a create row draws no create row', async (context) => {
  const setup = fixture(context, { createRow: undefined });
  await setup.render();
  await click(trigger());
  assert.equal(document.querySelector('.dd-create') ?? undefined, undefined);
  assert.deepEqual(
    [...document.querySelectorAll('.dd-option-label')].map((label) => label.textContent),
    ['Alpha', 'Beta'],
  );
});
