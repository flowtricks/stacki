// Goal: a prop whose value is code in its own right (`sizes`) shows its value
// in colour, and the field still behaves as the plain one did: the text is the
// value, typing writes it, a pasted line break folds to a space, the chip a
// data pick adds is drawn as a chip, the placeholder shows when empty, and a
// sentence-valued prop (`title`) keeps the plain field with no colour.
// Method: BindField and TextControl's field, bundled as the app bundles them
// and rendered in jsdom with React. Colour is read from the spans the code
// editor wraps tokens in; typing and pasting go through the editor's own DOM
// events; the value written is read from onChange.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/code-attribute-field');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'code-attribute-field.cjs');
buildSync({
  stdin: {
    contents: ["export { BindField } from './src/features/props/propBindings';", "export { EditorView } from '@codemirror/view';"].join('\n'),
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
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent']) {
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
// CodeMirror measures text ranges, which jsdom has no layout for.
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
installPopupDOM(dom.window);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const modules = require(output);

const SIZES = '(min-width: 992px) 33vw, (min-width: 768px) 50vw, 100vw';

async function render(name, value) {
  const writes = [];
  const container = document.getElementById('root');
  container.replaceChildren();
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.BindField, {
        field: { name, type: 'string' },
        value: { type: 'string', value },
        placeholder: 'Type a value',
        onChange: (next) => writes.push(next),
      }),
    ),
  );
  return { root, writes, container };
}

test('sizes shows its value in coloured tokens, as the text it is', async () => {
  const { root, container } = await render('sizes', SIZES);
  const content = container.querySelector('.cm-content');
  assert.ok(content, 'the code editor holds the value');
  assert.equal(container.querySelector('.bind-input') ?? undefined, undefined);
  assert.equal(content.textContent, SIZES, 'the editor holds exactly the value');
  const tokens = [...content.querySelectorAll('.cm-line span')].filter((span) => span.className !== '');
  assert.ok(tokens.length >= 6, `coloured spans: ${tokens.length}`);
  assert.ok(
    tokens.some((span) => span.textContent === '992px'),
    'a length is a token of its own',
  );
  assert.ok(
    tokens.some((span) => span.textContent === 'min-width'),
    'a feature is a token of its own',
  );
  await act(async () => root.unmount());
});

test('a sentence-valued prop keeps the plain field', async () => {
  const { root, container } = await render('title', 'Click me');
  assert.ok(container.querySelector('.bind-input'));
  assert.equal(container.querySelector('.cm-content') ?? undefined, undefined);
  await act(async () => root.unmount());
});

const viewOf = (container) => modules.EditorView.findFromDOM(container.querySelector('.cm-editor'));

test('typing writes the value and an empty field shows its placeholder', async () => {
  const { root, writes, container } = await render('sizes', '');
  assert.equal(container.querySelector('.cm-placeholder')?.textContent, 'Type a value');
  const view = viewOf(container);
  await act(async () => view.dispatch({ changes: { from: 0, insert: '100vw' }, userEvent: 'input.type' }));
  assert.deepEqual(writes.at(-1), { type: 'string', value: '100vw' });
  assert.equal(view.state.doc.toString(), '100vw');
  await act(async () => view.dispatch({ changes: { from: 5, insert: ', 50vw' }, userEvent: 'input.type' }));
  assert.deepEqual(writes.at(-1), { type: 'string', value: '100vw, 50vw' });
  await root.unmount();
});

test('a pasted line break folds to one space, and a data hole is drawn as a chip', async () => {
  const { root, writes, container } = await render('sizes', '');
  const view = viewOf(container);
  const paste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '(min-width: 1px)\n  50vw' } });
  await act(async () => {
    view.contentDOM.dispatchEvent(paste);
  });
  assert.equal(paste.defaultPrevented, true);
  assert.deepEqual(writes.at(-1), { type: 'string', value: '(min-width: 1px) 50vw' });
  await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '${width}' }, userEvent: 'input.type' }));
  assert.ok(container.querySelector('.cm-content .expr-chip'), 'the hole is a chip');
  assert.deepEqual(writes.at(-1), { type: 'expr', value: '`(min-width: 1px) 50vw${width}`' });
  await act(async () => root.unmount());
});
