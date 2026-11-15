// Goal: the outline of a hovered or clicked node is drawn from the event itself, never from an
// answer that has to come back first (docs/canvas-click.md, "Speed"). The frame sends the node's
// boxes with the hover and with the click; the canvas draws them in the same step it hears the
// event. Nothing it draws waits on a track round trip (`avb:track` then `avb:rects`), on main
// judging the click (a promise that may never settle), or on the Style panel.
// Methodology: mount the real PreviewPane in jsdom with a judge whose promise the test holds,
// deliver the frame's messages, and read the DOM. The frame never answers `avb:track`, so any
// outline on screen came from the event. Waits are bounded polls on observable state; there are
// no timing assertions (the latency budget lives in the opt-in soak, stylePanelSoak).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/canvas-outline-instant');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: "export { default as PreviewPane } from './src/features/preview/PreviewPane.tsx';",
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'preview.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function installDOM() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.KeyboardEvent = dom.window.KeyboardEvent;
  global.CustomEvent = dom.window.CustomEvent;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  global.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

// The pane, a stand-in frame, and what the pane told the app.
async function mount(judge, { answers = true } = {}) {
  const dom = installDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  const seen = { selected: [], notices: [], reloads: 0, hovers: 0 };
  const props = {
    devUrl: 'http://localhost:4321',
    route: '/',
    devStatus: 'on',
    device: 'desktop',
    selPath: undefined,
    focusPath: undefined,
    crumbs: [],
    onDevice() {},
    onEditRoute() {},
    judgeEvent: judge,
    onCanvasNotice: (event) => seen.notices.push(event),
    onRefresh: () => {
      seen.reloads += 1;
    },
    onSelectPath: (path) => seen.selected.push(path),
    overlayInfo: () => ({
      label: 'Card',
      kind: 'element',
      tag: 'div',
      nodeKind: 'element',
      childCount: 0,
      astroAsset: false,
      dynamicTag: false,
      isLayout: false,
      bound: false,
    }),
  };
  const act = (action) =>
    React.act(async () => {
      await action();
      await tick();
    });
  await act(() => root.render(React.createElement(PreviewPane, props)));
  const frame = document.querySelector('iframe').contentWindow;
  const shown = { token: TOKEN, path: '0.1' };
  const send = (data) => act(() => window.dispatchEvent(new window.MessageEvent('message', { source: frame, data })));
  const queries = [];
  frame.postMessage = (message) => {
    if (message.type === 'avb:click-query') {
      queries.push(message);
      if (answers) {
        // The frame hit-tests the point again on the page it shows now.
        setTimeout(() => {
          window.dispatchEvent(
            new window.MessageEvent('message', {
              source: frame,
              data: {
                type: 'avb:click-node',
                path: shown.path,
                occurrence: 0,
                outside: false,
                x: message.x,
                y: message.y,
                replay: message.id,
                token: shown.token,
              },
            }),
          );
        }, 0);
      }
    }
  };
  // Each poll is one act and a 10 ms tick; the default covers a few seconds.
  const until = async (condition, what, pollsMax = 400) => {
    for (let attempt = 0; attempt < pollsMax; attempt++) {
      if (condition()) {
        return;
      }
      await act(() => {});
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  const close = async () => {
    await act(() => root.unmount());
    dom.window.close();
  };
  return { seen, send, shown, queries, until, close };
}

const TOKEN = 'a'.repeat(64);

const BOX = { x: 10, y: 20, w: 300, h: 40 };

// A judge the test settles itself: the click is "being judged" until it says so.
function heldJudge() {
  let settle;
  const verdict = new Promise((resolve) => {
    settle = resolve;
  });
  return { judge: () => verdict, settle };
}

const outline = (type) => document.querySelector(`.node-outline.${type}`) ?? undefined;

test('a hover draws its outline from the event, with no track round trip', async () => {
  const pane = await mount(async () => ({ tag: 'current' }));
  try {
    await pane.send({ type: 'avb:render', token: TOKEN, stamps: [] });
    await pane.send({ type: 'avb:hover-node', path: '0.1', occurrence: 0, token: TOKEN, boxes: [BOX] });
    assert.ok(outline('hover'), 'the hover outline is on screen after the one message');
    assert.equal(outline('hover').style.top, '20px');
    await pane.send({ type: 'avb:hover-node', path: undefined, occurrence: 0, token: TOKEN });
    assert.equal(outline('hover'), undefined, 'leaving the node takes it away');
  } finally {
    await pane.close();
  }
});

test('a click draws the selection outline while its judgement is still pending, and selects nothing yet', async () => {
  const held = heldJudge();
  const pane = await mount(held.judge);
  try {
    await pane.send({ type: 'avb:render', token: TOKEN, stamps: [] });
    await pane.send({ type: 'avb:click-node', path: '0.1', occurrence: 0, outside: false, x: 40, y: 60, token: TOKEN, boxes: [BOX] });
    assert.ok(outline('sel'), 'the clicked node is outlined as the selection before main has answered');
    assert.deepEqual(pane.seen.selected, [], 'a picture only: nothing is selected until the verdict');
    held.settle({ tag: 'current' });
    await pane.until(() => pane.seen.selected.length === 1, 'the selection');
    assert.deepEqual(pane.seen.selected, ['0.1']);
  } finally {
    await pane.close();
  }
});

test('a refused click takes its outline back', async () => {
  const held = heldJudge();
  const pane = await mount(held.judge, { answers: false });
  try {
    await pane.send({ type: 'avb:render', token: TOKEN, stamps: [] });
    await pane.send({ type: 'avb:click-node', path: '0.1', occurrence: 0, outside: false, x: 40, y: 60, token: TOKEN, boxes: [BOX] });
    assert.ok(outline('sel'));
    held.settle({ tag: 'stale', reason: 'superseded', file: undefined });
    await pane.until(() => outline('sel') === undefined, 'the outline to be taken back');
    assert.deepEqual(pane.seen.selected, [], 'a refused click selects nothing');
  } finally {
    await pane.close();
  }
});

test('a click that names nothing, or sits outside the file, draws no selection', async () => {
  const held = heldJudge();
  const pane = await mount(held.judge, { answers: false });
  try {
    await pane.send({ type: 'avb:render', token: TOKEN, stamps: [] });
    await pane.send({ type: 'avb:click-node', path: undefined, occurrence: 0, outside: false, x: 1, y: 1, token: TOKEN });
    await pane.send({ type: 'avb:click-node', path: '0.1', occurrence: 0, outside: true, x: 1, y: 1, token: TOKEN, boxes: [BOX] });
    assert.equal(outline('sel'), undefined);
  } finally {
    await pane.close();
  }
});

test('a click from a rendering no one vouched for draws no selection', async () => {
  const held = heldJudge();
  const pane = await mount(held.judge, { answers: false });
  try {
    await pane.send({ type: 'avb:render', token: TOKEN, stamps: [] });
    await pane.send({ type: 'avb:click-node', path: '0.1', occurrence: 0, outside: false, x: 1, y: 1, token: 'c'.repeat(64), boxes: [BOX] });
    assert.equal(outline('sel'), undefined);
  } finally {
    await pane.close();
  }
});
