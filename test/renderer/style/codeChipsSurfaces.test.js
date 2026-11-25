// Pressing a CSS chip on each code surface opens the Style panel's chooser, and a pick lands in the code.
//
//   node test/renderer/style/codeChipsSurfaces.test.js
//
// Goal: a variable chip is not only drawn. On every surface that carries the chips (the CSS Code
// section's CssCodeEditor, the code window that edits a CSS file or a `<style>` node, and the style tag
// editor that is the shared CodeEditor with markup), a press on a chip opens the same VariablePicker the
// Style panel opens, filtered for the declaration's property, and a pick replaces that reference and
// nothing else. A custom property's value, a reference with a fallback and one inside calc() are
// pressed as well, and a copy across chips is the text as written.
// Method: the real components are bundled with a three-variable project (two sizes and a colour, so the
// property filter shows) and mounted in jsdom through React. A press is the browser's own sequence on
// the chip's element (mousedown, mouseup, click); the chooser's rows are read from the document and a
// row is clicked as a person clicks it.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath, stubSources } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const VARIABLES_STUB = {
  'src/features/style/model/webflow.ts': () => ({
    contents: `
      // The keyword chips read the panel's option tables, whose modules also import these.
      export async function getProjectFontFamilies() { return []; }
      export async function getImageAssets() { return []; }
      export async function streamProjectVariables(onAdd) {
        onAdd({ name: 'accent', collection: 'Sizes', group: '', value: '2rem', binding: 'var(--accent)', type: 'Size' });
        onAdd({ name: 'brand', collection: 'Sizes', group: '', value: '1rem', binding: 'var(--brand)', type: 'Size' });
        onAdd({ name: 'ink', collection: 'Sizes', group: '', value: '#000', binding: 'var(--ink)', type: 'Color' });
        return [];
      }
    `,
    loader: 'js',
  }),
};

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
for (const name of [
  'Element',
  'HTMLElement',
  'Node',
  'Text',
  'Range',
  'MutationObserver',
  'getComputedStyle',
  'KeyboardEvent',
  'MouseEvent',
  'DOMParser',
  'Window',
  'Event',
]) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.ResizeObserver = global.ResizeObserver;
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 });
global.IS_REACT_ACT_ENVIRONMENT = true;
// Layout, enough for placement: the page fills the window, a chip sits on its line near the top, and a
// fixed box is where its style says. jsdom lays nothing out, and every box would otherwise be empty.
const CHIP_BOX = { top: 40, bottom: 56, left: 20, right: 80, width: 60, height: 16, x: 20, y: 40 };
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this === document.body || this === document.documentElement) {
    const height = dom.window.innerHeight;
    return { top: 0, bottom: height, left: 0, right: dom.window.innerWidth, width: dom.window.innerWidth, height, x: 0, y: 0 };
  }
  if (this.dataset.codeChip !== undefined) {
    return CHIP_BOX;
  }
  if (this.style.position === 'fixed' && this.style.top.endsWith('px')) {
    const top = Number.parseFloat(this.style.top);
    const height = Number.parseFloat(this.style.height) || 0;
    const left = Number.parseFloat(this.style.left) || 0;
    const width = Number.parseFloat(this.style.width) || 0;
    return { top, bottom: top + height, left, right: left + width, width, height, x: left, y: top };
  }
  return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

