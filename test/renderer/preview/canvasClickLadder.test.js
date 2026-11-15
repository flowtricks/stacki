// Goal: in the real canvas runtime, a click the preview-token gate refuses is
// recovered instead of reported (docs/canvas-click.md): a click on a rendering
// that moved on is looked at again and selects, a click while the canvas shows
// another page selects the page and says so once, a frame that cannot vouch
// for its rendering is reloaded once, and a hover is drawn even before the
// frame has vouched for any rendering.
// Methodology: mount the real PreviewPane in jsdom with the gate's own token
// rule as the judge, stand in for the frame by answering `avb:click-query`
// with an `avb:click-node` carrying `replay` and the current token, and read
// only what the pane hands the app: selections, notices and reloads. Waits are
// bounded polls on that observable state, never fixed sleeps on the outcome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/canvas-click-ladder');
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

const TOKEN_OLD = 'a'.repeat(64);
const TOKEN_NEW = 'b'.repeat(64);
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
  const shown = { token: TOKEN_OLD, path: '0.1' };
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

// The gate's first rule, as previewGate.ts applies it.
const tokenJudge = (rendered) => async (token) =>
  token !== undefined && token === rendered.token ? { tag: 'current' } : { tag: 'stale', reason: 'superseded', file: undefined };

test('a click on a rendering that moved on is looked at again and selects', async () => {
  const rendered = { token: TOKEN_OLD };
  const pane = await mount(tokenJudge(rendered));
  try {
    await pane.send({ type: 'avb:render', token: TOKEN_OLD, stamps: [] });
    // The page re-renders between the click and its verdict.
    rendered.token = TOKEN_NEW;
    pane.shown.token = TOKEN_NEW;
    pane.shown.path = '0.2';
    await pane.send({ type: 'avb:click-node', path: '0.1', occurrence: 0, outside: false, x: 40, y: 60, token: TOKEN_OLD });
    await pane.send({ type: 'avb:render', token: TOKEN_NEW, stamps: [] });
    await pane.until(() => pane.seen.selected.length > 0, 'the selection');
    assert.deepEqual(pane.seen.selected, ['0.2'], 'what is under the point now is selected, never the old path');
    assert.deepEqual(pane.queries.at(-1), { type: 'avb:click-query', id: pane.queries.at(-1).id, x: 40, y: 60 });
    assert.deepEqual(pane.seen.notices, [], 'no notice for a click that selected');
    assert.equal(pane.seen.reloads, 0);
  } finally {
    await pane.close();
  }
});

test('rapid clicks while the canvas re-renders coalesce into the last one', async () => {
  const rendered = { token: TOKEN_OLD };
  const pane = await mount(tokenJudge(rendered));
  try {
    await pane.send({ type: 'avb:render', token: TOKEN_OLD, stamps: [] });
    rendered.token = TOKEN_NEW;
    for (let index = 0; index < 5; index++) {
      await pane.send({ type: 'avb:click-node', path: '0.1', occurrence: 0, outside: false, x: index, y: index, token: TOKEN_OLD });
    }
    pane.shown.token = TOKEN_NEW;
    await pane.send({ type: 'avb:render', token: TOKEN_NEW, stamps: [] });
    await pane.until(() => pane.seen.selected.length > 0, 'the selection');
    await pane.send({ type: 'avb:modifiers', shiftKey: false, altKey: false }); // A beat for any late answer.
    assert.equal(pane.seen.selected.length, 1, 'one selection, the latest intent');
    assert.equal(pane.queries.at(-1).x, 4, 'looked at where the last click landed');
  } finally {
    await pane.close();
  }
});

test('a canvas showing another page selects the page and says so once', async () => {
  const pane = await mount(async () => ({ tag: 'stale', reason: 'unstamped-file', file: 'src/pages/index.astro' }));
  try {
    await pane.send({ type: 'avb:render', token: TOKEN_OLD, stamps: [] });
    for (let index = 0; index < 3; index++) {
      await pane.send({ type: 'avb:click-node', path: undefined, occurrence: 0, outside: false, x: 1, y: 1, token: TOKEN_OLD });
    }
    await pane.until(() => pane.seen.selected.length === 3, 'three selections');
    assert.deepEqual(pane.seen.selected, [undefined, undefined, undefined], 'each click selects what the open file owns: the page');
    assert.deepEqual(pane.seen.notices, [{ kind: 'show', notice: { kind: 'other-page', file: 'src/pages/index.astro' } }]);
  } finally {
    await pane.close();
  }
});

test('a frame that cannot vouch for a mixed rendering is reloaded once, and still shows hovers', async () => {
  const pane = await mount(tokenJudge({ token: TOKEN_OLD }));
  try {
    await pane.send({ type: 'avb:render-problem', problem: 'conflicting-stamps' });
    await pane.send({ type: 'avb:render-problem', problem: 'conflicting-stamps' });
    assert.equal(pane.seen.reloads, 1, 'one reload, not a loop');
    await pane.send({
      type: 'avb:rects',
      classes: {},
      spacing: {},
      rects: { 0.1: [{ x: 10, y: 20, w: 30, h: 40 }] },
    });
    await pane.send({ type: 'avb:hover-node', path: '0.1', occurrence: 0, token: undefined });
    await pane.send({
      type: 'avb:rects',
      classes: {},
      spacing: {},
      rects: { 0.1: [{ x: 10, y: 20, w: 30, h: 40 }] },
    });
    assert.ok(document.querySelector('.node-outline.hover'), 'the hover outline is drawn from the frame’s own boxes');
  } finally {
    await pane.close();
  }
});

test('a click on a canvas that never answers is reloaded, then told once', async () => {
  const pane = await mount(tokenJudge({ token: TOKEN_NEW }), { answers: false });
  try {
    await pane.send({ type: 'avb:render', token: TOKEN_NEW, stamps: [] });
    await pane.send({ type: 'avb:click-node', path: '0.1', occurrence: 0, outside: false, x: 1, y: 1, token: TOKEN_OLD });
    // Bounded by the ladder's own window (CANVAS_CLICK_LIMITS.retryWindowMs) plus its last look.
    await pane.until(() => pane.seen.reloads === 1, 'the reload', 2_000);
    assert.deepEqual(pane.seen.selected, [], 'nothing is selected from a rendering no one vouched for');
    assert.deepEqual(pane.seen.notices, [], 'the reload is the recovery; nothing to say yet');
  } finally {
    await pane.close();
  }
});
