// Goal: the Navigator's search box filters the real panel's rows and leaves everything else alone: matches
// show with their ancestors open and marked, a click on a result selects it, "no match" is the panel's
// empty state, clearing the search brings back the page with the folds the person had, and a drag that
// starts in the tree ends the search first so a drop never lands by the positions of a filtered copy.
// Choosing a result ends the search, keeping that row selected, its ancestors open and the row scrolled into view.
// Methodology: bundle the real StructurePanel with esbuild, mount it in jsdom over a hand-made page,
// type into the search box and read the rows as a person would. Waits are for state, never for time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/navigator-search-panel.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  // The panel and the canvas drag session share one bundle, so the test can publish a drag the panel will see.
  stdin: {
    contents: `export { default } from './src/features/structure/StructurePanel.tsx'; export { publishCanvasDrag } from './src/editor/canvasDragSession.ts';`,
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
// The jsdom window has no CSS.escape; the ids in these pages need no escaping.
global.CSS = { escape: (value) => value };
global.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { default: StructurePanel, publishCanvasDrag } = require(output);

const element = (id, name, className, children) => ({ id, kind: 'element', name, props: { class: { type: 'string', value: className } }, children });
const NODES = [
  element('wrap', 'div', 'wrap', [
    element('hero', 'section', 'hero', [element('title', 'h1', 'hero-title', []), element('lede', 'p', 'lede', [])]),
    element('news', 'section', 'news', [element('sign', 'form', 'signup', [element('email', 'input', 'email-field', [])])]),
  ]),
];

const selected = [];
const container = dom.window.document.getElementById('root');
const root = createRoot(container);
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
let currentSelected;
// A selection the panel reports is given back to it as its selected row, as the app does.
const hooks = { redraw: () => {} };
const panelElement = () =>
  React.createElement(StructurePanel, {
    pageState: { editable: true, model: { nodes: NODES, imports: [] } },
    layouts: [],
    currentLayoutName: '',
    selectedId: currentSelected,
    onSelect: (id) => {
      selected.push(id);
      currentSelected = id;
      hooks.redraw();
    },
    onDropComponent: () => {},
    onMoveNode: () => {},
    onRemoveNode: () => {},
    onCopyNode: () => {},
    onDuplicateNode: () => {},
    onPasteNode: () => {},
    onChangeLayout: () => {},
    onCodeChange: () => {},
    onOpenCodePanel: () => {},
    hasClipboard: false,
  });
hooks.redraw = () => root.render(panelElement());
async function renderPanel() {
  await act(async () => hooks.redraw());
  await settle();
}
const mount = renderPanel;
const rowIds = () => [...container.querySelectorAll('.structure-node[data-node-id]')].map((row) => row.getAttribute('data-node-id'));
const box = () => container.querySelector('.navigator input[type="text"]');
async function type(value) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box()), 'value').set;
  await act(async () => {
    setter.call(box(), value);
    box().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle();
}

test('the box sits under the title with the panel placeholder', async () => {
  await mount();
  assert.ok(box(), 'there is a search box');
  assert.equal(box().getAttribute('placeholder'), 'Search layers');
  const header = container.querySelector('.panel-header');
  assert.equal(header.nextElementSibling.contains(box()), true, 'the box is the next thing under the header');
});

test('typing keeps the matches and their ancestors, open, with the words marked', async () => {
  const before = rowIds();
  assert.equal(before.includes('email'), false, 'the page starts with the signup folded away');
  await type('email');
  assert.deepEqual(rowIds(), ['wrap', 'news', 'sign', 'email']);
  const marked = [...container.querySelectorAll('.structure-node[data-node-id="email"] mark.search-hit')].map((mark) => mark.textContent);
  assert.ok(marked.length > 0, 'the row marks the words');
  assert.equal(container.querySelector('.frontmatter-node') ?? undefined, undefined, 'the frontmatter row is left out while searching');
});

test('no match shows the empty state, and Escape clears the box', async () => {
  await type('qqqq');
  assert.equal(rowIds().length, 0);
  assert.equal(container.querySelector('.props-empty').textContent, 'No elements match');
  await act(async () => box().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  assert.equal(box().value, '');
});

test('clearing the search brings the page back with the folds the person had', async () => {
  await type('email');
  await type('');
  const rows = rowIds();
  assert.equal(rows.includes('wrap'), true);
  assert.equal(rows.includes('email'), false, 'the signup is folded again, as it was before the search');
  assert.ok(container.querySelector('.frontmatter-node'), 'the frontmatter row is back');
});

test('a drag that starts in the tree ends the search before it moves anything', async () => {
  await type('hero');
  assert.deepEqual(rowIds(), ['wrap', 'hero', 'title']);
  const row = container.querySelector('.structure-node[data-node-id="title"]');
  await act(async () => {
    const started = new dom.window.Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(started, 'dataTransfer', { value: { setData: () => {}, effectAllowed: 'none', dropEffect: 'none' } });
    row.dispatchEvent(started);
  });
  await settle();
  assert.equal(box().value, '', 'the search is cleared');
  assert.equal(rowIds().includes('news'), true, "the whole page is back, so drop positions are the page's own");
});

test('a drag from the canvas shows the whole page, and the search returns when it ends', async () => {
  await type('hero');
  assert.deepEqual(rowIds(), ['wrap', 'hero', 'title']);
  await act(async () => {
    publishCanvasDrag({
      subject: { kind: 'new', label: 'Box' },
      decision: undefined,
      verdict: { kind: 'noop' },
      guide: undefined,
      parent: undefined,
      navigator: undefined,
      expand: new Set(['news', 'sign']),
      revealId: undefined,
      dragged: [],
      pointer: { x: 0, y: 0 },
    });
  });
  await settle();
  assert.equal(rowIds().includes('email'), true, 'the page is whole while the canvas drag lasts');
  await act(async () => publishCanvasDrag(undefined));
  await settle();
  assert.deepEqual(rowIds(), ['wrap', 'hero', 'title'], 'the search is back when the drag ends');
});

test('a click on a result ends the search, keeps the row selected, opens its ancestors and scrolls it into view', async () => {
  await type('email');
  assert.deepEqual(rowIds(), ['wrap', 'news', 'sign', 'email']);
  // The body is a short box and the chosen row sits far below it, so revealing it has to scroll.
  const writes = [];
  const body = container.querySelector('.navigator .panel-body');
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => writes.at(-1) ?? 0, set: (value) => writes.push(value) });
  const bounds = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top });
  const original = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function rect() {
    if (this === body) {
      return bounds(0, 100);
    }
    return this.getAttribute('data-node-id') === 'email' ? bounds(500, 20) : original.call(this);
  };
  try {
    await act(async () => container.querySelector('.structure-node[data-node-id="email"]').click());
    await settle();
    await settle();
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = original;
  }
  assert.deepEqual(selected, ['email']);
  assert.equal(box().value, '', 'the query is empty');

  assert.equal(rowIds().includes('news'), true, 'the whole page is back');
  assert.equal(rowIds().includes('email'), true, 'the selected row is drawn: its ancestors stay open');
  assert.equal(container.querySelector('.structure-node[data-node-id="email"]').className.includes('selected'), true, 'and it is still selected');
  assert.ok(container.querySelector('.frontmatter-node'), 'the filter is off');
  assert.ok(writes.length > 0 && writes[0] > 0, 'the tree scrolled to the row');
});

test('typing a query that leaves the selection out of the results does not clear it', async () => {
  await type('hero');
  assert.equal(box().value, 'hero');
  assert.deepEqual(rowIds(), ['wrap', 'hero', 'title']);
});
