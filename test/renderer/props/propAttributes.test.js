// Exercise attribute literal parsing, real paste events, and expanded value editing.
// The object field must preserve rows and reject bounds; the value editor must open
// from a press and provide enough width to read a JavaScript expression. An app's
// `data-stacki-key` is never a row, and every edit to the rows around it (value,
// rename, delete, bulk paste) leaves it on the node with its value.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'prop-attributes.cjs');
buildSync({
  entryPoints: [repoPath('src/features/props/propAttributes.tsx')],
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
const { AttributesSection, ObjectAttrsField, parseObjectLiteral, serializeObjectLiteral, parseAttrPaste } = require(output);
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
assert.equal(parseObjectLiteral('{ nested: { key: 1 } }'), undefined);
assert.equal(parseObjectLiteral('{ ...defaults }'), undefined);
assert.equal(parseObjectLiteral('named'), undefined);
assert.equal(parseObjectLiteral('x'.repeat(8193)), undefined);
assert.equal(parseObjectLiteral(`{ ${Array(257).fill('a: 1').join(', ')} }`), undefined);
assert.deepEqual(parseAttrPaste('x'.repeat(8193)), []);
assert.deepEqual(parseAttrPaste(Array(257).fill('x="y"').join(' ')), []);
assert.equal(serializeObjectLiteral([{ key: 'data-id', raw: '"hero"' }]), '{ "data-id": "hero" }');
assert.throws(() => serializeObjectLiteral(Array(257).fill({ key: 'a', raw: '1' })), /Object attributes: entry limit exceeded/);
assert.throws(() => serializeObjectLiteral([{ key: 'a', raw: 'x'.repeat(8192) }]), /Object attributes: output limit exceeded/);
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
        menu: undefined,
        bindContext: {},
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
  await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
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
// The Attributes list over a node that carries an app's node key: the props
// live here and every callback writes into them, as the page model would.
const internalAttributeKept = async () => {
  const key = { type: 'string', value: 'k1kkgbiyvxd6l' };
  let props = { id: { type: 'string', value: 'hero' }, 'data-stacki-key': key, title: { type: 'string', value: 'Title' } };
  const renderKeyed = () =>
    act(async () =>
      root.render(
        React.createElement(AttributesSection, {
          node: { id: 'keyed', props },
          names: Object.keys(props),
          onSetProp: (name, value) => {
            const next = { ...props };
            if (value === undefined) {
              delete next[name];
            } else {
              next[name] = value;
            }
            props = next;
          },
          onSetProps: (_nodeId, patch) => {
            props = { ...props, ...patch };
          },
          onRenameProp: (previous, next) => {
            props = Object.fromEntries(Object.entries(props).map(([name, value]) => [name === previous ? next : name, value]));
          },
        }),
      ),
    );
  const pasteKeyed = async (text) => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    const input = document.querySelector('.attr-editor input');
    assert.ok(input);
    await act(async () => input.dispatchEvent(event));
    await renderKeyed();
  };
  const rowNames = () => [...document.querySelectorAll('.attr-row .attr-name')].map((element) => element.textContent);
  await renderKeyed();
  assert.deepEqual(rowNames(), ['id', 'title'], 'the node key is not an attribute row');
  assert.doesNotMatch(document.body.textContent, /data-stacki-key|k1kkgbiyvxd6l/, 'neither its name nor its value shows');
  // Delete one attribute from its row.
  await act(async () => document.querySelectorAll('.attr-row .row-action')[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await renderKeyed();
  assert.deepEqual(Object.keys(props), ['id', 'data-stacki-key'], 'deleting another attribute keeps the key');
  // Rename and re-value the other through the editor's paste.
  await act(async () => document.querySelector('.attr-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await renderKeyed();
  await pasteKeyed('data-id="lead"');
  assert.deepEqual(props['data-stacki-key'], key, 'renaming another attribute keeps the key and its value');
  assert.deepEqual(props['data-id'], { type: 'string', value: 'lead' });
  // Several pairs pasted at once write one patch beside the key.
  await act(async () => document.querySelector('button[title="Add attribute"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await renderKeyed();
  await pasteKeyed('role="button" tabindex={0}');
  assert.deepEqual(props['data-stacki-key'], key, 'a bulk paste keeps the key and its value');
  assert.deepEqual(
    rowNames(),
    Object.keys(props).filter((name) => name !== 'data-stacki-key'),
    'the rows are every other attribute',
  );
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
  assert.ok(document.querySelector('.attr-editor') === null);
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
            // An object in the list is code the class-list editor does not draw, so it stays code here.
            'class:list': { type: 'expr', value: '["icon", { [variant]: true }]' },
            '...rest': { type: 'spread', value: 'rest' },
          },
        },
        names: ['class:list', '...rest'],
        bindContext: { frontmatter: 'const variant = "medium";' },
        onSetProp: () => {},
        onRenameProp: () => {},
      }),
    ),
  );
  await act(async () => document.querySelector('.attr-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const activeRow = document.querySelector('.attr-row');
  await act(async () => {
    activeRow.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    activeRow.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    activeRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.ok(document.querySelector('.attr-editor') === null, 'clicking the active attribute row closes its editor without reopening it');
  await act(async () => activeRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const valueField = document.querySelector('.attr-value-field');
  assert.ok(valueField);
  valueField.getBoundingClientRect = () => new dom.window.DOMRect(600, 300, 280, 40);
  await act(async () => valueField.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  assert.ok(document.querySelector('.attr-editor.var-src') === null);
  assert.ok(valueField.querySelector('.cm-lineWrapping'));
  await act(async () => document.querySelector('button[title="Expand value"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const expanded = document.querySelector('.attr-editor.var-src');
  assert.ok(expanded);
  assert.equal(expanded.style.width, '760px');
  const spreadRow = document.querySelectorAll('.attr-row')[1];
  assert.equal(spreadRow.querySelector('.attr-name').textContent, '{...rest}');
  assert.ok(spreadRow.querySelector('.attr-eq') === null);
  assert.ok(spreadRow.querySelector('.attr-value') === null);
  // A spread is code, never a name and a value: its row opens the editor on that code.
  assert.ok(spreadRow.querySelector('.attr-name code'), 'the spread is drawn as code');
  await act(async () => spreadRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const spreadEditor = document.querySelector('.attr-editor:not(.var-src)');
  assert.equal(spreadEditor.querySelector('input').value, '{...rest}', 'its Name is the spread');
  assert.doesNotMatch(spreadEditor.textContent, /Value/, 'with no value');
  assert.match(spreadEditor.textContent, /Spread: passes every property of rest/);
  await internalAttributeKept();
  await act(async () => root.unmount());
  dom.window.close();
  console.log('prop-attributes: parse bounds, single/bulk object pastes and row preservation passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
