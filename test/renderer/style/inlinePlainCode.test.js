// A plain string `style` attribute in the CSS code section: picking the "Inline
// styles" chip shows only `element.style { … }` with that element's declarations,
// editable, written back as the attribute; deselecting returns to the rules.
//
//   node test/renderer/style/inlinePlainCode.test.js
//
// Goal: the release bug this pins showed the class rules in the CSS code section with
// the chip picked, because only an expression gave the section anything to show.
//
// Method: the panel's own hooks (useInlineState, useInlineCard) run in jsdom over a
// host holding one element with `style="min-height: calc(100svh - var(--nav-height));"`;
// the card they produce is read before and after the chip is picked, its CSS code view
// is committed as the editor commits it, and the host write is recorded. The commit
// rules themselves (plainStyleCommit) are checked on their own for the edge cases.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
global.window = dom.window;
for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'localStorage']) {
  global[key] = dom.window[key];
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'inline-plain-code.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { useInlineState, useInlineCard } from './src/features/style/embed/useInlineTarget';",
      "export { plainStyleCommit } from './src/features/style/model/inlineTarget';",
      "export { setHost, getHost } from './src/features/style/model/host';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const model = require(bundle);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

const STYLE = 'min-height: calc(100svh - var(--nav-height));';
const writes = [];
model.setHost({
  ...model.getHost(),
  projectPath: '/p',
  nodes: [{ id: 'n1', kind: 'element', name: 'section', props: { class: { type: 'string', value: 'section' }, style: { type: 'string', value: STYLE } } }],
  selectedId: 'n1',
  setInlineStyle: (nodeId, style) => writes.push([nodeId, style]),
});

const noop = () => undefined;
let cssCodeOpen = false;
const baseCard = () => ({
  snapshot: undefined,
  cssCodeOpen,
  onToggleCssCode: () => {
    cssCodeOpen = !cssCodeOpen;
  },
  sourceNote: undefined,
  onSelectActive: noop,
  onDeselect: noop,
  onAddSelector: noop,
  onSelectSelector: noop,
  setProp: noop,
  clearProp: noop,
  liveSetProp: noop,
  onAdd: noop,
});

let card;
function Probe() {
  const inline = model.useInlineState();
  card = model.useInlineCard(baseCard(), inline, { deselect: noop, setSaveError: noop });
  return undefined;
}

test('a picked plain-string chip shows its declarations in the CSS code section, editable', async () => {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Probe)));
  assert.ok(card.inline !== undefined, 'the chip is in the well');
  assert.equal(card.inline.state, 'editable');
  assert.equal(card.inlineCode, undefined, 'not picked: the section shows the rules');

  await act(async () => card.inline.onSelect());
  assert.equal(card.inline.active, true);
  assert.equal(cssCodeOpen, true, 'the section opens with the pick');
  assert.equal(card.inlineCode?.kind, 'branches');
  assert.equal(card.inlineCode.view.selected.body, STYLE, 'the element’s own declarations, as written');
  assert.equal(card.inlineCode.view.writesTo, undefined);
  assert.equal(card.sourceNote, undefined, 'no note');

  // A commit is the attribute's next text: the edited list, every other byte kept.
  const edited = 'min-height: calc(100svh - var(--nav-height)); gap: 1rem;';
  await act(async () => card.inlineCode.view.onCommit(edited));
  assert.deepEqual(writes, [['n1', { type: 'string', value: edited }]], 'one write through the inline-style path');
  await act(async () => card.inlineCode.view.onCommit('  '));
  assert.deepEqual(writes[1], ['n1', undefined], 'emptied: the attribute goes');

  // Leaving the chip returns the section to the rules.
  await act(async () => card.inline.onDeselect());
  assert.equal(card.inlineCode, undefined);
  await act(async () => root.unmount());
});

test('a plain commit keeps the text as typed and refuses what does not read back', () => {
  assert.deepEqual(model.plainStyleCommit('color:red;  /* x */ margin : 0'), { tag: 'write', next: 'color:red;  /* x */ margin : 0' });
  assert.deepEqual(model.plainStyleCommit(''), { tag: 'write', next: undefined });
  assert.equal(model.plainStyleCommit('color red').tag, 'refused');
  assert.equal(model.plainStyleCommit('background: url(a').tag, 'refused');
});
