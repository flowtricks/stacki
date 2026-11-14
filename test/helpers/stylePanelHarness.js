// Goal: one harness for every Style panel race test. It mounts the real StylePanel in jsdom
// over a host like Desktop's, answers the canvas with a fake bridge the test can hold back,
// release in any order and inspect, and records what the panel painted and which popovers
// opened and closed, so a test can assert that no frame shows a wrong or passing state and that
// no popover closes without a user action.
//
// Method:
// - The canvas bridge answers `avb:query` messages from a fixture document (a second jsdom
//   built from the fixture markup), so selector matching is Chromium-like `Element.matches`,
//   not a hand-written guess. In `immediate` mode it answers on the next macrotask; in `held`
//   mode every reply waits in a queue until the test releases it, FIFO, reversed or shuffled
//   by a seed. The page's "classes rendered" report after a selection rides the same queue.
// - `settle()` waits until the DOM has been quiet for a few macrotasks and frames (bounded),
//   never for a fixed wall-clock time a slow runner could miss.
// - `recordFrames(project)` samples a projection of the panel after every DOM mutation and
//   every animation frame; `assertDirect(frames, ...)` checks that the frames go straight from
//   placeholders (if any) to the final state, never through another state or back.
// - `popovers` records each popover's open and close with the step that was running: a user
//   step (`user(label, fn)`) may close one; a data step (`data(label, fn)`) never may.
// Everything is driven by dispatched events: no real pointer, no real hover, no timing
// thresholds. Fixtures only: the project path is fake and nothing touches a real project.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('./sources.js');

const SIZE_PX = 240;
const SETTLE_QUIET_TICKS = 4;
const SETTLE_TICKS_MAX = 400;
const POPOVER_SELECTOR = '[role="menu"],[role="listbox"],[role="dialog"],.embed-editor_varpicker';

let environment;

// The bundle and jsdom window, built once per test process.
async function panelEnvironment() {
  if (environment) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, `style-panel-harness-${process.pid}.bundle.js`);
  await esbuild.build({
    stdin: {
      contents: [
        `export { default as StylePanel } from './src/features/style/StylePanel'`,
        `export { setHost, getHost } from './src/features/style/model/host'`,
        `export { setCanvasFrame, receiveCanvasReply } from './src/editor/canvasQuery'`,
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty', '.svg': 'text' },
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  installGlobals(dom);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const bundle = require(bundlePath);
  fs.rmSync(bundlePath, { force: true });
  environment = { dom, React, act, createRoot, ...bundle };
  return environment;
}

function installGlobals(dom) {
  const window = dom.window;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
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
  window.ResizeObserver = Observer;
  window.Element.prototype.scrollIntoView = function () {};
  // eslint-disable-next-line stacki/no-null -- Stubs the platform getContext, which answers null.
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: SIZE_PX, bottom: SIZE_PX, width: SIZE_PX, height: SIZE_PX });
  require('./popupDom.js').installPopupDOM(window);
}

// A small deterministic generator (mulberry32), so a failing shuffle names its seed.
function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

/**
 * Mounts the panel. `fixture` is `{ sheets: [{ rel, css }], nodes, markup, selectedId }`:
 * `nodes` is the page model (ids are the canvas paths), `markup` is the HTML the fake canvas
 * renders, each element carrying `data-avb-p="<id>"`.
 */
async function mountStylePanel(fixture) {
  const env = await panelEnvironment();
  const { dom, React, createRoot, StylePanel, setCanvasFrame, receiveCanvasReply } = env;
  const { JSDOM } = require('jsdom');
  const page = new JSDOM(`<!doctype html><body>${fixture.markup}</body>`);
  const sheets = fixture.sheets.map((sheet) => ({
    rel: sheet.rel,
    name: path.posix.basename(sheet.rel),
    path: `/fixture/${sheet.rel}`,
    size: sheet.css.length,
    css: sheet.css,
  }));
  const sheetByPath = new Map(sheets.map((sheet) => [sheet.path, sheet]));
  const writes = [];
  dom.window.avb = {
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files: sheets.map(({ rel, name, path: sheetPath, size }) => ({ rel, name, path: sheetPath, size })) }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async (payload) => {
      const sheetPath = typeof payload === 'string' ? payload : (payload?.path ?? payload?.filePath ?? '');
      const sheet = sheetByPath.get(sheetPath) ?? sheets[0];
      return { css: sheet.css };
    },
    writeStyleFile: async (payload) => {
      writes.push(payload);
      const sheet = sheetByPath.get(payload?.path ?? payload?.filePath ?? '');
      if (sheet && typeof payload?.css === 'string') {
        sheet.css = payload.css;
      }
      return { ok: true };
    },
  };

  const bridge = createBridge(page, receiveCanvasReply);
  setCanvasFrame({ postMessage: (message) => bridge.receive(message) });

  const container = document.createElement('div');
  container.className = 'harness-scroll';
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    project: { path: '/fixture' },
    model: { nodes: fixture.nodes },
    node: { id: fixture.selectedId },
    pathOf: (id) => id,
    openFilePath: '/fixture/src/pages/index.astro',
    openFileKind: 'page',
    renderedClasses: classesOf(page, fixture.selectedId),
    renderedClassesKnown: true,
  };
  let current = props;
  const render = (next) => {
    current = next;
    root.render(React.createElement(StylePanel, next));
  };
  render(props);
  const popovers = createPopoverLog(dom.window);
  const panel = {
    dom,
    window: dom.window,
    container,
    bridge,
    writes,
    popovers,
    get props() {
      return current;
    },
    rerender: (patch) => render({ ...current, ...patch }),
    /** Selects another element the way Desktop does: classes unknown first, reported a moment later through the bridge queue. */
    select(id) {
      render({ ...current, node: { id }, renderedClasses: [], renderedClassesKnown: false });
      bridge.enqueue(`classes report for ${id}`, () => render({ ...current, node: { id }, renderedClasses: classesOf(page, id), renderedClassesKnown: true }));
    },
    settle: () => settle(container),
    user: (label, action) => popovers.step({ label, cause: 'user' }, action, () => settle(container)),
    data: (label, action) => popovers.step({ label, cause: 'data' }, action, () => settle(container)),
    unmount() {
      popovers.stop();
      root.unmount();
      container.remove();
      setCanvasFrame(undefined);
    },
  };
  await settle(container);
  return panel;
}