let surfaces;
before(async () => {
  const output = repoPath('node_modules/.stacki-test/code-chips-surfaces.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: {
      contents: `
        import { createElement, Fragment } from 'react';
        import { CodeEditor as CssCodeEditor } from './src/features/style/components/CssCodeEditor';
        import CodeEditor from './src/ui/CodeEditor';
        import CodeWindow from './src/features/code/CodeWindow';
        import { codeChipTextOf, useCodeChips } from './src/features/style/codeChips/CodeChips';
        export { EditorView } from '@codemirror/view';
        export { ensureSharedVars } from './src/features/style/sharedVars';
        // The CSS Code section's editor: a rule, so its chips are on.
        export function RuleSurface({ value, onChange }) {
          return createElement(CssCodeEditor, { value, ariaLabel: 'CSS', variables: { kind: 'declarations' }, onChange });
        }
        // The style tag editor: the shared CodeEditor showing markup, as StyleTagSettings mounts it.
        export function StyleTagSurface({ value, onChange }) {
          const chips = useCodeChips('markup');
          return createElement(Fragment, undefined, createElement(CodeEditor, { language: 'html', indentation: 'spaces', chrome: 'minimal', value, onChange, extensions: chips.extension }), chips.overlay);
        }
        // The code window over a CSS file, as AppPanes' CodeWindowHost mounts it.
        export function CodeWindowSurface({ value, onChange }) {
          const chips = useCodeChips(codeChipTextOf('css'));
          return createElement(CodeWindow, { title: 'site.css', language: 'css', value, onChange, onClose: () => undefined, extensions: chips.extension, overlay: chips.overlay });
        }
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [stubSources('stub-variables', VARIABLES_STUB)],
  });
  surfaces = require(output);
  surfaces.ensureSharedVars();
});

// One task boundary inside act, so queued effects and state updates land. Never a fixed pause: what follows an
// action (the chooser placed and filled, or closed) is waited for by polling the document the test reads.
const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
const pickerNames = () => [...document.querySelectorAll('.embed-editor_varpicker-item-name')].map((name) => name.textContent);
const pickerOf = () => document.querySelector('.embed-editor_varpicker');
const waitUntil = (what, until) =>
  waitFor({
    what,
    read: async () => {
      await settle();
      return until();
    },
    until: (held) => held,
  });
// The chooser is open once it is placed (visible) and its rows are drawn; it is closed once it is gone.
const pickerOpen = () => waitUntil('the chooser is placed with its rows', () => pickerOf()?.style.visibility === 'visible' && pickerNames().length > 0);
const pickerClosed = () => waitUntil('the chooser is closed', () => pickerOf() === null);
const press = async (element) => {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
};
const escape = async () => {
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await pickerClosed();
};

async function mount(Surface, value) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const changes = [];
  // Controlled, as every owner is: an edit comes back as the value, or the editor puts the old one back.
  function Owner() {
    const [text, setText] = React.useState(value);
    return React.createElement(Surface, {
      value: text,
      onChange: (next) => {
        changes.push(next);
        setText(next);
      },
    });
  }
  await act(async () => {
    root.render(React.createElement(Owner));
  });
  // Every value mounted here holds a reference, so the editor is ready once its first chip is drawn.
  await waitUntil('the editor draws its chips', () => host.querySelector('.cm-editor [data-code-chip="variable"]') !== null);
  const element = host.querySelector('.cm-editor');
  assert.ok(element, 'the editor is mounted');
  const view = surfaces.EditorView.findFromDOM(element);
  const chipFor = (reference) => {
    const chip = [...view.contentDOM.querySelectorAll('[data-code-chip="variable"]')].find((candidate) => candidate.dataset.binding === reference);
    assert.ok(chip, `${reference} is drawn as a chip`);
    return chip;
  };
  const done = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { view, changes, chipFor, done };
}

const SURFACES = [
  ['the CSS Code section', () => surfaces.RuleSurface, (css) => css],
  ['the style tag editor', () => surfaces.StyleTagSurface, (css) => `<style is:global>\n${css}\n</style>`],
  ['the code window', () => surfaces.CodeWindowSurface, (css) => css],
];

for (const [name, surfaceOf, wrap] of SURFACES) {
  test(`${name}: pressing a variable chip opens the chooser for its property, and a pick replaces only it`, async () => {
    const css = '.a {\n  padding: var(--accent);\n  color: var(--ink);\n}';
    const { view, changes, chipFor, done } = await mount(surfaceOf(), wrap(css));
    const before = view.state.doc.toString();
    await press(chipFor('var(--accent)'));
    await pickerOpen();
    const picker = pickerOf();
    assert.ok(picker, 'the chooser opens');
    // It opened above the window once, out of sight: its anchor sat straight on <body>, the page was the row.
    assert.equal(picker.style.top, `${CHIP_BOX.bottom + 4}px`, 'the chooser drops just under the pressed chip');
    assert.equal(picker.style.visibility, 'visible');
    assert.deepEqual(pickerNames(), ['accent', 'brand'], 'sizes fit padding; the colour does not');
    const brand = [...document.querySelectorAll('.embed-editor_varpicker-item')].find((row) => row.textContent.includes('brand'));
    await press(brand);
    await pickerClosed();
    assert.ok(!pickerOf(), 'a pick closes the chooser');
    assert.equal(view.state.doc.toString(), before.replace('var(--accent)', 'var(--brand)'), 'only the reference changed');
    assert.ok(changes.length > 0, 'the pick reaches the owner like an edit');
    await press(chipFor('var(--ink)'));
    await pickerOpen();
    assert.deepEqual(pickerNames(), ['ink'], 'a colour property is offered colours');
    await escape();
    await done();
  });
}

test('a custom property, a fallback and calc() each open the chooser on a press', async () => {
  const css = '.a {\n  --gap: var(--accent);\n  margin: var(--brand, 1rem);\n  width: calc(100% - var(--accent));\n}';
  const { view, chipFor, done } = await mount(surfaces.RuleSurface, css);
  const chips = [...view.contentDOM.querySelectorAll('[data-code-chip="variable"]')];
  assert.deepEqual(
    chips.map((chip) => chip.dataset.binding),
    ['var(--accent)', 'var(--brand, 1rem)', 'var(--accent)'],
  );
  await press(chips[0]);
  await pickerOpen();
  assert.deepEqual(pickerNames(), ['accent', 'brand', 'ink'], 'a custom property’s value may hold any variable');
  await escape();
  await press(chipFor('var(--brand, 1rem)'));
  await pickerOpen();
  assert.ok(pickerOf(), 'a reference with a fallback opens it');
  const accent = [...document.querySelectorAll('.embed-editor_varpicker-item')].find((row) => row.textContent.includes('accent'));
  await press(accent);
  await pickerClosed();
  assert.match(view.state.doc.toString(), /margin: var\(--accent\);/, 'the whole reference, fallback and all, is replaced');
  await press(chips[2].isConnected ? chips[2] : [...view.contentDOM.querySelectorAll('[data-code-chip="variable"]')].at(-1));
  await pickerOpen();
  assert.deepEqual(pickerNames(), ['accent', 'brand'], 'inside calc() the chooser judges the slot in the width');
  await done();
});

test('a copy across chips is the CSS as written', async () => {
  const css = '.a { gap: var(--accent); }';
  const { view, done } = await mount(surfaces.RuleSurface, css);
  view.focus();
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  view.observer.readSelectionRange();
  const copied = new Map();
  const event = new dom.window.Event('copy', { bubbles: true, cancelable: true });
  event.clipboardData = { setData: (type, text) => copied.set(type, text), clearData: () => copied.clear(), getData: () => '' };
  view.contentDOM.dispatchEvent(event);
  assert.equal(copied.get('text/plain'), css);
  await done();
});
