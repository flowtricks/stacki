// Exercise attribute literal parsing, real paste events, and expanded value editing.
// The object field must preserve rows and reject bounds; the value editor must open
// from a press and provide enough width to read a JavaScript expression.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const directory = path.join(__dirname, '../node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'prop-attributes.cjs');
buildSync({
  entryPoints: [path.join(__dirname, '../src/panels/propAttributes.tsx')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window']) {
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
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const {
  AttributesSection,
  ObjectAttrsField,
  parseObjectLiteral,
  serializeObjectLiteral,
  parseAttrPaste,
} = require(output);
assert.deepEqual(parseAttrPaste('id="hero" tabindex={2} disabled'), [
  { name: 'id', value: 'hero' },
  { name: 'tabindex', value: '{2}' },
  { name: 'disabled', value: '' },
]);
assert.deepEqual(parseObjectLiteral('{ id: "hero", tabindex: 2, disabled: true }'), [
  { key: 'id', raw: '"hero"' },
  { key: 'tabindex', raw: '2' },
  { key: 'disabled', raw: 'true' },
]);
assert.equal(parseObjectLiteral('{ nested: { key: 1 } }'), null);
assert.equal(parseObjectLiteral('{ ...defaults }'), null);
assert.equal(parseObjectLiteral('named'), null);
assert.equal(parseObjectLiteral('x'.repeat(8193)), null);
assert.equal(parseObjectLiteral(`{ ${Array(257).fill('a: 1').join(', ')} }`), null);
assert.deepEqual(parseAttrPaste('x'.repeat(8193)), []);
assert.deepEqual(parseAttrPaste(Array(257).fill('x="y"').join(' ')), []);
assert.equal(serializeObjectLiteral([{ key: 'data-id', raw: '"hero"' }]), '{ "data-id": "hero" }');
assert.throws(
  () => serializeObjectLiteral(Array(257).fill({ key: 'a', raw: '1' })),
  /Object attributes: entry limit exceeded/,
);
assert.throws(
  () => serializeObjectLiteral([{ key: 'a', raw: 'x'.repeat(8192) }]),
  /Object attributes: output limit exceeded/,
);
const root = createRoot(document.getElementById('root'));
let entries = Object.freeze([
  { key: 'id', raw: '"old"' },
  { key: 'title', raw: '"Title"' },
]);
let writes = 0;
const render = () =>
  act(async () =>
    root.render(
      React.createElement(ObjectAttrsField, {
        entries,
        pill: 'Attributes',
        menu: null,
        bindCtx: {},
        projectPath: '/project',
        onCommit: (next) => {
          entries = next;
          writes++;
        },
      }),
    ),
  );
const press = async (element) => {
  assert.ok(element);
  await act(async () =>
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  );
  await render();
};
const paste = async (text) => {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  const input = document.querySelector('.attr-editor input');
  assert.ok(input);
  await act(async () => input.dispatchEvent(event));
  await render();
};
(async () => {
  await render();
  await press(document.querySelector('.attr-row'));
  await paste('data-id="hero"');
  assert.deepEqual(entries, [
    { key: 'data-id', raw: '"hero"' },
    { key: 'title', raw: '"Title"' },
  ]);
  assert.equal(writes, 1);
  await paste('title="Updated" tabindex={2} disabled');
  assert.deepEqual(entries, [
    { key: 'data-id', raw: '"hero"' },
    { key: 'title', raw: '"Updated"' },
    { key: 'tabindex', raw: '2' },
    { key: 'disabled', raw: 'true' },
  ]);
  assert.equal(document.querySelector('.attr-editor'), null);
  assert.equal(writes, 2);
  await press(document.querySelector('button[title="Add attribute"]'));
  await paste('role="button"');
  assert.deepEqual(entries.at(-1), { key: 'role', raw: '"button"' });
  const before = writes;
  await paste(`id="${'x'.repeat(8193)}"`);
  assert.equal(writes, before);
  await act(async () =>
    root.render(
      React.createElement(AttributesSection, {
        node: {
          id: 'section',
          props: {
            'class:list': { type: 'expr', value: '["icon", variant]' },
            '...rest': { type: 'spread', value: 'rest' },
          },
        },
        names: ['class:list', '...rest'],
        bindCtx: { frontmatter: 'const variant = "medium";' },
        onSetProp: () => {},
        onRenameProp: () => {},
      }),
    ),
  );
  await act(async () =>
    document
      .querySelector('.attr-row')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  );
  const valueField = document.querySelector('.attr-value-field');
  assert.ok(valueField);
  valueField.getBoundingClientRect = () => new dom.window.DOMRect(600, 300, 280, 40);
  await act(async () =>
    valueField.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
    ),
  );
  assert.equal(document.querySelector('.attr-editor.var-src'), null);
  assert.ok(valueField.querySelector('.cm-lineWrapping'));
  await act(async () =>
    document
      .querySelector('button[title="Expand value"]')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  );
  const expanded = document.querySelector('.attr-editor.var-src');
  assert.ok(expanded);
  assert.equal(expanded.style.width, '760px');
  const spreadRow = document.querySelectorAll('.attr-row')[1];
  assert.equal(spreadRow.querySelector('.attr-name').textContent, '{...rest}');
  assert.equal(spreadRow.querySelector('.attr-eq'), null);
  assert.equal(spreadRow.querySelector('.attr-value'), null);
  await act(async () =>
    spreadRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
  );
  const spreadEditor = document.querySelector('.attr-editor');
  const spreadName = spreadEditor.querySelector('input');
  assert.equal(spreadName.value, '{...rest}');
  assert.equal(spreadName.readOnly, true);
  assert.equal(spreadEditor.querySelectorAll('.attr-editor-row').length, 1);
  assert.doesNotMatch(spreadEditor.textContent, /Value/);
  await act(async () => root.unmount());
  dom.window.close();
  console.log(
    'prop-attributes: parse bounds, single/bulk object pastes and row preservation passed',
  );
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
