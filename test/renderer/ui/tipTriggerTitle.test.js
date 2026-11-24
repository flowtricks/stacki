// Goal: the app's own tip triggers never show the browser's native tooltip as well, even inside an element that carries a
// `title`. Chromium titles every descendant of a titled element, so an (i) mark inside a titled row label drew the native box
// over the app's tip (the Audits settings rows). Each trigger blanks the inherited title with `title=""` and keeps its
// accessible name and description on aria attributes, so a screen reader hears the same thing as before.
// Method: bundle the real InfoHint, TipAnchor and Tooltip with esbuild, mount each in jsdom inside `<span title="...">`, and
// check the trigger's own title is empty (which stops inheritance), that it has no non-empty title anywhere between it and
// the titled ancestor, and that its accessible name and description are still present and point at the explanation.
const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/tip-trigger-title');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'tips.cjs');
buildSync({
  stdin: {
    contents:
      "export { default as InfoHint } from './src/ui/InfoHint'; export { default as TipAnchor } from './src/ui/TipAnchor'; export { default as Tooltip } from './src/ui/Tooltip';",
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
});

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { InfoHint, TipAnchor, Tooltip } = require(bundle);

const mounted = [];
afterEach(async () => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop();
    await act(async () => root.unmount());
    container.remove();
  }
  dom.window.document.body.innerHTML = '';
});

const ROW_TITLE = 'Unlabelled icon button';
const WHY = 'The icon is drawn, not read: without a label the control has no name.';

async function mountInTitledRow(child) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(React.createElement('span', { id: 'row', title: ROW_TITLE }, ROW_TITLE, child)));
  return dom.window.document.getElementById('row');
}

// The title the browser would show for `element`: its own, or the nearest ancestor's (HTML's inherited advisory text).
function effectiveTitle(element) {
  for (let node = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute('title')) {
      return node.getAttribute('title') ?? undefined;
    }
  }
  return undefined;
}

test('InfoHint: the (i) button blanks the row title and keeps its name and description', async () => {
  const row = await mountInTitledRow(React.createElement(InfoHint, { text: WHY }));
  const button = row.querySelector('button.settings-info');
  assert.ok(button, 'the (i) button renders');
  assert.equal(button.getAttribute('title'), '', 'an empty title stops the row title from reaching the button');
  assert.equal(effectiveTitle(button), '');
  assert.equal(effectiveTitle(row), ROW_TITLE, 'the row text keeps its own title');
  const name = button.getAttribute('aria-label');
  assert.ok(name !== null && name.length > 0, 'the button still has an accessible name');
  const description = dom.window.document.getElementById(button.getAttribute('aria-describedby'));
  assert.ok(description, 'the description element exists');
  assert.equal(description.textContent, WHY);
});

test('TipAnchor: the wrapper blanks an outer title only while it has an explanation', async () => {
  const row = await mountInTitledRow(React.createElement(TipAnchor, { text: WHY }, React.createElement('button', { id: 'save' }, 'Save')));
  const save = dom.window.document.getElementById('save');
  assert.equal(effectiveTitle(save), '', 'the outer title does not reach the wrapped control');
  const wrapper = row.querySelector('.tip-anchor');
  assert.equal(dom.window.document.getElementById(wrapper.getAttribute('aria-describedby')).textContent, WHY);
  await act(async () => mounted[0].root.render(React.createElement('span', { title: ROW_TITLE }, React.createElement(TipAnchor, { text: undefined }, 'x'))));
  assert.equal(dom.window.document.querySelector('.tip-anchor').hasAttribute('title'), false, 'no explanation, no blank: the outer title applies');
});

test('Tooltip: the trigger text blanks an outer title', async () => {
  const row = await mountInTitledRow(React.createElement(Tooltip, { text: 'Hover me', className: 'tip-trigger' }));
  const trigger = row.querySelector('.tip-trigger');
  assert.ok(trigger, 'the trigger renders');
  assert.equal(effectiveTitle(trigger), '');
  assert.equal(trigger.textContent, 'Hover me');
});