function classesOf(page, id) {
  const element = page.window.document.querySelector(`[data-avb-p="${id}"]`);
  return element ? [...element.classList] : [];
}

// The canvas. Each query is answered from the fixture document; replies wait in `held` mode.
function createBridge(page, receiveCanvasReply) {
  const queue = [];
  const bridge = {
    mode: 'immediate',
    queries: 0,
    answered: [],
    get held() {
      return queue.length;
    },
    receive(message) {
      if (message?.type !== 'avb:query') {
        return;
      }
      bridge.queries += 1;
      const reply = answer(page, message);
      bridge.enqueue(`reply ${message.id} for ${message.path}`, () => receiveCanvasReply(reply));
    },
    enqueue(label, deliver) {
      if (bridge.mode === 'immediate') {
        setTimeout(() => {
          bridge.answered.push(label);
          deliver();
        }, 0);
        return;
      }
      queue.push({ label, deliver });
    },
    /** Delivers every held item: `order` is 'fifo', 'reverse' or 'shuffle' (with `seed`). */
    release({ order = 'fifo', seed = 1, count = Infinity } = {}) {
      const ordered = order === 'reverse' ? [...queue].reverse() : order === 'shuffle' ? shuffled(queue, seededRandom(seed)) : [...queue];
      const chosen = ordered.slice(0, count);
      for (const item of chosen) {
        queue.splice(queue.indexOf(item), 1);
        bridge.answered.push(item.label);
        item.deliver();
      }
      return chosen.length;
    },
  };
  return bridge;
}

function answer(page, message) {
  const element = page.window.document.querySelector(`[data-avb-p="${message.path}"]`);
  if (!element) {
    return { id: message.id, found: false };
  }
  const matched = {};
  for (const selector of message.selectors ?? []) {
    try {
      matched[selector] = element.matches(selector);
    } catch {
      matched[selector] = false;
    }
  }
  const attributes = {};
  for (const attribute of element.attributes) {
    if (attribute.name !== 'class' && attribute.name !== 'id') {
      attributes[attribute.name] = attribute.value;
    }
  }
  return {
    id: message.id,
    found: true,
    identity: { tag: element.tagName.toLowerCase(), ...(element.id ? { id: element.id } : {}), classes: [...element.classList], attributes },
    matched,
    computed: {},
    computedProps: {},
  };
}

// Waits until the DOM under `root` and the popup layer have been quiet for a few ticks.
async function settle(root) {
  const target = root.ownerDocument.body;
  let mutations = 0;
  const observer = new window.MutationObserver((records) => {
    mutations += records.length;
  });
  observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
  let quiet = 0;
  try {
    for (let tick = 0; tick < SETTLE_TICKS_MAX && quiet < SETTLE_QUIET_TICKS; tick += 1) {
      const before = mutations;
      await macrotask();
      await frame();
      await macrotask();
      quiet = mutations === before ? quiet + 1 : 0;
    }
  } finally {
    observer.disconnect();
  }
}

