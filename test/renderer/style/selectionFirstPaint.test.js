// Switching elements never paints the plain default fields before the variable chips.
//
// Goal: with the Style panel open on element A, selecting element B (whose rule gives
// font-family, font-weight, font-size, line-height, letter-spacing and text-transform
// variable values) must never put a plain-field editor for those properties on screen:
// no "Default" Font or Weight dropdown, no literal value, from the selection event until the
// chips are there. While the new element is being read the Typography section draws
// placeholders in the fields' shape; when the answer lands the chips replace them.
// Method: the real EmbedEditor is mounted in jsdom over a host like Desktop's, with the
// stylesheet read held back 200 ms (the bridge reply, artificially slow). A MutationObserver
// samples the typography rows after every DOM change from the selection event to the end, and
// the frames are asserted: never a plain editor for a variable-connected property, a
// placeholder while waiting, the chips once it lands. No pointer is used; the fixture is a
// stylesheet in memory, never a real project.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const PAGE = '/p/src/pages/index.astro';
const DELAY_MS = 200;
const CSS = `
:root { --display-font-family: "Inter", sans-serif; --display-font-weight: 500; --text-size: 1.25rem; --lh: 1.2; --ls: 0.02em; --tt: uppercase; }
.plain { color: red; }
.big { color: blue; }
.heading { font-family: var(--display-font-family); font-weight: var(--display-font-weight); font-size: var(--text-size); line-height: var(--lh); letter-spacing: var(--ls); text-transform: var(--tt); }
`;

const SIZE = 240;
let environment;

