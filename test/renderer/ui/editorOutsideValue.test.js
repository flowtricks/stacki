// Goal: a code field never reports a value it was handed as an edit. ExprInput (every prop,
// class and binding expression field) and StyleEditor (a style attribute's declarations) stay
// mounted while the selection moves, and take the next element's value from their props. They
// used to hear that value arriving as typing and call onChange with it, so selecting a second
// element whose class is an expression wrote its own class back to the page: a write made by
// looking, which rewrote the file, re-rendered the canvas twice and cost an undo step.
//
// Method: the real components, bundled as the app bundles them, render in jsdom. Each is given a
// value, then the next element's value through the same props a selection change passes, and the
// onChange calls are counted; then a change typed into the editor (a CodeMirror transaction, as a
// keystroke makes) must still reach onChange, so the fix silences only values from outside.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/editor-outside-value');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'editor-outside-value.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as ExprInput } from './src/ui/ExprInput';",
      "export { default as StyleEditor } from './src/features/props/StyleEditor';",
      "export { EditorView } from '@codemirror/view';",
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

let React;
let act;
let createRoot;
let modules;
function installDom() {
  if (modules !== undefined) {
    return;
  }
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent']) {
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
  // CodeMirror measures text; jsdom lays nothing out.
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = React);
  modules = require(output);
}

async function mount(context) {
  installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  context.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const view = () => {
    const editor = host.querySelector('.cm-editor');
    assert.ok(editor !== null, 'the editor is mounted');
    const found = modules.EditorView.findFromDOM(editor);
    assert.ok(found !== null, 'the editor has a view');
    return found;
  };
  return { root, view };
}

test('ExprInput: the next element’s value arriving is not an edit; typing still is', async (context) => {
  const { root, view } = await mount(context);
  const changes = [];
  // The props propBindings passes for a class expression: value and syncValue both the element's.
  const field = (value) =>
    React.createElement(modules.ExprInput, { value, syncValue: value, chipsOf: () => [], onChange: (text) => changes.push(text), onCommit: () => {} });
  await act(async () => root.render(field('expressionClasses("one")')));
  assert.equal(view().state.doc.toString(), 'expressionClasses("one")');
  await act(async () => root.render(field('expressionClasses("two")')));
  assert.equal(view().state.doc.toString(), 'expressionClasses("two")', 'the field shows the element now selected');
  assert.deepEqual(changes, [], 'selecting the next element sends no edit');
  await act(async () => root.render(field('expressionClasses("one")')));
  assert.deepEqual(changes, [], 'nor does going back');
  await act(async () => view().dispatch({ changes: { from: view().state.doc.length, insert: ' + ""' } }));
  assert.deepEqual(changes, ['expressionClasses("one") + ""'], 'a typed change reaches onChange');
});

test('StyleEditor: the next element’s declarations arriving are not an edit; typing still is', async (context) => {
  const { root, view } = await mount(context);
  const changes = [];
  const field = (value) => React.createElement(modules.StyleEditor, { value, onChange: (text) => changes.push(text) });
  await act(async () => root.render(field('color: red;')));
  await act(async () => root.render(field('color: blue;')));
  assert.match(view().state.doc.toString(), /color: blue/, 'the editor shows the element now selected');
  assert.deepEqual(changes, [], 'selecting the next element sends no edit');
  await act(async () => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: 'color: green;' } }));
  assert.equal(changes.length, 1, 'a typed change reaches onChange');
  assert.match(changes[0], /color: green/);
});
