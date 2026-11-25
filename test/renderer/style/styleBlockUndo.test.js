// Undo and redo of an edit to the page's own `<style is:global>` block: the panel shows the step
// the page is on, never the one before it.
//
//   node test/renderer/style/styleBlockUndo.test.js
//
// Goal: the soak found the panel one write behind its edits to a page style block (SP-06): after
// an undo the canvas and the file had gone back, and the field and its label still showed the
// value. The app moves its history tick twice for one undo, once as the undo starts and once when
// it has landed, and the page model, which the block is read from, changes between the two. The
// panel's refresh for the first tick was still reading when the second came, and the second was
// dropped, so the panel kept what it read before the undo. The invariant: after the panel
// settles, what it shows was read from the page model and history tick that stand now.
//
// Method: the real EmbedEditor is mounted in jsdom over a host shaped like Desktop's (StylePanel
// hostState). The page holds one `<style is:global>` node; writeStyleNode changes that node on
// the next task (the app's model reaches the panel on its next render, not in the call), and
// records one undo step per burst. Undo and redo copy appHistory.ts useUndoRedo: tick, the round
// trip to main (UNDO_ROUND_TRIP_MS), the restored model, tick again. The canvas bridge answers
// from the node as it stands, after BRIDGE_MS, so a refresh is still in flight when the second
// tick arrives; so does the project's one stylesheet, which takes READ_MS to read, as a read
// over IPC does. Events are dispatched, never a real pointer; nothing is a real project.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const PAGE = '/p/src/pages/index.astro';
const SIZE = 240;
const BRIDGE_MS = 150; // The canvas answers this long after it is asked.
const READ_MS = 150; // A stylesheet read (an IPC round trip and the disk) takes this long.
const UNDO_ROUND_TRIP_MS = 60; // Main restores the page this long after the undo starts.
const SETTLE_MS = 900; // Past the bridge replies and the refresh passes behind a step.
const CSS_INITIAL = '\n  .plain {\n    color: red;\n  }\n';

let environment;

// The panel, its host setter and a jsdom window, set up once for the file.
async function panelEnvironment() {
  if (environment) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'style-block-undo.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as EmbedEditor } from './src/features/style/EmbedEditor'\nexport { setHost, getHost } from './src/features/style/model/host'\nexport { setCanvasFrame, receiveCanvasReply } from './src/editor/canvasQuery'`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: false,
  };
  // Node defines navigator as a getter, so each global is defined, not assigned.
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  }
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = Observer;
  dom.window.ResizeObserver = Observer;
  dom.window.Element.prototype.scrollIntoView = function () {};
  // eslint-disable-next-line stacki/no-null -- Stubs the platform getContext, which answers null.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  environment = { dom, React, createRoot, ...require(bundlePath) };
  return environment;
}

const classAttr = (value) => ({ type: 'string', value });
const styleNode = (inner) => ({ id: 'n9', kind: 'raw', name: 'style', props: { 'is:global': { type: 'bare' } }, inner });
const paragraph = { id: 'n1', kind: 'element', name: 'p', props: { class: classAttr('plain') }, children: [] };

// The value `prop` has in the `.plain` rule of `css`, or '' when the rule does not declare it.
function declared(css, prop) {
  const rule = /\.plain\s*\{([^}]*)\}/.exec(css);
  const declaration = rule ? new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(rule[1]) : undefined;
  return declaration ? declaration[1].trim() : '';
}

