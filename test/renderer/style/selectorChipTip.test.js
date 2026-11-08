// Goal: a selector chip the well cuts off shows its whole selector in the app's own
// tooltip after the panel's usual rest. Its native `title` was the only way to read one,
// on the operating system's delay and with no say over wrapping.
// Method: mount the real SelectorPicker in jsdom and drive it with the mouse events the
// app gets. jsdom has no layout, so each chip is given the widths a cut-off or a fitting
// chip measures, and the tooltip's rect is set by hand to check where it is placed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'selector-chip-tip.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { chipHint, chipTruncated, SelectorChips } from './src/features/style/embed/SelectorPicker';",
      "export { classifySelector } from './src/features/style/embed/LayoutRows';",
      "export { setHost, getHost } from './src/features/style/model/host';",
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
const { window } = dom;
Object.assign(global, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  localStorage: { getItem: () => undefined, setItem: () => undefined, removeItem: () => undefined },
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
});
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const panel = require(bundle);

const LONG = 'section.faq {details {summary {&::after}}}';
const SHORT = 'summary';
const REST_MS = 500;
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const chipOf = (text, fields = {}) =>
  panel.classifySelector({ text, specificity: [0, 0, 1], state: '', simple: false, fromComponent: false, key: `c:${text}`, ...fields });

async function mount(activeSelector = '', handlers = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const entries = [chipOf(LONG), chipOf(SHORT)];
  await act(async () => {
    root.render(
      React.createElement(panel.SelectorChips, {
        entries,
        activeSelector,
        busy: false,
        onSelect: handlers.onSelect ?? (() => undefined),
        onDeselect: handlers.onDeselect ?? (() => undefined),
      }),
    );
  });
  const chips = [...container.querySelectorAll('button')];
  const [long, short] = chips;
  Object.defineProperty(long.firstElementChild, 'scrollWidth', { value: 400 });
  Object.defineProperty(long.firstElementChild, 'clientWidth', { value: 200 });
  Object.defineProperty(short.firstElementChild, 'scrollWidth', { value: 60 });
  Object.defineProperty(short.firstElementChild, 'clientWidth', { value: 60 });
  return {
    long,
    short,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const tip = () => document.querySelector('[role="tooltip"]') ?? undefined;
const hover = (chip) => act(async () => chip.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
const rest = () => act(() => pause(REST_MS + 50));

test('a cut-off chip shows its whole selector as code after the usual rest', async () => {
  const { long, unmount } = await mount();
  await hover(long);
  assert.equal(tip(), undefined, 'nothing shows before the rest is over');
  await rest();
  const code = tip().querySelector('code.code-inline');
  assert.ok(code, 'the selector is highlighted code, through CodeInline');
  assert.equal(code.textContent, LONG, 'all of it, untruncated');
  assert.equal(long.hasAttribute('title'), false, 'no native title competes with it');
  assert.equal(tip().parentElement, document.body, 'it portals out of the panel, so the panel cannot clip it');
  await unmount();
});

test('a chip showing all its text keeps its native title', async () => {
  const { short, unmount } = await mount();
  await hover(short);
  await rest();
  assert.equal(tip(), undefined);
  assert.equal(short.title, SHORT);
  await unmount();
});

test('the hint sits on a line of its own, and only when there is one', async () => {
  const active = await mount(LONG);
  await hover(active.long);
  await rest();
  const note = tip().querySelector('.u-prop-tip-note');
  assert.equal(note.textContent, 'click to deselect');
  assert.equal(note.previousElementSibling.tagName, 'CODE', 'under the selector, not after it');
  await active.unmount();
  const idle = await mount();
  await hover(idle.long);
  await rest();
  assert.equal(tip().querySelector('.u-prop-tip-note') ?? undefined, undefined);
  await idle.unmount();
});

test('a press, a key, a scroll and the pointer moving off each close it', async () => {
  const closers = [
    () => document.dispatchEvent(new window.Event('pointerdown', { bubbles: true })),
    () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    () => window.dispatchEvent(new window.Event('scroll')),
    (chips) => chips.short.dispatchEvent(new window.Event('pointermove', { bubbles: true })),
  ];
  for (const close of closers) {
    const chips = await mount();
    await hover(chips.long);
    await rest();
    assert.ok(tip());
    await act(async () => close(chips));
    assert.equal(tip(), undefined, String(close));
    await chips.unmount();
  }
});

test('a click goes through, and a rest still running never opens over the new pick', async () => {
  const picks = [];
  const { long, unmount } = await mount('', { onSelect: (text) => picks.push(text) });
  await hover(long);
  await act(async () => long.click());
  assert.deepEqual(picks, [LONG]);
  await rest();
  assert.equal(tip(), undefined);
  await unmount();
});

test('moving between chips never shows two, nor the old one over the new', async () => {
  const { long, short, unmount } = await mount();
  await hover(long);
  await rest();
  assert.ok(tip());
  await act(async () => long.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: short })));
  assert.equal(tip(), undefined);
  await hover(short);
  await rest();
  assert.equal(document.querySelectorAll('[role="tooltip"]').length, 0);
  await unmount();
});

test('at the panel’s right edge it stays inside the window', async () => {
  const { long, unmount } = await mount();
  const width = 300;
  long.getBoundingClientRect = () => ({ left: window.innerWidth - 100, right: window.innerWidth, width: 100, top: 300, bottom: 320, height: 20 });
  const measured = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: 80, width, height: 80 });
  try {
    await hover(long);
    await rest();
    assert.ok(Number.parseFloat(tip().style.left) + width <= window.innerWidth - 8);
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = measured;
  }
  await unmount();
});

test('it wraps rather than clipping, on fills rather than borders', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/features/style/embedEditor.css'), 'utf8');
  const rule = /\.embed-editor_selector-tip-code \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(rule, /overflow-wrap: anywhere/);
  assert.match(rule, /white-space: pre-wrap/);
  assert.doesNotMatch(rule, /border|height|overflow:/);
});

test('truncation is measured, and a hint follows the chip’s state', () => {
  assert.equal(panel.chipTruncated({ scrollWidth: 201, clientWidth: 200 }), true);
  assert.equal(panel.chipTruncated({ scrollWidth: 200, clientWidth: 200 }), false);
  const entry = chipOf(LONG);
  assert.equal(panel.chipHint(entry, { active: true, dimmed: false }), 'click to deselect');
  assert.equal(panel.chipHint(entry, { active: true, dimmed: false, deselectable: false }), undefined, 'a pseudo-element row keeps its pick');
  assert.equal(panel.chipHint(entry, { active: false, dimmed: true }), 'styled in another query');
  assert.equal(panel.chipHint(chipOf(LONG, { pending: true }), { active: false, dimmed: false }), 'no styles yet');
  assert.equal(panel.chipHint(entry, { active: false, dimmed: false }), undefined);
});

test.after(() => window.close());
