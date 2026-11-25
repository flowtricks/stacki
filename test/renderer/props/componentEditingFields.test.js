// Goal: the Properties panel's two editing switches and the rich text Content field behave as specified: rich text
// is offered only where the component qualifies, a switch reports the change it asks for, rich content opens the
// editor in a dialog from a button, and content the editor cannot give back shows as code with the toggle locked.
//   node test/renderer/props/componentEditingFields.test.js
// Method: bundle the real components with esbuild, draw them with React in JSDOM, click them, and read the DOM and
// the calls they make. No project is read.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/component-editing-fields');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'component-editing-fields.cjs');
buildSync({
  stdin: { contents: "export * from './src/features/props/ComponentEditingFields';", resolveDir: ROOT, loader: 'ts' },
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
dom.window.document.execCommand = () => true;
installPopupDOM(dom.window);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const modules = require(output);

let root;
async function draw(element) {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
}
async function clear() {
  await act(async () => root.unmount());
  document.body.querySelectorAll('dialog, .popup').forEach((node) => node.remove());
}
const click = async (element) => {
  await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
};

test('both switches show for a component that takes HTML children, and report what they ask for', async () => {
  const changes = [];
  await draw(
    React.createElement(modules.ComponentEditingSwitches, {
      control: { settings: { richText: true }, richTextAllowed: true, onChange: (setting, value) => changes.push([setting, value]) },
    }),
  );
  const switches = [...document.querySelectorAll('[role="switch"]')];
  assert.deepEqual(
    switches.map((element) => [element.getAttribute('aria-label'), element.getAttribute('aria-checked')]),
    [
      ['Allow line breaks', 'false'],
      ['Allow rich text editing', 'true'],
    ],
  );
  await click(switches[0]);
  await click(switches[1]);
  assert.deepEqual(changes, [
    ['lineBreaks', 'on'],
    ['richText', 'off'],
  ]);
  await clear();
});

test('rich text is not offered for a component that cannot take HTML children', async () => {
  await draw(React.createElement(modules.ComponentEditingSwitches, { control: { settings: { richText: true }, richTextAllowed: false, onChange: () => {} } }));
  assert.deepEqual(
    [...document.querySelectorAll('[role="switch"]')].map((element) => element.getAttribute('aria-label')),
    ['Allow line breaks'],
  );
  await clear();
});

test('plain rich text is edited from a button that opens the editor in a dialog', async () => {
  const written = [];
  await draw(
    React.createElement(modules.RichTextContentField, {
      label: 'Content',
      source: '<p>Hello <strong>you</strong></p>',
      onSetNodes: (nodes) => written.push(nodes),
      onSetSource: () => {},
    }),
  );
  const toggle = document.querySelector('.prop-expr-toggle');
  assert.equal(toggle.getAttribute('aria-disabled'), 'false');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  const button = document.querySelector('.props-rich-text-edit');
  assert.equal(button.textContent, 'Edit rich text');
  await click(button);
  const editor = document.querySelector('.html-field.html-field-blocks .html-content');
  assert.ok(editor, 'the rich text editor opened with its block menu');
  assert.equal(editor.innerHTML, '<p>Hello <strong>you</strong></p>', 'opening writes nothing and shows the content as it is');
  assert.deepEqual(written, []);
  await clear();
});

test('content the editor cannot give back shows as code, and the toggle cannot leave code', async () => {
  for (const source of ['<Card title="x" />', '<p>{title}</p>', '<!-- note --><p>a</p>']) {
    await draw(React.createElement(modules.RichTextContentField, { label: 'Content', source, onSetNodes: () => {}, onSetSource: () => {} }));
    assert.equal(document.querySelector('.props-rich-text-edit') ?? undefined, undefined, source);
    assert.ok(document.querySelector('.props-rich-text-code'), source);
    const toggle = document.querySelector('.prop-expr-toggle');
    assert.equal(toggle.getAttribute('aria-disabled'), 'true');
    await click(toggle);
    assert.ok(document.querySelector('.props-rich-text-code'), 'still code');
    await clear();
  }
});

test('whitespace between blocks is the same rich content; a changed word is not', () => {
  assert.equal(modules.sameRichContent('<p>a</p>\n  <p>b</p>', '<p>a</p><p>b</p>', document), true);
  assert.equal(modules.sameRichContent('<p>a</p>', '<p>b</p>', document), false);
});
