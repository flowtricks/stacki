// Goal: navigator menus act on the right-clicked row, expose the requested controls,
// and wrap elements without losing source identity or named slots.
// Method: render the real panel in JSDOM and exercise pointer/keyboard actions;
// inspect the pure wrapping gesture and its edit requests for valid and invalid trees.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = fs.mkdtempSync(repoPath('node_modules/.stacki-test/navigator-context-'));
const element = (id, name, children = [], props = {}) => ({
  id,
  kind: 'element',
  name,
  props,
  children,
});
const component = { ...element('n1', 'Card'), kind: 'component' };

async function bundle(entry, name) {
  const outfile = path.join(directory, name);
  await esbuild.build({
    entryPoints: [repoPath(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  return require(outfile);
}

function checkWrap({ canWrapNode, wrapNodeGesture }) {
  const node = element('n0', 'section', [element('n0.0', 'span')]);
  const model = { nodes: [node], imports: [] };
  assert.equal(canWrapNode(model.nodes, 'n0', 'div'), true);
  assert.equal(canWrapNode(model.nodes, 'missing', 'div'), false);
  assert.equal(canWrapNode([element('n0', 'html')], 'n0', 'div'), false);
  const table = element('n0', 'table', [element('n0.0', 'tr')]);
  assert.equal(canWrapNode([table], 'n0.0', 'div'), false);
  const link = element('n0', 'div', [element('n0.0', 'a')]);
  assert.equal(canWrapNode([link], 'n0', 'a'), false);
  assert.throws(() => wrapNodeGesture({ nodes: [link] }, 'n0', { id: 'n2', name: 'a' }), /The node accepts this wrapper/);
  assert.throws(() => wrapNodeGesture(model, 'n0', { id: 'n0', name: 'div' }), /A wrapper has its own identity/);
  const gesture = wrapNodeGesture(model, 'n0', { id: 'n2', name: 'div' });
  const target = { id: 'n0' };
  assert.deepEqual(
    gesture.request(() => target),
    [{ tag: 'wrap-nodes', target, last: target, name: 'div' }],
  );
  assert.equal(
    gesture.request(() => undefined),
    undefined,
  );
  const next = gesture.apply(model);
  assert.equal(next.nodes[0].name, 'div');
  assert.equal(next.nodes[0].children[0].id, 'n0');
  assert.equal(model.nodes[0], node);
  assert.equal(node.name, 'section');
  const slot = { type: 'string', value: 'heading' };
  const slotted = { nodes: [{ ...component, props: { slot } }], imports: [] };
  const slottedGesture = wrapNodeGesture(slotted, 'n1', { id: 'n2', name: 'div' });
  const wrapped = slottedGesture.apply(slotted).nodes[0];
  assert.deepEqual(wrapped.props.slot, slot);
  assert.equal(wrapped.children[0].props.slot, undefined);
  assert.equal(slotted.nodes[0].props.slot, slot);
  assert.equal(slottedGesture.request(() => target)[0].tag, 'replace-node');
}

// A ::before or ::after is the selection: its element's menu takes nothing away,
// a click on the disabled items included, and copying stays. Its row has no menu.
async function checkPseudoMenu({ render, open, item, click, calls, act, dom }) {
  await render({ canDeleteNode: () => false });
  await open('n0');
  assert.equal(item('Delete').disabled, true);
  assert.equal(item('Cut').disabled, true);
  assert.equal(item('Copy').disabled, false);
  const before = calls.length;
  await click('Delete');
  await click('Cut');
  assert.deepEqual(calls.slice(before), [], 'a disabled Delete or Cut does nothing');
  await click('Copy');
  assert.deepEqual(calls.at(-1), ['copy', 'n0']);
  await render({ canDeleteNode: (id) => id !== 'n0', pseudoNodeIds: { before: new Set(['n0']), after: new Set() }, selectedPseudo: 'before' });
  await open('n1');
  assert.equal(item('Delete').disabled, false, 'another element still deletes');
  await click('Delete');
  assert.deepEqual(calls.at(-1), ['delete', 'n1']);
  await act(() => {
    document
      .querySelector('[data-pseudo-of="n0"]')
      .dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  assert.equal(document.querySelector('[role="menu"]') ?? undefined, undefined, 'a pseudo-element row has no menu');
}

async function checkMenu(StructurePanel) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.Element.prototype.getBoundingClientRect = function () {
    const width = this.classList.contains('ctx-submenu') ? 180 : 220;
    return { left: 0, top: 0, right: width, bottom: 300, width, height: 300 };
  };
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  const nodes = [
    element('n0', 'div'),
    component,
    { ...component, id: 'n2', name: 'Fragment' },
    { ...component, id: 'n3', name: 'Image', astroAsset: true },
    { ...component, id: 'layout', name: 'Layout' },
  ];
  const props = {
    pageState: { editable: true, model: { nodes, imports: [] }, source: '' },
    layouts: [],
    currentLayoutName: '',
    selectedId: 'n0',
    onSelect: (id) => calls.push(['select', id]),
    onOpenComponent: (name, id) => calls.push(['open', name, id]),
    onSetDefaults: (name, id) => calls.push(['defaults', name, id]),
    onWrapNode: (id, name) => calls.push(['wrap', id, name]),
    onCopyNode: (id) => calls.push(['copy', id]),
    onCutNode: (id) => calls.push(['copy', id], ['delete', id]),
    onRemoveNode: (id) => calls.push(['delete', id]),
    onDuplicateNode: (id) => calls.push(['duplicate', id]),
    onPasteNode: () => calls.push(['paste']),
    hasClipboard: () => true,
    onChangeLayout: () => {},
    onDropComponent: () => {},
    onMoveNode: () => {},
    onCodeChange: () => {},
    onOpenCodePanel: () => {},
  };
  const render = (overrides = {}) => act(() => root.render(React.createElement(StructurePanel, { ...props, ...overrides })));
  const item = (label) =>
    [...document.querySelectorAll('[role="menuitem"]')].find((entry) => entry.textContent === label || entry.firstElementChild?.textContent === label);
  const open = (id) =>
    act(() => {
      document.querySelector(`[data-node-id="${id}"]`).dispatchEvent(
        new dom.window.MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 1020,
          clientY: 760,
        }),
      );
    });
  const click = (label) => act(() => item(label).click());
  const key = (target, name) => act(() => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
  await render();
  await open('n1');
  assert.ok(item('Open component'));
  for (const removed of ['Edit component', 'Move to parent', 'Select parent', 'Show instances']) {
    assert.equal(item(removed), undefined);
  }
  assert.equal(item('Unlink instance'), undefined);
  assert.equal(item('Rename instance'), undefined);
  const menu = document.querySelector('[aria-label="Element actions"]');
  assert.equal(menu.style.left, '796px');
  assert.equal(menu.style.top, '460px');
  assert.equal(document.activeElement, menu, 'right-click does not preselect an action');
  await click('Open component');
  assert.deepEqual(calls.at(-1), ['open', 'Card', 'n1']);
  assert.equal(document.querySelector('[role="menu"]') ?? undefined, undefined);
  await open('n1');
  assert.equal(document.querySelector('[aria-label="Element actions"] > button:last-child').textContent, 'Set component defaults');
  await click('Set component defaults');
  assert.deepEqual(calls.at(-1), ['defaults', 'Card', 'n1']);
  await open('n1');
  await click('Cut');
  assert.deepEqual(calls.slice(-2), [
    ['copy', 'n1'],
    ['delete', 'n1'],
  ]);
  await open('n0');
  assert.equal(item('Open component'), undefined);
  await click('Wrap in');
  assert.ok(item('div'));
  await click('div');
  assert.deepEqual(calls.at(-1), ['wrap', 'n0', 'div']);
  await open('n1');
  await click('Wrap in');
  await click('<a>');
  assert.deepEqual(calls.at(-1), ['wrap', 'n1', 'a']);
  await open('n0');
  const selected = calls.filter((call) => call[0] === 'select').length;
  await key(document.activeElement, 'ArrowUp');
  assert.equal(document.activeElement, item('Delete'));
  await key(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement, item('Wrap in'));
  await key(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement, item('Cut'));
  assert.equal(calls.filter((call) => call[0] === 'select').length, selected);
  await key(document.activeElement, 'Escape');
  assert.equal(document.querySelector('[role="menu"]') ?? undefined, undefined);
  await open('n2');
  assert.equal(item('Open component'), undefined);
  await open('n3');
  assert.equal(item('Open component').disabled, true);
  await render({ clientMode: true, hasClipboard: false });
  await open('layout');
  for (const label of ['Cut', 'Copy', 'Duplicate', 'Delete', 'Wrap in', 'Paste', 'Set component defaults']) {
    assert.equal(item(label).disabled, true, label);
  }
  await key(document.activeElement, 'Escape');
  await render({ editRootId: 'n1' });
  assert.equal(document.querySelector('[data-node-id="n0"]').getAttribute('aria-disabled'), 'true');
  await open('n0');
  assert.equal(document.querySelector('[role="menu"]') ?? undefined, undefined);
  await open('n1');
  assert.equal(item('Delete').disabled, true);
  await key(document.activeElement, 'Escape');
  await checkPseudoMenu({ render, open, item, click, calls, act, dom });
  await act(() => root.unmount());
  dom.window.close();
}

(async () => {
  checkWrap(await bundle('src/editor/wrapNode.ts', 'wrap.cjs'));
  const { default: StructurePanel } = await bundle('src/features/structure/StructurePanel.tsx', 'panel.cjs');
  await checkMenu(StructurePanel);
  console.log('navigator-context-menu: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
