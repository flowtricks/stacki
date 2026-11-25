// Goal: a double-click on a navigator row that holds code opens that code in the
// floating editor — the one Enter and the "Edit code" button already open.
//
// Methodology: two layers, each checked on its own.
// 1. `codeWindowFor`, the pure rule shared by Enter, the button and the
//    double-click: which subject opens which editor, and what has none.
// 2. The navigator itself, rendered in JSDOM: a double-click on the Frontmatter,
//    a <style> or a <script> row reports that row's id — not the selection,
//    which the row's own click has only just asked for — while element and
//    component rows keep the behaviour they had.
//
// Run it with `node test/renderer/structure/navigatorOpenCode.test.js`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test');
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const bundle = async (entry, name) => {
  const outfile = path.join(buildDirectory, name);
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
};

const raw = (id, name) => ({ id, kind: 'raw', name, inner: 'a {}' });
const element = (id, name, children = []) => ({
  id,
  kind: 'element',
  name,
  props: { class: id },
  children,
});
const component = (id, name) => ({ id, kind: 'component', name, props: {}, children: [] });

function checkCodeWindowRule({ codeWindowFor, fileWindowIndentation }) {
  // A project file's window: YAML forbids tabs, so a Tab there must write spaces.
  assert.deepEqual(fileWindowIndentation('public/admin/config.yml'), { indentation: 'spaces' });
  assert.deepEqual(fileWindowIndentation('data/site.YAML'), { indentation: 'spaces' });
  assert.deepEqual(fileWindowIndentation('src/styles/site.css'), {});
  assert.throws(() => fileWindowIndentation(''), /a file window has a path/);
  assert.deepEqual(codeWindowFor({ id: 'frontmatter', kind: 'frontmatter' }), {
    targetId: 'frontmatter',
    title: 'Frontmatter',
    language: 'javascript',
  });
  assert.deepEqual(codeWindowFor(raw('s1', 'style')), {
    targetId: 's1',
    title: '<style>',
    language: 'css',
    indentation: 'block',
  });
  assert.deepEqual(codeWindowFor(raw('j1', 'script')), {
    targetId: 'j1',
    title: '<script>',
    language: 'javascript',
    indentation: 'block',
  });
  // The parser keeps a tag as written, so a capitalised one must still open.
  assert.deepEqual(codeWindowFor(raw('s2', 'STYLE')), {
    targetId: 's2',
    title: '<STYLE>',
    language: 'css',
    indentation: 'block',
  });
  // Markup has no code editor of its own: Enter on it must stay unhandled.
  assert.equal(codeWindowFor(element('e1', 'div')), undefined);
  assert.equal(codeWindowFor(component('c1', 'Card')), undefined);
  // The parser only ever makes <style> and <script> raw. Any other name is a
  // broken invariant, not a language to guess.
  assert.throws(() => codeWindowFor(raw('t1', 'template')), /Assertion failed: raw node <template> has no code language/);
  assert.throws(() => codeWindowFor(raw('', 'style')), /Assertion failed: raw node has an id/);
}

function installDom() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  return dom;
}

async function checkNavigator(StructurePanel) {
  const dom = installDom();
  const React = require('react');
  const { act } = require('react');
  const { createRoot } = require('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const opened = { code: [], component: [] };
  const nodes = [element('page', 'main', [raw('s1', 'style'), element('e1', 'div'), component('c1', 'Card')]), raw('j1', 'script')];
  await act(async () => {
    reactRoot.render(
      React.createElement(StructurePanel, {
        pageState: { editable: true, model: { nodes, imports: [] } },
        layouts: [],
        currentLayoutName: '',
        selectedId: undefined,
        onSelect: () => {},
        onOpenCode: (id) => opened.code.push(id),
        onOpenComponent: (name, id) => opened.component.push(`${name}:${id}`),
        onChangeLayout: () => {},
        onDropComponent: () => {},
        onMoveNode: () => {},
        onRemoveNode: () => {},
        onCopyNode: () => {},
        onDuplicateNode: () => {},
        onPasteNode: () => {},
        onCodeChange: () => {},
        onOpenCodePanel: () => {},
        hasClipboard: false,
      }),
    );
    await settle(20);
  });
  // Open every remaining branch so each code row can be exercised.
  await act(async () => {
    container.querySelector('.panel-header button').click();
    await settle(20);
  });
  const doubleClick = async (row) => {
    assert.ok(row, 'the row to double-click is drawn');
    opened.code.length = 0;
    opened.component.length = 0;
    await act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
      await settle(10);
    });
    return { code: [...opened.code], component: [...opened.component] };
  };
  const rowFor = (id) => container.querySelector(`.structure-node[data-node-id="${id}"]`);

  const frontmatter = await doubleClick(container.querySelector('.frontmatter-node'));
  assert.deepEqual(frontmatter, { code: ['frontmatter'], component: [] });
  assert.deepEqual(await doubleClick(rowFor('s1')), { code: ['s1'], component: [] });
  assert.deepEqual(await doubleClick(rowFor('j1')), { code: ['j1'], component: [] });
  // Rows without code keep what they did before: nothing, or open the component.
  assert.deepEqual(await doubleClick(rowFor('e1')), { code: [], component: [] });
  assert.deepEqual(await doubleClick(rowFor('c1')), { code: [], component: ['Card:c1'] });
  await act(async () => reactRoot.unmount());
}

(async () => {
  fs.mkdirSync(buildDirectory, { recursive: true });
  checkCodeWindowRule(await bundle('src/features/code/codeWindowTarget.ts', 'code-window-target.cjs'));
  const { default: StructurePanel } = await bundle('src/features/structure/StructurePanel.tsx', 'navigator-open-code.cjs');
  await checkNavigator(StructurePanel);
  console.log('navigator-open-code: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
