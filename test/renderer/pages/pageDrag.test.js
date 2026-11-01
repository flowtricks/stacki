// Goal: page and folder ordering uses Navigator's gap targets and drag lifecycle.
// Method: mount the real page tree and ordering hook, dispatch native drag events, and verify
// saved order, invalid payload rejection, cancellation, and move-into-folder event isolation.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');

test('pages and folders share gap ordering and cancel without saving', async () => {
  const directory = repoPath('node_modules/.stacki-test/page-drag');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'test.cjs');
  await esbuild.build({
    stdin: {
      resolveDir: repoPath('src'),
      loader: 'tsx',
      contents: `
        export { PageTreeView } from './features/pages/PageTreeView';
        export { buildPageTree } from './features/pages/pageTree';
        export { usePageOrderDrag } from './features/pages/usePageOrderDrag';
      `,
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { PageTreeView, buildPageTree, usePageOrderDrag } = require(outfile);
  const pages = ['index.astro', 'contact.astro', 'about/index.astro', 'about/story.astro'].map((name) => ({
    name,
    path: '/site/src/pages/' + name,
    route: '/' + name.replace('.astro', ''),
  }));
  const tree = buildPageTree(pages, ['about', 'campus']);
  const saved = [];
  const moves = [];
  function App() {
    const [order, setOrder] = React.useState({ version: 1, entries: [] });
    const [dropDirectory, setDropDirectory] = React.useState();
    const reorder = usePageOrderDrag({
      order,
      enabled: true,
      save: (next) => {
        saved.push(next);
        setOrder(next);
      },
    });
    return React.createElement(PageTreeView, {
      order,
      reorder,
      node: tree,
      rel: '',
      depth: 0,
      currentPage: pages[0],
      collapsed: new Set(),
      editing: { kind: 'none' },
      dropDirectory,
      actions: {
        select() {},
        removePage() {},
        movePage() {},
        removeFolder() {},
        renameFolder() {},
        setEditing() {},
        toggleFolder() {},
        dragOver: (_event, rel) => setDropDirectory(rel),
        drop: (_event, rel) => {
          moves.push(rel);
          setDropDirectory(undefined);
        },
      },
    });
  }
  const root = createRoot(document.getElementById('root'));
  const row = (key) => document.querySelector(`[data-order-key="${key}"]`);
  const gap = (parent, index) => document.querySelector(`[data-drop-parent="${parent}"][data-drop-index="${index}"]`);
  let transfer;
  function begin(key) {
    const data = new Map();
    transfer = {
      types: [],
      setData(type, value) {
        data.set(type, value);
        this.types = [...data.keys()];
      },
      getData(type) {
        return data.get(type) ?? '';
      },
    };
    dispatch(row(key), 'dragstart');
  }
  function dispatch(element, type) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    act(() => element.dispatchEvent(event));
    return event;
  }
  try {
    await act(async () => root.render(React.createElement(App)));
    assert.equal(document.querySelectorAll('.drag-handle').length, 0);
    assert.equal(row('index.astro').style.paddingLeft, '8px');
    assert.equal(row('about/index.astro').style.paddingLeft, '22px');
    assert.equal(gap('', 0).classList.contains('nav-gap-overlay'), true);
    assert.equal(gap('', 0).style.pointerEvents, 'none');
    begin('campus/');
    assert.equal(gap('', 0).style.pointerEvents, '');
    assert.equal(gap('about', 0).style.pointerEvents, 'none');
    assert.equal(dispatch(gap('', 0), 'dragover').defaultPrevented, true);
    assert.ok(gap('', 0).querySelector('.drop-indicator'));
    dispatch(gap('', 0), 'drop');
    assert.deepEqual(saved.at(-1).entries, ['campus/', 'index.astro', 'about/', 'contact.astro']);
    assert.equal(document.querySelector('.drop-indicator') === null, true);
    begin('index.astro');
    dispatch(gap('', 4), 'dragover');
    dispatch(gap('', 4), 'drop');
    assert.deepEqual(saved.at(-1).entries, ['campus/', 'about/', 'contact.astro', 'index.astro']);
    begin('about/story.astro');
    assert.equal(dispatch(gap('about', 0), 'dragover').defaultPrevented, true);
    dispatch(gap('about', 0), 'drop');
    assert.deepEqual(saved.at(-1).entries.slice(-2), ['about/story.astro', 'about/index.astro']);
    begin('contact.astro');
    assert.equal(dispatch(gap('about', 0), 'dragover').defaultPrevented, false);
    dispatch(gap('', 0), 'dragover');
    act(() => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
    assert.equal(document.querySelector('.drop-indicator') === null, true);
    assert.equal(dispatch(gap('', 0), 'dragover').defaultPrevented, false);
    assert.equal(saved.length, 3);
    begin('contact.astro');
    dispatch(gap('', 0), 'dragover');
    dispatch(row('about/'), 'dragover');
    assert.equal(document.querySelector('.drop-indicator') === null, true);
    assert.equal(row('about/').style.borderColor, 'var(--accent)');
    dispatch(row('about/'), 'drop');
    assert.deepEqual(moves, ['about']);
    assert.equal(saved.length, 3);
    begin('campus/');
    transfer.setData('application/x-stacki-page-order', '../escape.astro');
    dispatch(gap('', 4), 'drop');
    assert.equal(saved.length, 3);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
