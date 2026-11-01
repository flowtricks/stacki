// Mount the real panel and change node kinds in place. Hook order, settings
// retention and unmount cleanup are exercised across repeated selection changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'props-selection.cjs');
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
const { renderToStaticMarkup } = require('react-dom/server');
const { act } = React;
const { default: PropsPanel, BindField } = require(output);
const root = createRoot(document.getElementById('root'));
const noop = () => {};
const props = {
  schema: [],
  slotOptions: [],
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
const nodes = [
  undefined,
  { id: 'one', kind: 'element', name: 'h1', props: {}, children: [] },
  { id: 'text', kind: 'text', value: 'Heading' },
  { id: 'component', kind: 'component', name: 'Button', props: {}, children: [] },
  { id: 'condition', kind: 'cond', op: '&&', test: 'shown', children: [] },
  { id: 'branch', kind: 'branch', name: 'then', children: [] },
  { id: 'raw', kind: 'raw', name: 'style', props: {}, inner: '' },
  { id: 'comment', kind: 'comment', value: 'Note' },
  { id: 'expression', kind: 'expr', value: '{title}' },
  { id: 'source', kind: 'raw-line', value: '<!doctype html>' },
  { id: 'frontmatter', kind: 'frontmatter' },
  { id: 'loop', kind: 'map', head: 'items.map((item) => (', children: [] },
];
const fragment = {
  id: 'fragment',
  kind: 'component',
  name: 'Fragment',
  props: { 'set:html': { type: 'expr', value: 'content' } },
  children: [],
};
(async () => {
  for (let pass = 0; pass < 2; pass++) {
    for (const node of nodes) {
      await act(async () => root.render(React.createElement(PropsPanel, { ...props, node })));
      assert.ok(document.querySelector('.panel-section'));
    }
  }
  await act(async () => root.render(React.createElement(PropsPanel, { ...props, node: nodes[1] })));
  const toggle = document.querySelector('.props-group [aria-expanded]');
  assert.ok(toggle);
  await act(async () => toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  assert.equal(document.querySelector('.props-group [aria-expanded]').getAttribute('aria-expanded'), 'true');
  await act(async () => root.render(React.createElement(PropsPanel, { ...props, node: nodes[2] })));
  await act(async () => root.render(React.createElement(PropsPanel, { ...props, node: nodes[1] })));
  assert.equal(document.querySelector('.props-group [aria-expanded]').getAttribute('aria-expanded'), 'true');
  await act(async () => root.render(React.createElement(PropsPanel, { ...props, allowAttrs: false, node: fragment })));
  assert.equal(document.querySelector('.attr-name')?.textContent, 'set:html', 'Fragment directives appear in Attributes without a component rest prop');
  await act(async () => root.unmount());
  assert.throws(
    () =>
      renderToStaticMarkup(
        React.createElement(BindField, {
          value: { type: 'expr', value: 'x'.repeat(8193) },
          onChange: noop,
        }),
      ),
    /BindField: value limit exceeded/,
  );
  for (const [patch, message] of [
    [{ schema: Array(513).fill({ name: 'title', type: 'string' }) }, /schema limit exceeded/],
    [{ layouts: Array(10001).fill({ name: 'Layout' }) }, /layout limit exceeded/],
    [
      {
        node: {
          ...nodes[1],
          props: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`attr${index}`, { type: 'bare' }])),
        },
      },
      /attribute limit exceeded/,
    ],
    [{ node: { ...nodes[1], children: Array(20001).fill(nodes[2]) } }, /child limit exceeded/],
  ]) {
    assert.throws(() => renderToStaticMarkup(React.createElement(PropsPanel, { ...props, node: nodes[1], ...patch })), message);
  }
  dom.window.close();
  console.log('props-selection: 24 node-kind transitions, settings retention and binding bounds passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