async function mountPanel() {
  const { dom, React, createRoot, EmbedEditor, setHost, getHost, setCanvasFrame, receiveCanvasReply } = await panelEnvironment();
  const page = { css: CSS_INITIAL };
  const history = { past: [], future: [] };
  const sheet = { rel: 'src/styles/site.css', name: 'site.css', path: '/p/src/styles/site.css', size: 100 };
  // The page model the panel is shown, as StylePanel publishes it: a new node list per change.
  const publish = () => setHost({ nodes: [paragraph, styleNode(page.css)] });
  const host = {
    projectPath: '/p',
    selectedId: 'n1',
    files: [sheet],
    astroFiles: [],
    openFilePath: PAGE,
    openFileKind: 'page',
    renderedClasses: ['plain'],
    pathOf: () => undefined,
    nodes: [paragraph, styleNode(page.css)],
    historyTick: 0,
    // The app's setNodeText: the edit is one step per burst (coalesced by node), and the model
    // with it reaches the panel on the app's next render, not inside this call.
    writeStyleNode: (target, css) => {
      assert.equal(target.nodeId, 'n9', 'the write is for the page block');
      const before = page.css;
      page.css = css;
      const previous = history.past[history.past.length - 1];
      if (previous !== undefined && previous.open) {
        previous.after = css;
      } else {
        history.past.push({ before, after: css, open: true });
      }
      history.future.length = 0;
      setTimeout(publish, 0);
      return true;
    },
  };
  dom.window.avb = {
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files: [sheet] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async () => {
      await wait(READ_MS);
      return { css: '.other { color: blue; }' };
    },
    writeStyleFile: async () => ({ ok: true }),
  };
  setCanvasFrame({
    postMessage: (message) => {
      if (message?.type !== 'avb:query') {
        return;
      }
      const matched = Object.fromEntries((message.selectors ?? []).map((selector) => [selector, selector === '.plain' || selector === 'p']));
      // Read when the answer is sent, so a stale question gets the page as it is by then.
      setTimeout(
        () =>
          receiveCanvasReply({
            id: message.id,
            found: true,
            identity: { tag: 'p', classes: ['plain'], attributes: {} },
            matched,
            computed: {},
            computedProps: { 'letter-spacing': declared(page.css, 'letter-spacing') || 'normal', color: declared(page.css, 'color') },
          }),
        BRIDGE_MS,
      );
    },
  });
  setHost(host);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(EmbedEditor));
  await wait(1200);

  // The app's undo and redo of a page edit (appHistory.ts useUndoRedo): the tick as the step
  // starts, the round trip to main, the restored model, and the tick again once it has landed.
  const step = async (direction) => {
    const from = direction === 'undo' ? history.past : history.future;
    const to = direction === 'undo' ? history.future : history.past;
    const entry = from.pop();
    assert.ok(entry, `there is a step to ${direction}`);
    entry.open = false;
    to.push(entry);
    setHost({ historyTick: getHost().historyTick + 1 });
    await wait(UNDO_ROUND_TRIP_MS);
    page.css = direction === 'undo' ? entry.before : entry.after;
    setHost({ nodes: [paragraph, styleNode(page.css)], historyTick: getHost().historyTick + 1 });
    await wait(SETTLE_MS);
  };
  const rowOf = (name) => {
    const label = [...container.querySelectorAll('.u-field-label')].find((candidate) => candidate.textContent.trim() === name);
    return label === undefined ? undefined : (label.closest('.u-field-label-wrap') ?? label).parentElement;
  };
  // The label's state and the field's text for a property row.
  const shown = (name) => {
    const row = rowOf(name);
    assert.ok(row, `the ${name} row exists`);
    const label = [...row.querySelectorAll('.u-field-label')].find((candidate) => candidate.textContent.trim() === name);
    const input = row.querySelector('input:not([type="hidden"])');
    return { active: label.classList.contains('is-active'), input: input === null ? undefined : input.value };
  };
  const type = async (name, text) => {
    const input = rowOf(name).querySelector('input');
    input.focus();
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await wait(40);
    input.blur();
    await wait(SETTLE_MS);
    // The burst is over: the next edit is a step of its own.
    const last = history.past[history.past.length - 1];
    if (last !== undefined) {
      last.open = false;
    }
  };
  return { page, history, shown, type, undo: () => step('undo'), redo: () => step('redo'), unmount: () => (root.unmount(), container.remove()) };
}

test('undo and redo of a page style block edit show the step the page is on, every time', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  assert.equal(panel.shown('Letter spacing').active, false, 'the rule sets no letter spacing at first');
  await panel.type('Letter spacing', '0.1em');
  assert.equal(declared(panel.page.css, 'letter-spacing'), '0.1em', 'the block declares the typed value');
  assert.deepEqual(panel.shown('Letter spacing'), { active: true, input: '0.1em' }, 'set: the label is blue and the field holds the value');
  assert.equal(panel.history.past.length, 1, 'the edit is one step');
  // Twice round, so a panel one step behind shows on the second lap even if the first is lucky.
  for (const lap of [1, 2]) {
    await panel.undo();
    assert.equal(declared(panel.page.css, 'letter-spacing'), '', `undo ${lap}: the block is back`);
    assert.deepEqual(panel.shown('Letter spacing'), { active: false, input: '' }, `undo ${lap}: the label is plain and the field empty`);
    await panel.redo();
    assert.equal(declared(panel.page.css, 'letter-spacing'), '0.1em', `redo ${lap}: the block declares the value again`);
    assert.deepEqual(panel.shown('Letter spacing'), { active: true, input: '0.1em' }, `redo ${lap}: the label is blue and the field holds the value`);
  }
});

test('a page model replaced with no history step (a reload, a code edit) shows at once', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  const { setHost, getHost } = await panelEnvironment();
  // A new model and nothing else: no tick, no stylesheet changed. The block is read from the
  // nodes in memory, so the panel follows without waiting for its poll's full rescan.
  panel.page.css = '\n  .plain {\n    color: red;\n    letter-spacing: 0.2em;\n  }\n';
  const tick = getHost().historyTick;
  setHost({ nodes: [paragraph, styleNode(panel.page.css)] });
  await wait(SETTLE_MS);
  assert.equal(getHost().historyTick, tick, 'no history step was taken');
  assert.deepEqual(panel.shown('Letter spacing'), { active: true, input: '0.2em' }, 'the panel shows what the block now declares');
});
