// Goal: dragging over the Navigator never offers a drop that would break the page. A place the
// placement rule refuses shows no drop indicator, gets the not-allowed effect, and says why (except
// over the dragged row itself, where it says nothing); a
// place it refuses but a valid neighbour exists for (a doctype over a component) shows the
// indicator at that neighbour and the drop lands there; a valid place behaves as it always did;
// and a drop on a refused place reaches no handler, so nothing is written. The words about a drag are never
// appended to the tree or the panel: they float as a fixed tooltip on the body, and a drop that was redirected
// to the nearest valid place says so in a toast.
// Method: mount the real StructurePanel in jsdom over a generated tree, start a drag on a row
// (dragstart records the drag the way a person's does), fire dragover and drop on the gaps and
// rows, and read the indicator, the cancelled-or-not state of the event, the drop effect, the
// note, and the handler calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

const element = (id, name, children = []) => ({ id, kind: 'element', name, props: {}, children });
const nodes = [
  { id: 'doctype', kind: 'raw-line', value: '<!doctype html>' },
  {
    id: 'layout',
    kind: 'component',
    name: 'Layout',
    props: {},
    children: [element('main', 'main', [element('p', 'p'), element('list', 'ul', [element('item', 'li')]), element('after', 'section')])],
  },
];

async function mount() {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'structure-placement.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/structure/StructurePanel.tsx')],
    outfile: bundlePath,
    inject: [repoPath('test/helpers/toastCaptureEntry.js')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
  })) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const StructurePanel = require(bundlePath).default;
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  const moved = [];
  const dropped = [];
  await act(async () => {
    root.render(
      React.createElement(StructurePanel, {
        pageState: { editable: true, model: { nodes, imports: [] } },
        currentPage: { kind: 'page', path: '/project/src/pages/index.astro' },
        layouts: [],
        insertables: [],
        currentLayoutName: '',
        selectedId: undefined,
        onSelect: () => {},
        onDropComponent: (name, target) => dropped.push({ name, ...target }),
        onMoveNode: (id, target) => moved.push({ id, ...target }),
        onRemoveNode: () => {},
        onCopyNode: () => {},
        onDuplicateNode: () => {},
        onPasteNode: () => {},
        onChangeLayout: () => {},
        onCodeChange: () => {},
        onOpenCodePanel: () => {},
        hasClipboard: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => {
    container.querySelector('.panel-header button').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const transfer = { effectAllowed: '', dropEffect: '', types: ['avb/node'], setData() {}, getData: () => '' };
  const fire = async (target, type) => {
    const event = Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { dataTransfer: transfer, clientY: 0 });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  };
  const gap = (parent, index) => container.querySelector(`.nav-gap[data-drop-parent="${parent}"][data-drop-index="${index}"]`);
  const row = (id) => container.querySelector(`.structure-node[data-node-id="${id}"]`);
  const lit = () =>
    [...container.querySelectorAll('.nav-gap')]
      .filter((candidate) => candidate.children.length > 0)
      .map((candidate) => `${candidate.dataset.dropParent}:${candidate.dataset.dropIndex}`);
  const note = () => dom.window.document.querySelector('.navigator-drop-note')?.textContent;
  const noteInLayout = () => container.querySelector('.navigator-drop-note') ?? undefined;
  const start = async (id) => {
    transfer.getData = (type) => (type === 'avb/node' ? id : '');
    await fire(row(id), 'dragstart');
  };
  return { fire, gap, row, lit, note, noteInLayout, dom, start, moved, dropped, transfer, cleanup: () => root.unmount() };
}

test('a doctype over a place that cannot hold it lights the top of the page instead, and drops there', async () => {
  const view = await mount();
  await view.start('doctype');
  const over = await view.fire(view.gap('main', 1), 'dragover');
  assert.equal(over.defaultPrevented, true, 'the drop is accepted, at the neighbour');
  assert.deepEqual(view.lit(), [':0'], 'only the top of the page is lit');
  assert.match(view.note() ?? '', /doctype/i);
  assert.equal(view.noteInLayout(), undefined, 'the note is not in the panel or the tree');
  const tooltip = view.dom.window.document.querySelector('.navigator-drop-note');
  assert.equal(tooltip.parentElement, view.dom.window.document.body, 'it floats on the body');
  assert.equal(globalThis.stackiCapturedToasts.length, 0, 'no toast while the drag is still going');
  await view.fire(view.gap('main', 1), 'drop');
  assert.equal(view.note(), undefined, 'the tooltip goes with the drop');
  const toast = globalThis.stackiCapturedToasts[0];
  assert.ok(toast, 'a redirected drop reports a toast');
  assert.equal(toast.kind, 'info');
  assert.match(toast.message, /doctype/i);
  assert.match(toast.message, /nearest valid place/);
  assert.deepEqual(view.moved, [{ id: 'doctype', parentId: undefined, index: 0 }], 'the drop lands at the top');
  view.cleanup();
});

test('a list item over a page with no list shows no indicator, the not-allowed effect and the reason, and a drop writes nothing', async () => {
  const view = await mount();
  await view.start('item');
  const over = await view.fire(view.gap('main', 1), 'dragover');
  assert.equal(over.defaultPrevented, false, 'the browser keeps its not-allowed cursor');
  assert.equal(view.transfer.dropEffect, 'none');
  assert.deepEqual(view.lit(), [], 'no indicator anywhere');
  assert.match(view.note() ?? '', /li/);
  assert.equal(view.noteInLayout(), undefined, 'the note is not in the panel or the tree');
  await view.fire(view.gap('main', 1), 'drop');
  assert.deepEqual(view.moved, [], 'a refused place reaches no handler');
  view.cleanup();
});

test('a node over itself or its own subtree is refused silently: no mark, not-allowed, and no note', async () => {
  const view = await mount();
  await view.start('list');
  const over = await view.fire(view.gap('list', 0), 'dragover');
  assert.equal(over.defaultPrevented, false);
  assert.deepEqual(view.lit(), []);
  // The owner asked for no words here: they only state the obvious.
  assert.equal(view.note(), undefined);
  view.cleanup();
});

test('a valid place keeps its indicator and carries no note', async () => {
  const view = await mount();
  await view.start('p');
  const over = await view.fire(view.gap('main', 2), 'dragover');
  assert.equal(over.defaultPrevented, true);
  assert.deepEqual(view.lit(), ['main:2']);
  assert.equal(view.note(), undefined);
  await view.fire(view.gap('main', 2), 'drop');
  assert.deepEqual(view.moved, [{ id: 'p', parentId: 'main', index: 2 }]);
  view.cleanup();
});

test('a block dragged onto a list row lands just outside the list, as the indicator showed', async () => {
  const view = await mount();
  await view.start('after');
  const over = await view.fire(view.row('list'), 'dragover');
  assert.equal(over.defaultPrevented, true);
  assert.deepEqual(view.lit(), ['main:2'], 'the gap after the list, in main');
  await view.fire(view.row('list'), 'drop');
  assert.deepEqual(view.moved, [{ id: 'after', parentId: 'main', index: 2 }]);
  view.cleanup();
});
