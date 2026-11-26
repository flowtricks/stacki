// Goal: typing in the Content field is never undone by its own save coming back. The page hands the words back in its
// own spelling (a space the browser typed as U+00A0 written as a space, the template's indentation, a break with
// nothing after it left out); the field must keep what is typed and where the caret is, and still take a real change.
// Method: the real field drawn with React in JSDOM; each keystroke is the DOM change a browser makes and an input
// event, the parent answers with the page's spelling of the emitted nodes, as the save loop does; the DOM and the
// caret are read after every step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/content-caret-echo');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'content-caret-echo.cjs');
buildSync({
  stdin: { contents: "export { default as RichContent, sameWords } from './src/features/props/RichContent';", resolveDir: ROOT, loader: 'ts' },
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
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'NodeFilter']) {
  global[name] = dom.window[name] ?? dom.window.Event;
}
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
dom.window.document.execCommand = () => true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const modules = require(output);

// The page's spelling of what the field emitted: spaces for U+00A0, template whitespace before the words, no break at the end.
const pageSpelling = (nodes) =>
  nodes.map((node, index) => (node.kind === 'text' ? { ...node, value: `${index === 0 ? '\n          ' : ''}${node.value.replace(/ /g, ' ')}` } : node));

test('the field keeps every keystroke and the caret while its saves come back in the page spelling', async () => {
  const host = document.getElementById('root');
  const root = createRoot(host);
  let nodes = [{ kind: 'text', value: '\n          Lorem ipsum' }];
  // The parent re-renders with the page's spelling of each emission, as the save loop answers the field.
  const parent = { draw: () => {} };
  const onChange = (next) => {
    nodes = pageSpelling(next);
    parent.draw();
  };
  parent.draw = () => root.render(React.createElement(modules.RichContent, { nodes, onChange }));
  const draw = () => parent.draw();
  await act(async () => draw());
  const field = host.querySelector('.rich-content');
  field.focus();
  const typed = ['Lorem ipsum', '<br>M', '<br>Mo', '<br>More', '<br>More ', '<br>More t', '<br>More te'];
  for (const [index, tail] of typed.entries()) {
    await act(async () => {
      field.innerHTML = index === 0 ? 'Lorem ipsum' : `Lorem ipsum${tail}`;
      const last = field.lastChild;
      document.getSelection().collapse(last, last.textContent.length);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const expected = index === 0 ? 'Lorem ipsum' : `Lorem ipsum${tail}`.replace(' ', '&nbsp;');
    assert.equal(field.innerHTML, expected, `step ${index}: the words as typed`);
    const caret = document.getSelection().getRangeAt(0);
    assert.equal(caret.endContainer, field.lastChild, `step ${index}: the caret in the last words`);
    assert.equal(caret.endOffset, field.lastChild.textContent.length, `step ${index}: at their end`);
  }
  // A real change (an undo) is taken, the caret kept at its count of characters.
  await act(async () => {
    nodes = [{ kind: 'text', value: 'Lorem ipsum' }];
    draw();
  });
  assert.equal(field.innerHTML, 'Lorem ipsum');
  await act(async () => root.unmount());
});

test('spellings of the same words are the same; other words are not', () => {
  assert.equal(modules.sameWords('More&nbsp;', 'More '), true);
  assert.equal(modules.sameWords('\n   Lorem<br>More', 'Lorem<br>More'), true);
  assert.equal(modules.sameWords('Lorem<br>', 'Lorem'), true);
  assert.equal(modules.sameWords('Lorem<br><br data-rich-caret="">', 'Lorem'), true);
  assert.equal(modules.sameWords('Lorem<br>More', 'LoremMore'), false);
  assert.equal(modules.sameWords('<strong>Lorem</strong>', 'Lorem'), false);
  assert.equal(modules.sameWords('Lorem ipsum', 'Lorem'), false);
});
