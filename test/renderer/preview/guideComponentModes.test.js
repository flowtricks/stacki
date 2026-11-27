// Goal: while a component is open (its canvas, in place on a page at any depth, or its defaults
// page) the column guide is never drawn, not even for one commit, its toolbar button is gone and
// ⇧G does nothing; the saved preference is not written, and the guide is back on the next page.
// Methodology: check which editor states count as a component, then mount the real PreviewPane
// in jsdom over a stored visible guide, let the frame report its measurements, and switch the
// pane between a page and a component. A MutationObserver counts every guide element ever added
// while a component is the subject, and the metadata bridge counts every write. The test owns the
// clock (mock timers), so the guide's save delay has passed when it says so, on any machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/guide-component-modes');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as PreviewPane } from './src/features/preview/PreviewPane.tsx';",
      "export { desktopGuideSubject, studioGuideSubject } from './src/features/preview/guideSettings.ts';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'guide.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

// A frame and what follows it; then past the guide's 200 ms save delay.
const SETTLE_MS = 20;
const PAST_SAVE_MS = 260;
const SETTINGS = { visible: true, numbers: true, color: '#929292', opacity: 0.06, columns: { kind: 'automatic' }, columnDefaultsVersion: 1 };
const STORED = JSON.stringify({ version: 1, settings: SETTINGS });
const GUIDE_BUTTON = '.guide-btns:not(.is-interaction) button[aria-haspopup="dialog"]';
// The overlay and the button: all the guide ever draws. (The interact button shares only the button styling.)
const GUIDE_PARTS = `.guide-overlay, .guide-column, ${GUIDE_BUTTON}`;

test('every way of having a component open counts as a component, and a page does not', () => {
  const dom = installDOM();
  const { desktopGuideSubject, studioGuideSubject } = require(path.join(directory, 'guide.js'));
  dom.window.close();
  const page = { openFile: { kind: 'page', path: '/p/src/pages/index.astro' }, componentCanvas: 'idle', defaultsCanvas: 'idle' };
  assert.equal(desktopGuideSubject(page), 'page');
  assert.equal(desktopGuideSubject({ ...page, componentCanvas: undefined }), 'page');
  assert.equal(desktopGuideSubject({ ...page, openFile: undefined }), 'page');
  assert.equal(desktopGuideSubject({ ...page, openFile: { kind: 'route' } }), 'page');
  // The canvas is opening, or open: its own page, and anything opened inside it.
  assert.equal(desktopGuideSubject({ ...page, componentCanvas: 'opening' }), 'component');
  assert.equal(desktopGuideSubject({ ...page, componentCanvas: 'open' }), 'component');
  assert.equal(desktopGuideSubject({ ...page, defaultsCanvas: 'shown' }), 'component');
  // A component opened in place, at any depth.
  assert.equal(desktopGuideSubject({ ...page, openFile: { kind: 'component', path: '/p/src/components/Card.astro' } }), 'component');
  // The way back: the canvas has closed and its page has not been left yet.
  for (const left of ['/p/.stacki/canvas/a.astro', 'C:\\p\\.stacki\\canvas\\a.astro']) {
    assert.equal(desktopGuideSubject({ ...page, openFile: { kind: 'page', path: left } }), 'component');
  }
  assert.equal(studioGuideSubject('src/pages/index.astro'), 'page');
  assert.equal(studioGuideSubject('src/content/posts/a.md'), 'page');
  assert.equal(studioGuideSubject('src/components/Card.astro'), 'component');
  assert.equal(studioGuideSubject('src/layouts/Base.astro'), 'component');
  assert.equal(studioGuideSubject('.stacki/canvas/a.astro'), 'component');
});

test('Desktop and Studio tell the guide what they are editing', () => {
  const panes = fs.readFileSync(repoPath('src/app/shell/AppPanes.tsx'), 'utf8');
  assert.match(panes, /guideSubject=\{guideSubject\}/);
  const studio = fs.readFileSync(repoPath('studio/src/features/preview/PreviewCanvas.tsx'), 'utf8');
  assert.match(studio, /subject: studioGuideSubject\(props\.file\)/);
});

