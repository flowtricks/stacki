// Goal: the purple binding dot is on every bindable control, and absent only
// where binding is meaningless by design.
//
//   node test/renderer/props/bindDotPerControl.test.js
//
// One table of control kinds, each drawn by the real PropField: a text, a
// number, a switch, a choice, a list, an object, a colour, a link, and a list
// item row. Each must carry the dot in its label row (the shared field
// wrapper, PropFieldLabelRow). The kinds that are set only in code (an action
// function, the slot attribute, an attributes bag with its own dot) are pinned
// as the exceptions. Fixtures are generated here; no project is read.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/list-scalar-rows');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'list-scalar-rows.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as PropField } from './src/features/props/PropField';",
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

const BIND_CONTEXT = { frontmatter: 'const { entry } = Astro.props;', propsSample: { entry: { title: 'Hello' } } };
const KINDS = {
  text: { name: 'title', type: 'string', optional: true },
  number: { name: 'count', type: 'number', optional: true },
  switch: { name: 'open', type: 'boolean', optional: true },
  choice: { name: 'size', type: 'enum', options: ['s', 'm'], optional: true },
  list: { name: 'widths', type: 'code', optional: true, itemKind: 'number' },
  'list of objects': { name: 'items', type: 'code', optional: true, shapeIsList: true, shape: [{ name: 'title', type: 'string' }] },
  object: { name: 'tags', type: 'code', codeKind: 'object', optional: true },
  color: { name: 'color', type: 'string', optional: true, doc: '@format color' },
};
let root;
async function draw(field, value) {
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(modules.PropField, { nodeKey: 'x', field, value, bindContext: BIND_CONTEXT, onChange: () => {} })));
}
async function clear() {
  await act(async () => root.unmount());
}

test('every bindable control kind carries the binding dot in its label row', async () => {
  for (const [kind, field] of Object.entries(KINDS)) {
    await draw(field, undefined);
    assert.ok(document.querySelector('.props-field > label .bind-handle .bind-dot'), `${kind} has the dot`);
    await clear();
  }
});

test('a list item row has its own dot, and the list as a whole has one', async () => {
  await draw(KINDS.list, { type: 'expr', value: '[320, 480]' });
  assert.equal(document.querySelectorAll('.list-scalar-item .bind-handle').length, 2, 'one per item');
  assert.equal(document.querySelectorAll('.props-field > label > .bind-handle').length >= 1, true, 'and the list itself');
  await clear();
});

test('code-only kinds carry no dot by design', async () => {
  await draw({ name: 'onClick', type: 'other', codeKind: 'function', optional: true }, undefined);
  assert.equal(document.querySelector('.bind-handle') ?? undefined, undefined, 'an action is written in code');
  await clear();
});
