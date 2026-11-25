// Goal: a conditional that renders several roots through a Fragment (shorthand
// `<>` or named) is navigable — its children are editable Navigator groups with
// stable identity — rather than one opaque expression.
// Method: a regression source from a real project is parsed with the built
// parser in both Fragment spellings; the tree is flattened and each expected
// node is checked for kind, editability and source identity.

const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS } = require('#dist/shared/core/limits.js');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');

// The shape that made the real SermonSearch subtree disappear into one opaque
// expression: a conditional returning multiple roots through shorthand Fragment.
const source = `---
import Modal from './Modal.astro';
const { render = true, class: className } = Astro.props;
---
{render && (
  <>
    <div class:list={['sermon-search_wrap', className]}>
      <textarea class="sermon-search_field" aria-label="Search sermons" />
      <button class="sermon-search_submit" type="button">Search</button>
      <div class="sermon-search_status" />
    </div>
    <Modal label="Search results">
      <div class="sermon-search_results" />
    </Modal>
  </>
)}
`;

const flatten = (nodes, depth = 0) => {
  assert.ok(depth <= LIMITS.treeDepthMax, 'flatten: tree depth limit');
  return nodes.flatMap((node) => [node, ...flatten(node.children || [], depth + 1)]);
};
async function checkFragment(syntax) {
  const input = syntax === 'shorthand' ? source : source.replace('<>', '<Fragment>').replace('</>', '</Fragment>');
  const parsed = parsePage(input);
  assert.equal(parsed.editable, true);
  const nodes = flatten(parsed.model.nodes);
  const fragment = nodes.find((node) => node.name === 'Fragment');
  assert.ok(fragment, 'the conditional has a structured Fragment');
  assert.equal(!!fragment.shorthand, syntax === 'shorthand', 'both Fragment spellings keep their source identity');
  assert.equal(fragment.kind, 'component');
  const textarea = nodes.find((node) => node.name === 'textarea');
  const button = nodes.find((node) => node.name === 'button');
  const modal = nodes.find((node) => node.name === 'Modal');
  const shell = fragment.children.find((node) => node.name === 'div');
  const status = nodes.find((node) => node.props?.class?.value === 'sermon-search_status');
  const results = nodes.find((node) => node.props?.class?.value === 'sermon-search_results');
  assert.ok(textarea && button && modal && shell && status && results, 'all nested elements survive parsing');
  assert.equal(
    nodes.some((node) => node.kind === 'expr' && /<>|<Fragment>/.test(node.value)),
    false,
  );

  const buildDirectory = repoPath('node_modules/.stacki-test/fragment-navigation');
  fs.mkdirSync(buildDirectory, { recursive: true });
  await esbuild.build({
    stdin: {
      // One export per line, so a moved file's longer path still fits.
      contents: [
        "export {default as StructurePanel} from './src/features/structure/StructurePanel.tsx';",
        "export {liveClassesById} from './src/editor/liveClasses.ts';",
        "export {createTreeIndex} from './src/editor/editorTree.ts';",
      ].join('\n'),
      loader: 'jsx',
      resolveDir: ROOT,
    },
    outfile: path.join(buildDirectory, 'navigator.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty' },
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  global.window = dom.window;
  for (const name of ['document', 'navigator', 'Element', 'HTMLElement', 'Node']) {
    global[name] = dom.window[name];
  }
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { StructurePanel, liveClassesById, createTreeIndex } = require(path.join(buildDirectory, 'navigator.js'));
  const tree = createTreeIndex(parsed.model.nodes);
  const live = liveClassesById(
    {
      [tree.path(fragment.id)]: ['sermon-search_wrap', 'theme-light'],
      [tree.path(shell.id)]: ['sermon-search_wrap', 'theme-light'],
    },
    parsed.model.nodes,
  );
  assert.equal(live.has(fragment.id), false, 'the first rendered child does not lend Fragment its class');
  const selections = [];
  const opened = [];
  function Harness() {
    const [selectedId, setSelectedId] = React.useState(undefined);
    return React.createElement(StructurePanel, {
      pageState: parsed,
      currentPage: { kind: 'component', name: 'SermonSearch.astro' },
      layouts: [],
      currentLayoutName: '',
      selectedId,
      liveClassesById: live,
      onSelect: (id) => {
        selections.push(id);
        setSelectedId(id);
      },
      onOpenComponent: (name, id) => opened.push({ name, id }),
      onHoverNode: () => {},
      onDropComponent: () => {},
      onMoveNode: () => {},
      onRemoveNode: () => {},
      onCopyNode: () => {},
      onDuplicateNode: () => {},
      onPasteNode: () => {},
      onChangeLayout: () => {},
      hasClipboard: () => false,
      onCodeChange: () => {},
      onOpenCodePanel: () => {},
    });
  }
  const container = document.getElementById('root');
  const root = createRoot(container);
  const row = (node) => container.querySelector(`.structure-node[data-node-id="${node.id}"]`);
  const label = (node) => row(node)?.querySelector('.label').textContent.trim();
  const click = (element, type = 'click') =>
    act(async () => {
      assert.ok(element, `target for ${type} is visible`);
      element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));
    });
  const arrow = (key) =>
    act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await click(container.querySelector('.panel-header button'));
    for (const node of [fragment, shell, textarea, button, status, modal, results]) {
      assert.ok(row(node), `${node.name} is exposed after expanding the Navigator`);
    }
    assert.equal(label(fragment), 'Fragment');
    assert.equal(row(fragment).classList.contains('is-component'), false, 'Fragment uses neutral group styling');
    assert.match(row(fragment).title, /inline group/i, 'Fragment explains that its contents are an inline group');
    assert.match(row(fragment).title, /no separate (?:component )?file/i, 'Fragment explains why double-click cannot open a file');
    assert.equal(row(modal).classList.contains('is-component'), true, 'real components retain their distinct styling');
    assert.equal(label(shell), '.sermon-search_wrap');
    assert.equal(label(modal), 'Modal');
    for (const node of [textarea, button, status, results]) {
      await click(row(node));
      assert.equal(selections.at(-1), node.id, 'selection points to the editable child, not the enclosing expression');
      assert.ok(row(node).classList.contains('selected'));
    }
    await click(row(textarea));
    await arrow('ArrowRight');
    assert.equal(selections.at(-1), button.id);
    await arrow('ArrowUp');
    assert.equal(selections.at(-1), shell.id);
    await arrow('ArrowUp');
    assert.equal(selections.at(-1), fragment.id);
    await click(row(fragment).querySelector('.drag-handle'));
    assert.ok(row(textarea) === null, 'Fragment can collapse its subtree');
    await arrow('ArrowDown');
    assert.equal(selections.at(-1), shell.id, 'arrow navigation expands Fragment and enters its children');
    assert.ok(row(textarea));
    await click(row(fragment), 'dblclick');
    assert.deepEqual(opened, [], 'the built-in Fragment has no component file to open');
    await click(row(modal), 'dblclick');
    assert.deepEqual(opened, [{ name: 'Modal', id: modal.id }], 'ordinary component drill-down remains available');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}

for (const syntax of ['shorthand', 'named']) {
  test(`conditional ${syntax} fragments expose ` + `editable Navigator groups and preserve identity`, () => checkFragment(syntax));
}
