// A drag in a layer popover never flips the look of a property label: neither its live writes nor
// the commit when it is released.
//
//   node test/renderer/style/liveLabelStable.test.js
//
// Goal: dragging a Drop shadow slider in the Filters popover made the blue labels around it
// ("2D & 3D transforms", "Filters") flash grey and back. The commit at the release raises the
// panel's busy flag once its save has run 300ms, and a natively disabled button is dimmed to 0.4
// by controls.css, so the pill went grey for as long as the save took. The invariant: from the
// press to well after the release, no property label changes class, native disabled state or the
// wrapper class that styles it. Inert while busy is still required, so a busy label refuses a press.
//
// Method: the real EmbedEditor is mounted in jsdom over a host shaped like Desktop's (StylePanel
// hostState), once over a page `<style is:global>` block (writeStyleNode changes the node on the
// next task, as the app's model reaches the panel on its next render) and once over a stylesheet
// whose writes take WRITE_MS, as an IPC round trip and the disk do, so the commit waits behind
// the live writes and the busy flag shows. A drag is dispatched pointer events on the Blur
// slider; every label's look is recorded after each mutation and animation frame, and every
// frame must equal the look before the press. Events are dispatched, never a real pointer;
// nothing is a real project.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { waitFor, waitForSteady } = require('../../helpers/waitFor.js');

const PAGE = '/p/src/pages/index.astro';
const SHEET_PATH = '/p/src/styles/site.css';
const SIZE = 240;
const BRIDGE_MS = 20; // The canvas answers this long after it is asked.
const DRAG_STEPS = 12; // Pointer moves in one drag, each its own live write.
const CSS_INITIAL = '\n  .plain {\n    transform: translateX(1rem);\n    filter: drop-shadow(1px 1px 2px red);\n  }\n';

let environment;

// The panel, its host setter and a jsdom window, set up once for the file.
async function panelEnvironment() {
  if (environment) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'live-label-stable.bundle.js');
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
  // The jsdom window has no pointer capture, and the slider only tracks a pointer it captured.
  const captured = new WeakMap();
  dom.window.Element.prototype.setPointerCapture = function (id) {
    captured.set(this, id);
  };
  dom.window.Element.prototype.releasePointerCapture = function () {
    captured.delete(this);
  };
  dom.window.Element.prototype.hasPointerCapture = function (id) {
    return captured.get(this) === id;
  };
  if (dom.window.PointerEvent === undefined) {
    dom.window.PointerEvent = class extends dom.window.MouseEvent {
      constructor(type, init = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? 'mouse';
      }
    };
  }
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  environment = { dom, React, createRoot, ...require(bundlePath) };
  return environment;
}

const classAttr = (value) => ({ type: 'string', value });
const styleNode = (inner) => ({ id: 'n9', kind: 'raw', name: 'style', props: { 'is:global': { type: 'bare' } }, inner });
const paragraph = { id: 'n1', kind: 'element', name: 'p', props: { class: classAttr('plain') }, children: [] };