// The panel, its host setter and a jsdom window, set up once for the file.
async function panelEnvironment() {
  if (environment) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'selection-first-paint.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as EmbedEditor } from './src/features/style/EmbedEditor'\nexport { setHost, getHost } from './src/features/style/model/host'\nexport { subscribeErrorToasts } from './src/ui/errorNotices'\nexport { setCanvasFrame, receiveCanvasReply } from './src/editor/canvasQuery'`,
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
const div = (id, classes) => ({ id, kind: 'element', name: 'div', props: classes ? { class: classAttr(classes) } : {}, children: [] });

async function mountPanel() {
  const { dom, React, createRoot, EmbedEditor, setHost, setCanvasFrame, receiveCanvasReply } = await panelEnvironment();
  const sheet = { rel: 'src/styles/site.css', name: 'site.css', path: '/p/src/styles/site.css', size: CSS.length };
  const state = { nodes: [div('n1', 'plain'), { id: 'n2', kind: 'element', name: 'div', props: { class: { type: 'expr', value: 'cls' } }, children: [] }] };
  const host = {
    projectPath: '/p',
    selectedId: 'n1',
    files: [sheet],
    astroFiles: [],
    openFilePath: PAGE,
    openFileKind: 'page',
    renderedClasses: ['plain'],
    pathOf: (id) => id,
    ...state,
  };
  dom.window.avb = {
    onCssChanged: () => () => {},
    listStyleFiles: async () => ({ files: [sheet] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async () => {
      await wait(globalThis.__delayMs ?? 0);
      return { css: CSS };
    },
    writeStyleFile: async () => ({ ok: true }),
  };
  globalThis.__delayMs = 0;
  // The canvas bridge: answers each question after the delay the test sets, saying the element
  // carries the class of the node it is asked about and that every asked selector naming it matches.
  const classOf = { n1: 'plain', n2: 'heading big' };
  setCanvasFrame({
    postMessage: (message) => {
      if (message?.type !== 'avb:query') {
        return;
      }
      const className = classOf[message.path] ?? '';
      const matched = Object.fromEntries(
        (message.selectors ?? []).map((selector) => [selector, className.split(' ').some((name) => selector === `.${name}`) || selector === 'div']),
      );
      setTimeout(
        () =>
          receiveCanvasReply({
            id: message.id,
            found: true,
            identity: { tag: 'div', classes: [className], attributes: {} },
            matched,
            computed: {},
            computedProps: {},
          }),
        globalThis.__delayMs ?? 0,
      );
    },
  });
  setHost(host);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(React.createElement(EmbedEditor));
  await wait(1200);
  // The page reports which classes the new element renders a moment after the selection moves.
  const current = { id: 'n1', classes: 'plain' };
  const select = (id, classes) => {
    current.id = id;
    current.classes = classes;
    setHost({ ...host, selectedId: id, renderedClasses: [] });
    setTimeout(() => setHost({ ...host, selectedId: id, renderedClasses: classes.split(' ') }), globalThis.__delayMs ?? 0);
  };
  const refresh = () => setHost({ ...host, selectedId: current.id, renderedClasses: current.classes.split(' ') });
  return { dom, container, select, refresh, unmount: () => (root.unmount(), container.remove()) };
}

// What the typography rows show right now: a placeholder, plain editors, or variable chips.
function frameOf(container) {
  const section = [...container.querySelectorAll('section, .embed-editor_section')].find((node) => /Typography/i.test(node.textContent ?? ''));
  const scope = section ?? container;
  return {
    placeholders: scope.querySelectorAll('.ui-skeleton').length,
    chips: scope.querySelectorAll('[data-chip]').length,
    defaults: [...scope.querySelectorAll('button, [role="combobox"], select')].filter((node) => /^\s*Default\s*$/.test(node.textContent ?? '')).length,
    text: (scope.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200),
  };
}

const pointer = (panel, type, target) => target.dispatchEvent(new panel.dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));

test('selecting a variable-styled element never paints plain fields first', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  globalThis.__delayMs = DELAY_MS;
  const frames = [];
  const startedAt = Date.now();
  const observer = new panel.dom.window.MutationObserver(() => frames.push({ at: Date.now() - startedAt, ...frameOf(panel.container) }));
  observer.observe(panel.container, { childList: true, subtree: true, attributes: true, characterData: true });
  panel.select('n2', 'heading big');
  await wait(DELAY_MS + 900);
  observer.disconnect();
  for (const frame of frames) {
    console.log(JSON.stringify({ at: frame.at, placeholders: frame.placeholders, chips: frame.chips, defaults: frame.defaults }));
  }
  assert.ok(frames.length > 0, 'the panel changed');
  assert.ok(
    frames.every((frame) => frame.defaults === 0),
    'no Default dropdown is ever drawn for the new element',
  );
  assert.ok(
    frames.every((frame) => frame.placeholders > 0 || frame.chips > 0),
    'every frame is a placeholder or the chips, never plain fields',
  );
  assert.ok(frames[0].placeholders > 0 && frames[0].chips === 0, 'the first frame after the selection is the placeholder');
  assert.ok(
    frames.some((frame) => frame.at < DELAY_MS && frame.chips === 0),
    'the placeholder holds until the answer',
  );
  const last = frames[frames.length - 1];
  assert.ok(last.chips >= 6 && last.placeholders === 0, `the chips replace it: ${JSON.stringify(last)}`);
  assert.ok(
    frames.every((frame) => frame.chips === 0 || frame.chips >= 6),
    'the chips arrive together, not in steps',
  );
});

// The Weight row's variable control: its chip.
const weightChip = (container) => container.querySelector('[data-chip]') ?? undefined;

async function openWeightPicker(panel) {
  const chip = weightChip(panel.container);
  assert.ok(chip, 'a chip is drawn');
  pointer(panel, 'mousedown', chip);
  await wait(60);
  return document.querySelector('.embed-editor_varpicker') ?? undefined;
}

test('a dropdown opened after the answer stays open through a data refresh, keeps its text, and closes on an outside press', async (context) => {
  const panel = await mountPanel();
  context.after(panel.unmount);
  globalThis.__delayMs = DELAY_MS;
  panel.select('n2', 'heading big');
  assert.ok(weightChip(panel.container) === undefined, 'before the answer there is no control to open: only placeholders');
  await wait(DELAY_MS + 700);
  const picker = await openWeightPicker(panel);
  assert.ok(picker, 'the dropdown opened');
  const search = picker.querySelector('.embed-editor_varpicker-search');
  assert.ok(search, 'it has a search box');
  search.focus();
  Object.getOwnPropertyDescriptor(panel.dom.window.HTMLInputElement.prototype, 'value').set.call(search, 'disp');
  search.dispatchEvent(new panel.dom.window.Event('input', { bubbles: true }));
  await wait(40);
  // The reply for the same element lands again while it is open: a refresh of the same data.
  panel.refresh();
  await wait(DELAY_MS + 400);
  const after = document.querySelector('.embed-editor_varpicker') ?? undefined;
  assert.ok(after, 'the dropdown is still open after the refresh');
  assert.ok(after === picker, 'and it is the same menu node');
  assert.ok(after.querySelector('.embed-editor_varpicker-search') === search, 'with the same search box');
  assert.equal(search.value, 'disp', 'its typed text is kept');
  assert.ok(document.activeElement === search, 'and focus stays in it');
  pointer(panel, 'pointerdown', document.body);
  pointer(panel, 'mousedown', document.body);
  pointer(panel, 'mouseup', document.body);
  pointer(panel, 'click', document.body);
  // The popup leaves with a short exit motion; wait for it, bounded.
  for (let attempt = 0; attempt < 40 && document.querySelector('.embed-editor_varpicker') !== null; attempt += 1) {
    await wait(50);
  }
  assert.ok(document.querySelector('.embed-editor_varpicker') === null, 'a real outside press closes it');
});
