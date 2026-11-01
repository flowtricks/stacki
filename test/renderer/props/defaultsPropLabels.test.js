// Exercise real prop controls with both value policies. Explicit fallback choices in
// defaults recipes stay blue; reset reveals the fallback and instances still omit it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { parsePropSchema } = require('#dist/electron/parse/astroParser.js');
const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'defaults-prop-labels.cjs');
buildSync({
  entryPoints: [repoPath('src/features/props/PropsPanel.tsx')],
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
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const { default: PropsPanel } = require(output);
require('../../helpers/popupDom.js').installPopupDOM(dom.window);
const root = createRoot(document.getElementById('root'));
const noop = () => {};
const props = {
  schema: [],
  slotOptions: [],
  takesSlotText: true,
  tagOptions: [],
  projectClasses: [],
  layouts: [],
  bindContext: {},
  allowAttrs: true,
  onSetProp: noop,
  onSetProps: noop,
  onRenameProp: noop,
  onSetText: noop,
  onSetContent: noop,
  onSetInline: noop,
  onOpenCode: noop,
  onSetComment: noop,
};

let values = {};
let policy = 'defaults';
let children = [{ kind: 'text', id: 'n0.0', value: 'Project text default' }];
const schema = [
  { name: 'render', type: 'boolean', default: true },
  { name: 'size', type: 'enum', default: 'small', options: ['small', 'large'] },
  { name: 'tag', type: 'enum', default: 'h2', options: ['h1', 'h2', 'h3'] },
  ...parsePropSchema(
    [
      '---',
      'interface Props {',
      '  /** Defaults to `website`; use `article` for posts and news pages. */',
      '  type?: "website" | "article" | "profile";',
      '}',
      'const { type } = Astro.props;',
      '---',
    ].join('\n'),
  ).values(),
  { name: 'loading', type: 'enum', options: ['auto', 'eager', 'lazy'] },
];
function renderPanel() {
  root.render(
    React.createElement(PropsPanel, {
      ...props,
      schema,
      valuePolicy: policy,
      node: {
        id: 'n0',
        kind: 'component',
        name: 'Heading',
        props: values,
        children,
      },
      onSetProp: change,
      onSetProps: changeAll,
      onSetInline: changeChildren,
    }),
  );
}
function changeChildren(next) {
  children = next;
  renderPanel();
}
function changeAll(_id, next) {
  values = next;
  renderPanel();
}
function change(name, value) {
  values = { ...values, [name]: value };
  renderPanel();
}
function label(name) {
  return [...document.querySelectorAll('.prop-label')].find((item) => item.textContent === name);
}
function field(name) {
  return label(name).closest('.props-field');
}
function pickSegment(name, text) {
  act(() => [...field(name).querySelectorAll('button')].find((button) => button.textContent === text).click());
}
function reset(name) {
  act(() =>
    label(name).dispatchEvent(
      new dom.window.MouseEvent('click', {
        bubbles: true,
        altKey: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(values[name], undefined);
  assert.equal(label(name).classList.contains('set'), false);
}
async function checkDropdown() {
  await act(async () => field('tag').querySelector('.dd-trigger').click());
  const option = [...document.querySelectorAll('.dd-option')].find((item) => item.textContent === 'h2');
  assert.ok(option);
  await act(async () => option.click());
  assert.deepEqual(values.tag, { type: 'string', value: 'h2' });
  assert.ok(label('tag').classList.contains('set'));
  reset('tag');
  assert.equal(field('tag').querySelector('.dd-label').textContent, 'h2');
  assert.ok(field('tag').querySelector('.dd-label').classList.contains('dim'));
}
(async () => {
  act(renderPanel);
  assert.ok(label('Content').classList.contains('set'));
  assert.equal(field('render').querySelector('[aria-pressed="true"]').textContent, 'True');
  assert.equal(field('tag').querySelector('.dd-label').textContent, 'h2');
  assert.equal(field('type').querySelector('.dd-label').textContent, 'website');
  assert.equal(field('loading').querySelector('.dd-label').textContent, '(not set)');
  assert.equal(field('size').querySelector('[aria-pressed="true"]').textContent, 'small');
  assert.equal(label('type').classList.contains('set'), false);
  assert.deepEqual(values, {});
  assert.equal(label('render').classList.contains('set'), false);
  pickSegment('render', 'True');
  assert.deepEqual(values.render, { type: 'expr', value: 'true' });
  assert.ok(label('render').classList.contains('set'));
  assert.equal(field('render').querySelector('.bool-seg').classList.contains('is-unset'), false);
  reset('render');
  pickSegment('render', 'False');
  assert.equal(field('render').querySelector('[aria-pressed="true"]').textContent, 'False');
  assert.ok(label('render').classList.contains('set'));
  reset('render');
  pickSegment('size', 'small');
  assert.deepEqual(values.size, { type: 'string', value: 'small' });
  assert.ok(label('size').classList.contains('set'));
  reset('size');
  await checkDropdown();
  policy = 'instance';
  act(renderPanel);
  assert.equal(field('type').querySelector('.dd-label').textContent, 'website');
  pickSegment('render', 'True');
  pickSegment('size', 'small');
  assert.equal(values.render, undefined);
  assert.equal(values.size, undefined);
  assert.equal(label('render').classList.contains('set'), false);
  assert.equal(label('size').classList.contains('set'), false);
  assert.ok(label('Content').classList.contains('set'));
  await act(async () => label('Content').click());
  await act(async () => document.querySelector('.prop-menu-item').click());
  assert.deepEqual(children, []);
  assert.equal(label('Content').classList.contains('set'), false);
  assert.equal(document.querySelector('.prop-menu') ?? undefined, undefined);
  act(() => root.unmount());
  dom.window.close();
  console.log('Defaults prop labels: explicit fallbacks, reset and instance policy passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