// Mounts the panel with `.plain` declared in a page block (`where: 'node'`) or a stylesheet (`where: 'file'`).
async function mountPanel(where) {
  const { dom, React, createRoot, EmbedEditor, setHost, setCanvasFrame, receiveCanvasReply } = await panelEnvironment();
  const page = { css: where === 'node' ? CSS_INITIAL : '' };
  const sheetState = { css: where === 'file' ? CSS_INITIAL : '.other { color: blue; }' };
  const sheet = { rel: 'src/styles/site.css', name: 'site.css', path: SHEET_PATH, size: 100 };
  const writes = [];
  // A stylesheet write can be held, as a slow IPC round trip and disk hold it, until the test releases
  // it: the busy flag then shows for exactly as long as the test looks at it, on any runner.
  const hold = { active: false, calls: 0, pending: [] };
  const releaseWrites = () => {
    hold.active = false;
    for (const release of hold.pending.splice(0)) {
      release();
    }
  };
  const nodes = () => (where === 'node' ? [paragraph, styleNode(page.css)] : [paragraph]);
  const host = {
    projectPath: '/p',
    selectedId: 'n1',
    files: [sheet],
    astroFiles: [],
    openFilePath: PAGE,
    openFileKind: 'page',
    renderedClasses: ['plain'],
    pathOf: () => undefined,
    nodes: nodes(),
    historyTick: 0,
    // The app's setNodeText: the model with the edit reaches the panel on the app's next render.
    writeStyleNode: (target, css, immediate) => {
      assert.equal(target.nodeId, 'n9', 'the write is for the page block');
      page.css = css;
      hold.calls += 1;
      writes.push({ css, immediate });
      setTimeout(() => setHost({ nodes: nodes() }), 0);
      return true;
    },
  };
  dom.window.avb = {
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files: [sheet] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async () => ({ css: sheetState.css }),
    writeStyleFile: async (payload) => {
      hold.calls += 1;
      if (hold.active) {
        await new Promise((release) => hold.pending.push(release));
      }
      sheetState.css = payload.css;
      writes.push({ css: payload.css, immediate: true });
      return { ok: true };
    },
  };
  setCanvasFrame({
    postMessage: (message) => {
      if (message?.type !== 'avb:query') {
        return;
      }
      const matched = Object.fromEntries((message.selectors ?? []).map((selector) => [selector, selector === '.plain' || selector === 'p']));
      setTimeout(
        () =>
          receiveCanvasReply({
            id: message.id,
            found: true,
            identity: { tag: 'p', classes: ['plain'], attributes: {} },
            matched,
            computed: {},
            computedProps: {},
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
  // The first scan and the answers behind it: the Filters pill is blue and the panel stays put.
  await waitForSteady({
    what: 'the panel to scan the rule and show the Filters pill active',
    // Twenty-four equal polls (~1.2 s): the rescan that drops the previous test's page block lands in later tasks, and a write before it goes to that block.
    steadyPollCount: 24,
    read: () =>
      labelLooks(container)
        .find((label) => label.text === 'Filters')
        ?.className.includes('is-active') === true,
    until: (active) => active,
  });
  return { dom, container, writes, hold, releaseWrites, unmount: () => (root.unmount(), container.remove()) };
}

// Every property label's look: its text, its classes, whether it is natively disabled (which
// dims it), and the class of its wrapper. A flip in any of these repaints the label.
const LABEL_SELECTOR = '.u-field-label, .embed-editor_prop-orange';
function labelLooks(container) {
  return [...container.querySelectorAll(LABEL_SELECTOR)].map((label) => ({
    text: label.textContent.trim(),
    className: label.className,
    disabled: label.hasAttribute('disabled'),
    wrap: label.closest('.embed-editor_size-label, .embed-editor_prop-label')?.className ?? '',
  }));
}

// Records the labels after every mutation and every animation frame until stopped.
function recordLabels(dom, container) {
  const frames = [];
  const push = () => {
    const next = JSON.stringify(labelLooks(container));
    if (frames[frames.length - 1] !== next) {
      frames.push(next);
    }
  };
  push();
  const observer = new dom.window.MutationObserver(push);
  observer.observe(dom.window.document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  let sampling = true;
  const sample = () => {
    if (sampling) {
      push();
      dom.window.requestAnimationFrame(sample);
    }
  };
  dom.window.requestAnimationFrame(sample);
  return {
    stop() {
      sampling = false;
      observer.disconnect();
      push();
      return frames.map((text) => JSON.parse(text));
    },
  };
}

// The label of the Filters row, its first layer row, and the Blur slider once the popover is open.
function filtersRow(container) {
  const label = [...container.querySelectorAll('.u-field-label')].find((candidate) => candidate.textContent.trim() === 'Filters');
  assert.ok(label, 'the Filters row is shown');
  return label.closest('.embed-editor_type-shadows');
}

async function openFilterLayer(container) {
  const layer = filtersRow(container).querySelector('.embed-editor_bg-layer-main');
  assert.ok(layer, 'the Filters row lists its drop shadow');
  layer.click();
  const popover = await waitFor({
    what: 'the filter editor to open',
    read: () => document.querySelector('.embed-editor_filter-editor') ?? undefined,
    until: (found) => found !== undefined,
  });
  assert.ok(popover, 'the filter editor opened');
  const sliders = [...popover.querySelectorAll('.u-drag-slider')];
  assert.equal(sliders.length, 3, 'X, Y and Blur each have a slider');
  return sliders[2];
}

const pointerInit = (clientX) => ({ bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse', clientX });

// Lets every held save but the newest finish, one per poll, so the queue reaches the commit's save, which is the one kept held.
function drainAllButLast(panel) {
  if (panel.hold.pending.length > 1) {
    panel.hold.pending.shift()();
  }
  return false;
}

const filtersBusy = (container) => filtersRow(container).querySelector('.u-field-label.is-active')?.getAttribute('aria-disabled') === 'true';

// Moves the slider to `clientX`, then again on each poll, until the panel has issued one more write: the slider
// drops a frame's write that lands inside its throttle window, so a later move at the same spot is the retry.
async function moveUntilWritten(panel, slider, clientX) {
  const callsBefore = panel.hold.calls;
  await waitFor({
    what: 'the slider to write live',
    read: () => {
      slider.dispatchEvent(new panel.dom.window.PointerEvent('pointermove', pointerInit(clientX)));
      return panel.hold.calls;
    },
    until: (calls) => calls > callsBefore,
  });
}

// Presses the slider, moves it DRAG_STEPS times, each once the previous move has written, releases it,
// and records the labels from the press until the commit has settled.
async function drag(panel, slider) {
  const { dom, container } = panel;
  const init = pointerInit;
  const recorder = recordLabels(dom, container);
  slider.dispatchEvent(new dom.window.PointerEvent('pointerdown', init(10)));
  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    await moveUntilWritten(panel, slider, 10 + step * 10);
  }
  slider.dispatchEvent(new dom.window.PointerEvent('pointerup', init(10 + (DRAG_STEPS + 1) * 10)));
  await waitForSteady({
    what: 'the commit, its saves and the refresh behind them to settle',
    read: () => ({ writes: panel.writes.length, busy: filtersBusy(container), looks: labelLooks(container) }),
    until: (state) => !state.busy,
  });
  return { frames: recorder.stop(), after: labelLooks(container) };
}

for (const where of ['node', 'file']) {
  test(`a drag in the filter popover keeps every label as it was (${where === 'node' ? 'page style block' : 'stylesheet'})`, async (context) => {
    const panel = await mountPanel(where);
    context.after(panel.unmount);
    const slider = await openFilterLayer(panel.container);
    const before = labelLooks(panel.container);
    const filters = before.find((label) => label.text === 'Filters');
    assert.ok(filters?.className.includes('is-active'), 'the Filters label is the blue pill: the rule sets a filter');
    const transforms = before.find((label) => label.text === '2D & 3D transforms');
    assert.ok(transforms?.className.includes('is-active'), 'and so is the transforms label above it');
    const writesBefore = panel.writes.length;
    const { frames, after } = await drag(panel, slider);
    assert.ok(panel.writes.length - writesBefore > 2, 'the drag wrote live, then committed');
    assert.match(panel.writes.at(-1).css, /drop-shadow\(1px 1px (?!2px)\d+px red\)/, 'the last write carries the dragged blur');
    const changed = frames.findIndex((frame) => JSON.stringify(frame) !== JSON.stringify(before));
    const flipped = changed === -1 ? [] : frames[changed].filter((label, index) => JSON.stringify(label) !== JSON.stringify(before[index]));
    assert.deepEqual(flipped, [], `no label changed from the press to the settled commit (frame ${changed} of ${frames.length})`);
    assert.deepEqual(after, before, 'and the commit leaves them as they were: the same properties are set');
  });
}

test('a busy label is inert: a press on the blue pill while the commit saves opens no menu', async (context) => {
  const panel = await mountPanel('file');
  context.after(panel.unmount);
  const slider = await openFilterLayer(panel.container);
  const init = pointerInit;
  // Saves are held from the press, so the commit's save runs behind them and the busy flag has something to wait on.
  panel.hold.active = true;
  slider.dispatchEvent(new panel.dom.window.PointerEvent('pointerdown', init(10)));
  await moveUntilWritten(panel, slider, 60);
  slider.dispatchEvent(new panel.dom.window.PointerEvent('pointerup', init(60)));
  // Past the busy delay, inside the commit's held save.
  await waitFor({
    what: 'the commit to raise the busy flag',
    read: () => drainAllButLast(panel) || filtersBusy(panel.container),
    until: (busy) => busy,
  });
  const label = filtersRow(panel.container).querySelector('.u-field-label.is-active');
  assert.equal(label.getAttribute('aria-disabled'), 'true', 'the pill says it is unavailable while the commit saves');
  assert.equal(label.hasAttribute('disabled'), false, 'without the native disabled that dims it');
  label.click();
  assert.equal(document.querySelector('.u-field-label-menu') ?? undefined, undefined, 'the press opened no Clear menu');
  panel.releaseWrites();
  await waitFor({ what: 'the save to finish', read: () => label.hasAttribute('aria-disabled'), until: (disabled) => !disabled });
  assert.equal(label.hasAttribute('aria-disabled'), false, 'and it takes presses again once the save is done');
});
