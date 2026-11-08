// Goal: switching the selection swaps the selector well's chips in one step.
// Selecting another element fills the well in stages: the model is blanked, the
// source-known selectors land, then the canvas's answer, then the default pick a
// render later. In the Studio demo the hero paragraph → heading switch drew
// `.text* …` → `:target :focus-visible` → `.heading …` → `.heading* …`: a flicker
// on every click. The well must show only the previous element's finished list or
// the next element's finished list, never a stage in between.
// Method: mount the real SelectorPicker in jsdom and feed it the exact prop
// sequence the panel produces on a switch (ScanState.settled false while blanked
// and while only partly resolved). A MutationObserver records every distinct chip
// list the DOM ever holds, so a state that lasts a single render is caught. Then
// the edges: deselecting outside a switch shows at once, a click on a held chip
// does nothing, and a resolve that never settles is shown after the hold's cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'selector-well-switch.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { SelectorPicker } from './src/features/style/EmbedEditor';",
      "export { SELECTION_HOLD_MS_MAX, holdDecision, selectionReady } from './src/features/style/embed/heldSelection';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.Window = dom.window.Window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.ResizeObserver = dom.window.ResizeObserver;
const stored = new Map();
global.localStorage = {
  getItem: (key) => stored.get(key),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { SelectorPicker, SELECTION_HOLD_MS_MAX, holdDecision, selectionReady } = require(bundle);

const chip = (text) => ({ text, specificity: [0, 1, 0], state: '', simple: true, key: text, inContext: true, fromComponent: false });
const PARAGRAPH = ['.text', '.text-style-large', ':target', ':focus-visible', 'p'].map(chip);
const HEADING = ['.heading', '.text-style-display', ':target', ':focus-visible', 'h1'].map(chip);
const GLOBALS_ONLY = [':target', ':focus-visible'].map(chip);

const root = createRoot(document.getElementById('root'));
let picks = [];
const show = (props) =>
  act(async () => {
    root.render(
      React.createElement(SelectorPicker, {
        selectors: [],
        suggestions: [],
        activeSelector: '',
        activePicked: false,
        busy: false,
        loading: false,
        settled: true,
        onSelect: (selector) => picks.push(selector),
        onDeselect: () => picks.push('<deselect>'),
        onAdd: () => {},
        ...props,
      }),
    );
  });
const wellText = () =>
  [...document.querySelectorAll('.embed-editor_selector-chip')]
    .map((element) => element.textContent + (element.classList.contains('is-active') ? '*' : ''))
    .join(' ');

function record() {
  const seen = [];
  const note = () => {
    const text = wellText();
    if (seen.at(-1) !== text) {
      seen.push(text);
    }
  };
  const observer = new dom.window.MutationObserver(note);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  note();
  return {
    seen,
    stop: () => {
      note();
      observer.disconnect();
    },
  };
}

test('a selection switch draws the previous list, then the next one, and nothing between', async () => {
  await show({ selectors: PARAGRAPH, activeSelector: '.text' });
  const paragraph = wellText();
  assert.equal(paragraph, '.text* .text-style-large :target :focus-visible p');
  const recording = record();
  // The panel's stages on a switch (useElementReset, then applyResolve).
  await show({ selectors: [], activeSelector: '', settled: false, loading: true });
  await show({ selectors: GLOBALS_ONLY, activeSelector: '', settled: false, loading: true });
  await show({ selectors: HEADING, activeSelector: '', settled: false, loading: true });
  await show({ selectors: HEADING, activeSelector: '', settled: true });
  await show({ selectors: HEADING, activeSelector: '.heading', settled: true });
  recording.stop();
  assert.deepEqual(recording.seen, [paragraph, '.heading* .text-style-display :target :focus-visible h1']);
});

test('a click on a held chip picks nothing for the new element', async () => {
  await show({ selectors: PARAGRAPH, activeSelector: '.text' });
  await show({ selectors: [], activeSelector: '', settled: false, loading: true });
  picks = [];
  const held = [...document.querySelectorAll('.embed-editor_selector-chip')].find((element) => element.textContent === 'p');
  assert.ok(held, 'the held list is drawn');
  await act(async () => held.click());
  assert.deepEqual(picks, []);
  await show({ selectors: HEADING, activeSelector: '.heading', settled: true });
  const live = [...document.querySelectorAll('.embed-editor_selector-chip')].find((element) => element.textContent === 'h1');
  await act(async () => live.click());
  assert.deepEqual(picks, ['h1']);
});

test('outside a switch, deselecting shows every chip unhighlighted at once', async () => {
  await show({ selectors: HEADING, activeSelector: '.heading', settled: true });
  await show({ selectors: HEADING, activeSelector: '', settled: true });
  assert.equal(wellText(), '.heading .text-style-display :target :focus-visible h1');
});

test('the first selection, with nothing settled before it, shows its stages', async () => {
  await act(async () => root.unmount());
  const fresh = createRoot(document.getElementById('root'));
  await act(async () => {
    fresh.render(
      React.createElement(SelectorPicker, {
        selectors: GLOBALS_ONLY,
        suggestions: [],
        activeSelector: '',
        activePicked: false,
        busy: false,
        loading: true,
        settled: false,
        onSelect: () => {},
        onDeselect: () => {},
        onAdd: () => {},
      }),
    );
  });
  assert.equal(wellText(), ':target :focus-visible');
  await act(async () => fresh.unmount());
});

test('the hold is capped: a resolve that never settles is shown after SELECTION_HOLD_MS_MAX', () => {
  const last = { selectors: PARAGRAPH, activeSelector: '.text', activePicked: false };
  const held = holdDecision({ ready: false, last, holdStartMs: 1000, nowMs: 1000 + SELECTION_HOLD_MS_MAX - 1 });
  assert.equal(held.kind, 'hold');
  assert.equal(held.view, last);
  assert.equal(held.remainingMs, 1);
  assert.equal(holdDecision({ ready: false, last, holdStartMs: 1000, nowMs: 1000 + SELECTION_HOLD_MS_MAX }).kind, 'show');
  assert.equal(holdDecision({ ready: true, last, holdStartMs: 1000, nowMs: 1001 }).kind, 'show');
  assert.equal(holdDecision({ ready: false, last: undefined, holdStartMs: undefined, nowMs: 5 }).kind, 'show');
  assert.throws(() => holdDecision({ ready: false, last, holdStartMs: 10, nowMs: 5 }), /a hold starts no later than now/);
  const view = { selectors: HEADING, activeSelector: '', activePicked: false };
  assert.equal(selectionReady(view, { settled: false, switching: false }), false);
  assert.equal(selectionReady(view, { settled: true, switching: false }), true);
  assert.equal(selectionReady(view, { settled: true, switching: true }), false, 'a switch waits for the default pick');
  assert.equal(selectionReady({ ...view, selectors: [] }, { settled: true, switching: true }), true);
});