test('a component is never drawn with the guide, and the page gets it back as saved', async (context) => {
  const dom = installDOM();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  // Lets every settled promise run (setImmediate is not mocked), then moves the clock, then lets what that started run.
  const advanceClock = async (clockMs = SETTLE_MS) => {
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(clockMs);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const writes = [];
  dom.window.avb = bridge(writes);
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'guide.js'));
  const root = createRoot(document.getElementById('root'));
  const render = async (guideSubject) =>
    act(async () => {
      root.render(React.createElement(PreviewPane, { ...paneProps(), guideSubject }));
      await advanceClock();
    });
  const columns = () => document.querySelectorAll('.guide-column').length;
  const numbers = () => document.querySelectorAll('.guide-column-number').length;
  const guideButton = () => document.querySelector(GUIDE_BUTTON);
  const pressGuideShortcut = async () => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'G', shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      dom.window.dispatchEvent(event);
      await advanceClock(PAST_SAVE_MS);
    });
    return event;
  };
  const drawn = [];
  const observer = new dom.window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && (node.matches(GUIDE_PARTS) || node.querySelector(GUIDE_PARTS) !== null)) {
          drawn.push(node.className);
        }
      }
    }
  });
  try {
    await render('page');
    await reportMetrics(act, dom, advanceClock);
    assert.equal(columns(), 12, 'The saved guide is drawn over a page');
    assert.equal(numbers(), 12);
    assert.equal(guideButton() === null, false);

    await render('component');
    assert.equal(columns(), 0);
    assert.equal(numbers(), 0);
    assert.equal(guideButton() === null, true, 'No guide button over a component');
    observer.observe(document.getElementById('root'), { childList: true, subtree: true });
    await reportMetrics(act, dom, advanceClock, 900);
    const event = await pressGuideShortcut();
    assert.equal(event.defaultPrevented, false, 'The shortcut is not taken');
    assert.deepEqual(drawn, [], 'Nothing of the guide was added, even for one commit');
    assert.deepEqual(writes, [], 'The saved preference is untouched');

    // A pane that mounts on a component never draws it either, from its first commit.
    await act(async () => root.render(undefined));
    await render('component');
    await reportMetrics(act, dom, advanceClock);
    assert.deepEqual(drawn, []);
    observer.disconnect();

    await render('page');
    assert.equal(columns(), 12, 'The guide is back, with no keypress');
    assert.equal(numbers(), 12);
    assert.equal(guideButton() === null, false);
    assert.deepEqual(writes, []);
    // The shortcut works again on the page.
    await pressGuideShortcut();
    assert.equal(columns(), 0);
    assert.equal(writes.length, 1);
  } finally {
    observer.disconnect();
    await act(async () => root.unmount());
    dom.window.close();
  }
});

// The frame's measurements, as electron/preload/frameGuide.ts posts them.
async function reportMetrics(act, dom, advanceClock, viewportWidth = 1200) {
  const frame = document.querySelector('iframe');
  assert.equal(frame === null, false);
  await act(async () => {
    const data = { type: 'avb:guide', viewportWidth, rootFontSize: 16, margin: 32, gutter: 16, widthMax: 1100, variables: {}, counts: {} };
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: frame.contentWindow }));
    await advanceClock();
  });
}

// The preload bridge: the project's guide file is the stored one; every other call answers nothing.
function bridge(writes) {
  const known = {
    projectMetadata: async (input) =>
      input.kind === 'guide' ? { ok: true, value: { source: STORED } } : { ok: false, error: { code: 'missing', message: 'No such file' } },
    writeProjectMetadata: async (input) => {
      writes.push(input.write);
      return { ok: true, value: { source: input.write.source } };
    },
  };
  return new Proxy(known, {
    get: (target, name) => target[name] ?? (String(name).startsWith('on') ? () => () => {} : () => new Promise(() => {})),
  });
}

function paneProps() {
  return {
    devUrl: 'http://localhost:4321',
    route: '/',
    devStatus: 'on',
    crumbs: [],
    selPath: undefined,
    pathScope: '',
    focusPath: undefined,
    projectPath: '/fixture/project',
    device: 'desktop',
    onDevice() {},
    onEditRoute() {},
    judgeEvent: async () => ({ tag: 'current' }),
    onCanvasNotice() {},
  };
}

function installDOM() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'KeyboardEvent', 'localStorage']) {
    Object.defineProperty(global, key, { configurable: true, writable: true, value: key === 'window' ? window : window[key] });
  }
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.CSS = { supports: () => true };
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1600 });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 });
  return dom;
}