// Every popover's open and close, with the step that was running when it happened.
function createPopoverLog(window) {
  const document = window.document;
  const open = new Map();
  const events = [];
  let current = { label: 'mount', cause: 'data' };
  const scan = () => {
    const now = new Set(document.querySelectorAll(POPOVER_SELECTOR));
    for (const element of now) {
      if (!open.has(element) && element.getAttribute('data-popup-phase') !== 'closing') {
        const name = describe(element);
        open.set(element, name);
        events.push({ kind: 'open', name, step: current.label, cause: current.cause });
      }
    }
    for (const [element, name] of open) {
      if (!now.has(element) || element.getAttribute('data-popup-phase') === 'closing') {
        open.delete(element);
        events.push({ kind: 'close', name, step: current.label, cause: current.cause });
      }
    }
  };
  const observer = new window.MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-popup-phase'] });
  return {
    events,
    /** The popovers on screen now, by name. */
    openNames: () => [...open.values()],
    /** Every close a data step caused: each is a popover that closed without a user action. */
    spontaneousCloses: () => events.filter((event) => event.kind === 'close' && event.cause === 'data'),
    async step(next, action, settleAfter) {
      scan();
      current = next;
      try {
        await action();
        await settleAfter();
        scan();
      } finally {
        current = { label: `after ${next.label}`, cause: 'data' };
      }
    },
    stop: () => observer.disconnect(),
  };
}

function describe(element) {
  const role = element.getAttribute('role') ?? 'popover';
  const label = element.getAttribute('aria-label') ?? element.className.split(' ').find((name) => name && name !== 'popup-surface') ?? '';
  return `${role}:${label}`;
}

/**
 * Samples `project(container)` after every mutation and every animation frame until `stop()`.
 * Consecutive equal frames are folded; the result is the list of distinct painted states.
 */
function recordFrames(panel, project) {
  const frames = [];
  const push = () => {
    const next = JSON.stringify(project(panel.container));
    if (frames[frames.length - 1] !== next) {
      frames.push(next);
    }
  };
  push();
  const observer = new panel.window.MutationObserver(push);
  observer.observe(panel.window.document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  let sampling = true;
  const sample = () => {
    if (sampling) {
      push();
      panel.window.requestAnimationFrame(sample);
    }
  };
  panel.window.requestAnimationFrame(sample);
  return {
    stop() {
      sampling = false;
      observer.disconnect();
      push();
      return frames.map((text) => JSON.parse(text));
    },
  };
}

/**
 * The frames went straight to their last state: every earlier frame is a placeholder (by
 * `isPlaceholder`) or already equal to the last, and once a non-placeholder state shows, no
 * later frame differs from it. Returns a message naming the first offending frame, or undefined.
 */
function directFailure(frames, isPlaceholder) {
  if (frames.length === 0) {
    return 'no frames were recorded';
  }
  const last = JSON.stringify(frames[frames.length - 1]);
  let shown = false;
  for (const [index, frame] of frames.entries()) {
    const text = JSON.stringify(frame);
    if (isPlaceholder(frame)) {
      if (shown) {
        return `frame ${index} went back to a placeholder after content showed: ${text}`;
      }
      continue;
    }
    if (text !== last) {
      return `frame ${index} painted a passing state ${text}, final ${last}`;
    }
    shown = true;
  }
  return undefined;
}

// Dispatched input. A click is the whole press: pointerdown, mousedown, mouseup, click.
function press(panel, target, options = {}) {
  const { window } = panel;
  const init = { bubbles: true, cancelable: true, button: 0, altKey: options.altKey === true };
  target.dispatchEvent(new window.PointerEvent('pointerdown', init));
  target.dispatchEvent(new window.MouseEvent('mousedown', init));
  target.dispatchEvent(new window.MouseEvent('mouseup', init));
  target.dispatchEvent(new window.MouseEvent('click', init));
}

function key(panel, target, name, options = {}) {
  const { window } = panel;
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options }));
  target.dispatchEvent(new window.KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true, ...options }));
}

// The row of a section field by its caption text ("Weight", "Font", …).
function fieldRow(panel, caption) {
  const labels = [...panel.container.querySelectorAll('.u-field-label, .embed-editor_prop-label, label')];
  const label = labels.find((element) => element.textContent.trim() === caption);
  return label?.closest('.embed-editor_size-row') ?? undefined;
}

module.exports = { mountStylePanel, recordFrames, directFailure, press, key, fieldRow, seededRandom, settle };
