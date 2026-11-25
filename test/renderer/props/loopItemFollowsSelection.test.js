// Goal: the data picker opens on the loop item the selected canvas node is in,
// end to end, through the app's own wiring.
//
// The reported page: `platformIntro.cards.map((card) => …)` renders three
// cards; each shows a FlutedImage when `card.fluted` and an Image otherwise, and
// only card three is not fluted, so the selected Image renders ONCE. Counting
// its copies said "first of one"; the picker showed card 1 of 3.
//
// Method, nothing faked but the window around it:
//   page      a generated source (the page above) parsed by the real parser;
//   canvas    its markup as the marker plugin serves it, with the pass markers,
//             collected by the real preload modules in jsdom; a click is read
//             from them (iterationsForRun), sent through the real message
//             parser, and turned into the selection info the preview runtime
//             hands the app (canvasSelectInfoOf);
//   app       the real selectCanvasPath selects it, the real bindContextOf
//             builds the picker's context from the app state, the real
//             dataTree and DataPicker draw it, and the arrows are clicked.
// Checked: Image in card 3 opens on 3/3 with card 3's values; a node in card 2
// opens on 2/3; changing the selection moves the pager; paging by hand sticks
// for that selection and a new selection starts again; a page that marks no
// passes falls back on the copy's place, and then on item 1; a pass the render
// could not place (-1) reads as unknown. Fixtures are generated here.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const directory = repoPath('node_modules/.stacki-test/loop-item-follows-selection');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'bundle.cjs');
buildSync({
  stdin: {
    contents: [
      "export { selectCanvasPath } from './src/app/shell/AppPanes';",
      "export { bindContextOf } from './src/app/shell/ProjectWindow';",
      "export { loopScopeOf } from './src/app/state/appViewModel';",
      "export { createTreeIndex } from './src/editor/editorTree';",
      "export { dataTree } from './src/editor/dataSuggest';",
      "export { default as DataPicker } from './src/features/props/DataPicker';",
      "export { parsePreviewMessage } from './src/features/preview/previewMessages';",
      "export { canvasSelectInfoOf } from './src/features/preview/previewRuntime';",
      "export * from './electron/preload/frameRegions';",
      "export * from './electron/preload/frameIterations';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'Comment']) {
  global[name] = dom.window[name] ?? dom.window.MouseEvent;
}
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const app = require(output);

const CARDS = [
  { title: 'Build together', fluted: true, image: 'one.png' },
  { title: 'Publish at scale', fluted: true, image: 'two.png' },
  { title: 'Ship it', fluted: false, image: 'three.png' },
];
const SOURCE = [
  '---',
  'const { platformIntro } = Astro.props;',
  '---',
  '<main>',
  '  {platformIntro.cards.map((card) => (',
  '    <article>',
  '      {card.fluted ? <FlutedImage src={card.image} /> : <Image src={card.image} />}',
  '    </article>',
  '  ))}',
  '</main>',
  '',
].join('\n');

// The page model, and where each interesting node sits in it.
const parsed = parsePage(SOURCE);
assert.ok(parsed.editable);
const model = parsed.model;
const tree = app.createTreeIndex(model.nodes);
const idOf = (predicate) => [...tree.byId.values()].find((entry) => predicate(entry.node))?.node.id;
const pathOfName = (name) => tree.path(idOf((node) => node.name === name));
const LOOP = tree.path(idOf((node) => node.kind === 'map'));
const ARTICLE = tree.path(idOf((node) => node.name === 'article'));
const FLUTED = pathOfName('FlutedImage');
const IMAGE = pathOfName('Image');

// The markup the marker plugin serves for it: a pass marker, then the card. `passes` is what each
// pass says it is (the item's place in `cards`), or undefined for a page that marks none.
const wrap = (nodePath, inner) => `<!--avb-s:${nodePath}-->${inner}<!--avb-e:${nodePath}-->`;
function markup(passes) {
  const condPath = tree.path(idOf((node) => node.kind === 'cond'));
  const condBranch = (index) => `${condPath}.${index}`;
  const card = (data, at) => {
    const leaf = data.fluted
      ? wrap(condBranch(0), wrap(FLUTED, `<section data-avb-p="${FLUTED}">fluted</section>`))
      : wrap(condBranch(1), wrap(IMAGE, `<img data-avb-p="${IMAGE}">`));
    const mark = passes === undefined ? '' : `<!--avb-i:${passes[at]}:${LOOP}-->`;
    return `${mark}${wrap(ARTICLE, `<article data-avb-p="${ARTICLE}">${wrap(condPath, leaf)}</article>`)}`;
  };
  return wrap('0', `<main data-avb-p="0">${wrap(LOOP, CARDS.map(card).join(''))}</main>`);
}

// A canvas showing `html`: clicks are read from it as the frame reads them.
function canvas(html) {
  const frame = new JSDOM(`<!doctype html><body>${html}</body>`);
  const saved = { window: global.window, document: global.document };
  global.window = frame.window;
  global.document = frame.window.document;
  try {
    // One page per frame: what an earlier test's page collected is not this page's.
    app.regions.clear();
    app.forgetIterationMarks();
    app.collectRegions();
    return {
      // The click-node message the frame posts for copy `occurrence` of `nodePath`, as the editor parses it.
      click(nodePath, occurrence) {
        const runs = app.runsOf(nodePath);
        const iterations = app.iterationsForRun(nodePath, runs?.[occurrence]);
        const wire = JSON.parse(
          JSON.stringify({
            type: 'avb:click-node',
            path: nodePath,
            occurrence,
            outside: false,
            x: 1,
            y: 1,
            boxes: runs.map(() => ({ x: 0, y: 0, w: 1, h: 1 })),
            ...(iterations.length === 0 ? {} : { iterations }),
            token: 'a'.repeat(64),
          }),
        );
        return app.parsePreviewMessage(wire);
      },
      copies: (nodePath) => app.runsOf(nodePath)?.length ?? 0,
    };
  } finally {
    global.window = saved.window;
    global.document = saved.document;
  }
}

// The editor around the picker: the app's state, as its hooks hold it.
function Window({ session }) {
  const [, tick] = React.useState(0);
  session.rerender = () => tick((count) => count + 1);
  const selected = session.selectedId === undefined ? undefined : tree.node(session.selectedId);
  const ancestors = session.selectedId === undefined ? [] : (tree.ancestors(session.selectedId) ?? []);
  const live = {
    model,
    selectedId: session.selectedId,
    canvasCopy: session.canvasCopy,
    itemPaging: session.itemPaging,
    pathFor: (id) => tree.path(id),
    setItemPaging: (update) => {
      session.itemPaging = update(session.itemPaging);
      session.rerender();
    },
    loopContext: selected === undefined ? undefined : app.loopScopeOf(model, ancestors),
    insertables: [],
    currentPage: { kind: 'page', path: '/project/src/pages/index.astro' },
    editStack: [],
    collectionSamples: {},
    valueSamples: {},
    scopeSamples: {},
    importedValues: {},
    collections: [],
    projectSources: { config: undefined, nodes: [], imported: {} },
    dynamicPaths: [],
    dynamicIndex: 0,
  };
  const context = app.bindContextOf(live, { dynamicEntry: { route: '/', props: { platformIntro: { cards: CARDS } } } });
  if (context === undefined) {
    return React.createElement('div', { className: 'nothing' });
  }
  const tree_ = app.dataTree(context);
  session.tree = tree_;
  return React.createElement(app.DataPicker, { tree: tree_, onPick: () => {}, onStepItem: context.onStepItem, origin: context.origin });
}

// A session: select what the canvas message names, with the real selection code.
async function open(html) {
  const session = { selectedId: undefined, canvasCopy: undefined, itemPaging: { key: '', pages: {} }, rerender: () => {} };
  const shown = canvas(html);
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Window, { session })));
  const shell = {
    get model() {
      return model;
    },
    focusPath: undefined,
    editedRel: '',
    defaultsCanvas: { state: { kind: 'idle' } },
    setSelectedId: (id) => {
      session.selectedId = id;
    },
    setCanvasCopy: (copy) => {
      session.canvasCopy = copy;
    },
    setPseudoPick: () => {},
    setLeftTab: () => {},
    setRevealTick: () => {},
  };
  return {
    shown,
    session,
    async select(nodePath, occurrence) {
      const message = shown.click(nodePath, occurrence);
      assert.equal(message.kind, 'click-node');
      await act(async () => {
        app.selectCanvasPath(shell, message.path, app.canvasSelectInfoOf(message));
        session.rerender();
      });
    },
    // The loop item row and what the picker says about it.
    pager: () => document.querySelector('.dp-item-count')?.textContent,
    card: () => session.tree?.find((node) => node.path === 'card'),
    async step(direction) {
      const buttons = [...document.querySelectorAll('.dp-step')];
      await act(async () => buttons[direction < 0 ? 0 : 1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    },
    async close() {
      await act(async () => root.unmount());
    },
  };
}
const title = (node) => node.children.find((child) => child.key === 'title').preview;

test('the Image that renders only in card 3 opens the picker on 3/3 with card 3’s values', async () => {
  const html = markup([0, 1, 2]);
  const editor = await open(html);
  assert.equal(editor.shown.copies(IMAGE), 1, 'the Image renders once, so its copy number says nothing');
  await editor.select(IMAGE, 0);
  assert.equal(editor.pager(), '3/3');
  assert.equal(title(editor.card()), '"Ship it"');
  await editor.close();
});

test('a node in card 2 opens on 2/3, and changing the selection moves the pager', async () => {
  const editor = await open(markup([0, 1, 2]));
  await editor.select(FLUTED, 1);
  assert.equal(editor.pager(), '2/3');
  assert.equal(title(editor.card()), '"Publish at scale"');
  await editor.select(FLUTED, 0);
  assert.equal(editor.pager(), '1/3', 'the first fluted image is in card 1');
  await editor.select(IMAGE, 0);
  assert.equal(editor.pager(), '3/3', 'and back to the Image in card 3');
  await editor.close();
});

test('paging by hand sticks for that selection, and a new selection starts from its own item', async () => {
  const editor = await open(markup([0, 1, 2]));
  await editor.select(IMAGE, 0);
  await editor.step(1);
  assert.equal(editor.pager(), '1/3', 'next from 3/3 wraps');
  await editor.step(1);
  assert.equal(editor.pager(), '2/3');
  await editor.select(FLUTED, 1);
  assert.equal(editor.pager(), '2/3', 'the new selection is in card 2');
  await editor.select(FLUTED, 0);
  assert.equal(editor.pager(), '1/3', 'and a manual page did not follow it');
  await editor.step(-1);
  assert.equal(editor.pager(), '3/3');
  await editor.select(IMAGE, 0);
  assert.equal(editor.pager(), '3/3', 'reselecting resets the paging to where the canvas says');
  await editor.close();
});

test('a loop that renders a filtered list reads the item’s place in the list the picker shows', async () => {
  // Rendered order is card 3, then card 1: the passes say places 2 and 0.
  const only = [CARDS[2], CARDS[0]];
  const original = CARDS.slice();
  CARDS.splice(0, 3, ...original);
  const html = (() => {
    const condPath = tree.path(idOf((node) => node.kind === 'cond'));
    const leafFor = (data) =>
      data.fluted
        ? wrap(`${condPath}.0`, wrap(FLUTED, `<section data-avb-p="${FLUTED}">f</section>`))
        : wrap(`${condPath}.1`, wrap(IMAGE, `<img data-avb-p="${IMAGE}">`));
    const card = (data, place) =>
      `<!--avb-i:${place}:${LOOP}-->${wrap(ARTICLE, `<article data-avb-p="${ARTICLE}">${wrap(condPath, leafFor(data))}</article>`)}`;
    return wrap('0', `<main data-avb-p="0">${wrap(LOOP, card(only[0], 2) + card(only[1], 0))}</main>`);
  })();
  const editor = await open(html);
  await editor.select(FLUTED, 0);
  assert.equal(editor.pager(), '1/3', 'the second rendered card is item 1 of the list, not 2');
  await editor.select(IMAGE, 0);
  assert.equal(editor.pager(), '3/3', 'the first rendered card is item 3 of the list');
  await editor.close();
});

test('a page that marks no passes falls back on the copy’s place, then on item 1', async () => {
  const editor = await open(markup(undefined));
  await editor.select(FLUTED, 1);
  assert.equal(editor.pager(), '1/3', 'two fluted copies of three cards do not add up: item 1');
  await editor.close();
  const all = await open(wrapAllCards());
  await all.select(ARTICLE, 2);
  assert.equal(all.pager(), '3/3', 'every card renders the article, so its copy is its item');
  await all.close();
});

test('a pass the render could not place reads as unknown, not as a guess', async () => {
  const editor = await open(markup([-1, -1, -1]));
  await editor.select(IMAGE, 0);
  assert.equal(editor.pager(), '1/3');
  await editor.close();
});

// A page that marks no passes, where the loop's own node renders once per card.
function wrapAllCards() {
  const condPath = tree.path(idOf((node) => node.kind === 'cond'));
  const card = (data) =>
    wrap(
      ARTICLE,
      `<article data-avb-p="${ARTICLE}">${wrap(condPath, data.fluted ? wrap(`${condPath}.0`, wrap(FLUTED, `<i data-avb-p="${FLUTED}"></i>`)) : wrap(`${condPath}.1`, wrap(IMAGE, `<img data-avb-p="${IMAGE}">`)))}</article>`,
    );
  return wrap('0', `<main data-avb-p="0">${wrap(LOOP, CARDS.map(card).join(''))}</main>`);
}
