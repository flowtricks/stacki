// Goal: the navigator shows ::before and ::after rows only under an HTML element.
// A user's test page showed them under a loop: the canvas answers a loop's path
// with the loop's first `<li>`, and that `li`'s ::before was listed as the loop's.
// Method: the reproduction through the real pieces. A page with a loop of
// `<li class="card">`, a component instance and an `img` is parsed by the
// Astro parser and indexed by the editor's tree builder (createTreeIndex); the
// canvas report is what the frame sends for that page (every one of those paths
// "draws" a ::before), and nodeStateIds maps it to ids. Then the real
// StructurePanel renders in JSDOM with those ids, and once with a loop's id
// forced in, which must crash with the pinned message (the consumer's half).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { repoPath } = require('../../helpers/sources.js');

const directory = fs.mkdtempSync(repoPath('node_modules/.stacki-test/pseudo-host-rows-'));

async function bundle(contents, name) {
  const outfile = path.join(directory, name);
  await esbuild.build({
    stdin: { contents, resolveDir: repoPath('.'), loader: 'tsx' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return require(outfile);
}

const PAGE = [
  '---',
  "import Button from '../components/Button.astro';",
  "const items = ['one', 'two'];",
  '---',
  '<ul class="list">{items.map((item) => <li class="card">{item}</li>)}</ul>',
  '<Button class="card" />',
  '<img class="card" src="a.png" alt="" />',
  '',
].join('\n');

function reproduce({ createTreeIndex, nodeStateIds }) {
  const parsed = parsePage(PAGE, { locs: false });
  assert.equal(parsed.editable, true, 'the page parses');
  const tree = createTreeIndex(parsed.model.nodes);
  const kindAt = (nodePath) => tree.byPath.get(nodePath)?.kind;
  assert.equal(kindAt('0'), 'element');
  assert.equal(kindAt('0.0'), 'map', 'the loop sits in the list');
  assert.equal(kindAt('0.0.0'), 'element', 'the li is the loop template');
  assert.equal(kindAt('1'), 'component');
  assert.equal(tree.byPath.get('2')?.name, 'img');
  // The frame's report: the loop's path reads its first li, the instance's its
  // root, and Chromium computes `content` for an img's ::before.
  const reported = ['0.0', '0.0.0', '1', '2'];
  const ids = nodeStateIds({ hidden: ['0.0'], inert: [], before: reported, after: reported }, tree.byPath, '');
  const li = tree.byPath.get('0.0.0').id;
  assert.deepEqual([...ids.before], [li], 'only the li owns a ::before');
  assert.deepEqual([...ids.after], [li], 'only the li owns an ::after');
  assert.deepEqual([...ids.hidden], [tree.byPath.get('0.0').id], 'hidden is not filtered: the loop is hidden as its items are');
  // A component's namespace is stripped first, as the open file's paths are.
  const scoped = nodeStateIds({ hidden: [], inert: [], before: ['src/components/List.astro|0.0.0'], after: [] }, tree.byPath, 'src/components/List.astro|');
  assert.deepEqual([...scoped.before], [li], 'a namespaced path maps to its node');
  return { nodes: parsed.model.nodes, ids, li, loop: tree.byPath.get('0.0').id };
}

async function renderNavigator(StructurePanel, { nodes, ids, li, loop }) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = () => {};
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const props = {
    pageState: { editable: true, model: { nodes, imports: [] }, source: PAGE },
    layouts: [],
    currentLayoutName: '',
    // The li's ::before is the selection, so its row opens and both pseudo rows draw.
    selectedId: li,
    onSelect: () => {},
    onChangeLayout: () => {},
    onDropComponent: () => {},
    onMoveNode: () => {},
    onCodeChange: () => {},
    onOpenCodePanel: () => {},
  };
  const root = createRoot(document.getElementById('root'));
  await act(() =>
    root.render(React.createElement(StructurePanel, { ...props, selectedPseudo: 'before', pseudoNodeIds: { before: ids.before, after: ids.after } })),
  );
  const rows = [...document.querySelectorAll('[data-pseudo-of]')].map((row) => `${row.getAttribute('data-pseudo-of')}::${row.getAttribute('data-pseudo')}`);
  assert.deepEqual(rows, [`${li}::before`, `${li}::after`], 'the li has both rows, the loop, instance and img none');
  await act(() => root.unmount());

  // The consumer's assertion: a loop id that reached the rows is a crash, not a row.
  const original = console.error;
  console.error = () => {};
  const forced = createRoot(document.getElementById('root'));
  let thrown;
  try {
    await act(() =>
      forced.render(React.createElement(StructurePanel, { ...props, selectedId: loop, pseudoNodeIds: { before: new Set([loop]), after: new Set() } })),
    );
  } catch (error) {
    thrown = error;
  } finally {
    console.error = original;
  }
  assert.match(String(thrown), /Navigator: ::before belongs to an HTML element, not a map node/);
  dom.window.close();
}

(async () => {
  const model = await bundle(
    ["export { createTreeIndex } from './src/editor/editorTree';", "export { nodeStateIds } from './src/app/model/canvasNodeStates';"].join('\n'),
    'states.cjs',
  );
  const found = reproduce(model);
  const { default: StructurePanel } = await bundle("export { default } from './src/features/structure/StructurePanel';", 'panel.cjs');
  await renderNavigator(StructurePanel, found);
  console.log('pseudo-host-rows: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
