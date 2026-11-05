// Goal: every Settings field's purple dot follows one rule. Pressed while the
// field is not being edited, the picked chip replaces the field's whole value;
// pressed while the caret is in the field, the chip lands at the caret, or over
// the selection, and the words around it stay. The press itself must not lose
// the caret: focus is read on pointerdown, and the dot keeps focus on mousedown.
//
// Method: three fields, rendered in jsdom with React from the app's own bundle.
// An attribute's value (BindField over BindInput) is pressed both ways and the
// value it hands onSetProp is read. The Content field's rich editor
// (RichContent) gets a caret and then a selection, and its insert API is called
// as the Content field's dot calls it; the nodes it emits are read, and are
// printed by the Astro serializer so the source each case writes is checked as
// text. elementPlaceContentChip — the Content field's choice between the two —
// is checked for both focus states. The field-focus reader is checked against
// focus in the field, focus elsewhere, and focus on a non-editable control.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const { parsePage, serializePage } = require('#dist/electron/parse/astroParser.js');

const directory = repoPath('node_modules/.stacki-test/bind-handle-focus');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'bind-handle-focus.cjs');
buildSync({
  stdin: {
    contents: [
      "export { AttributesSection } from './src/features/props/propAttributes';",
      "export { default as RichContent } from './src/features/props/RichContent';",
      "export { elementPlaceContentChip } from './src/features/props/ElementFields';",
      "export { fieldFocusOf } from './src/features/props/fieldFocus';",
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
installPopupDOM(dom.window);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const modules = require(output);

const fire = (element, name) => act(async () => element.dispatchEvent(new dom.window.MouseEvent(name, { bubbles: true, cancelable: true })));
const click = (element) => fire(element, 'click');
async function pressDot(dot) {
  await fire(dot, 'pointerdown');
  await fire(dot, 'mousedown');
  await click(dot);
}
function select(node, start, end) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new dom.window.Event('selectionchange'));
}
const rowNamed = (name) => [...document.querySelectorAll('.bind-menu .dp-row')].find((row) => row.querySelector('.dp-key')?.textContent === name);

const FRONTMATTER = 'const { title = "Hello" } = Astro.props;';

async function renderAttribute() {
  const node = { id: 'n0', kind: 'element', name: 'a', props: { 'data-label': { type: 'string', value: 'Click me' } }, children: [] };
  const writes = [];
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.AttributesSection, {
        node,
        names: ['data-label'],
        bindContext: { frontmatter: FRONTMATTER, propsSchema: [{ name: 'title', type: 'string' }] },
        tag: 'a',
        onSetProp: (name, value) => writes.push({ name, value }),
        onRenameProp() {},
      }),
    ),
  );
  await click(container.querySelector('.attr-row'));
  return { root, writes, field: container.querySelector('.attr-value-field .bind-input'), dot: container.querySelector('.attr-value-field .bind-handle') };
}

test('an attribute pressed from outside: the chip is the whole value', async () => {
  const { root, writes, dot } = await renderAttribute();
  await pressDot(dot);
  await click(rowNamed('title'));
  assert.deepEqual(writes.at(-1), { name: 'data-label', value: { type: 'expr', value: 'title' } });
  await act(async () => root.unmount());
});

test('an attribute pressed while typing: the chip lands at the caret, and over a selection', async () => {
  for (const [range, expected] of [
    [[5, 5], 'Click{title} me'],
    [[0, 5], '{title} me'],
  ]) {
    const { root, writes, field, dot } = await renderAttribute();
    field.focus();
    select(field.firstChild, range[0], range[1]);
    await fire(field, 'mouseup');
    assert.equal(document.activeElement, field);
    await pressDot(dot);
    await click(rowNamed('title'));
    const last = writes.at(-1);
    assert.equal(last.name, 'data-label');
    assert.equal(`${last.value.type}:${last.value.value}`, `expr:\`${expected.replace('{title}', '${title}')}\``, `caret ${range.join('–')}`);
    await act(async () => root.unmount());
  }
});

test('the Content field: a caret insert, a selection replaced, and the source each writes', async () => {
  const page = parsePage('<p>Some text</p>\n');
  for (const [range, expected] of [
    [[5, 5], '<p>Some {title}text</p>\n'],
    [[0, 4], '<p>{title} text</p>\n'],
  ]) {
    const insertRef = { current: undefined };
    let emitted;
    const container = document.getElementById('root');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        React.createElement(modules.RichContent, {
          nodes: page.model.nodes[0].children,
          insertRef,
          onChange: (nodes) => {
            emitted = nodes;
          },
        }),
      ),
    );
    const host = container.querySelector('[contenteditable]');
    host.focus();
    select(host.firstChild, range[0], range[1]);
    const state = { contentInsertRef: insertRef, onSetInline: () => assert.fail('a focused field inserts, it does not replace') };
    await act(async () => modules.elementPlaceContentChip(state, { kind: 'focused', textRange: undefined }, 'title'));
    const model = { ...page.model, nodes: [{ ...page.model.nodes[0], children: emitted.map((node, index) => ({ ...node, id: `x${index}` })) }] };
    Reflect.deleteProperty(model.nodes[0], 'source');
    assert.equal(serializePage(model), expected, `range ${range.join('–')}`);
    await act(async () => root.unmount());
  }
});

test('the Content field pressed from outside: the chip, with its braces, is the whole content', () => {
  let written;
  const state = {
    contentInsertRef: { current: { insert: () => assert.fail('an unfocused field is replaced, not inserted into') } },
    onSetInline: (nodes) => {
      written = nodes;
    },
  };
  modules.elementPlaceContentChip(state, { kind: 'unfocused' }, 'title');
  assert.deepEqual(written, [{ kind: 'expr', value: '{title}' }]);
  const model = parsePage('<p>Some text</p>\n').model;
  const restated = { ...model, nodes: [{ ...model.nodes[0], children: [{ id: 'x', ...written[0] }] }] };
  Reflect.deleteProperty(restated.nodes[0], 'source');
  assert.equal(serializePage(restated), '<p>{title}</p>\n', 'a node expression is written with its braces, not as the word');
  assert.throws(() => modules.elementPlaceContentChip(state, { kind: 'unfocused' }, ''), /Assertion failed: A picked chip names a value/);
});

test('reading focus: the field, elsewhere, and a control that holds no caret', () => {
  const container = document.getElementById('root');
  container.innerHTML = '<div class="props-field"><textarea>abc</textarea><button>x</button></div><input id="other" />';
  const field = container.querySelector('.props-field');
  const textarea = field.querySelector('textarea');
  textarea.focus();
  textarea.setSelectionRange(1, 2);
  assert.deepEqual(modules.fieldFocusOf(field, document.activeElement), { kind: 'focused', textRange: { start: 1, end: 2 } });
  container.querySelector('#other').focus();
  assert.deepEqual(modules.fieldFocusOf(field, document.activeElement), { kind: 'unfocused' }, 'focus in another field is not this one’s');
  field.querySelector('button').focus();
  assert.deepEqual(modules.fieldFocusOf(field, document.activeElement), { kind: 'unfocused' }, 'a button is not a caret');
  assert.deepEqual(modules.fieldFocusOf(undefined, document.activeElement), { kind: 'unfocused' });
  container.innerHTML = '';
});
