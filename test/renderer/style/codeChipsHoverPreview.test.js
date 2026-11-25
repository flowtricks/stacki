// Hovering a variable in the picker a code chip opens previews it on the canvas, live; leaving restores.
//
//   node test/renderer/style/codeChipsHoverPreview.test.js
//
// Goal: pressing a variable chip in the code window (CodeMirror) opens the Style panel's VariablePicker.
// Reported: hovering its rows changed nothing on the canvas, because the chip passed the picker no
// preview handlers and a code window has no Style card to provide the canvas preview channel
// (PreviewPropContext). Now a hovered or arrowed row shows the declaration with that variable in the
// chip's place, through that channel; the editor's text is untouched until a pick.
//
// Checks, with the real chooser and a fake canvas writer standing in for the frame:
// - hover previews the declaration's property with the variable in the chip's place (the reference),
//   and neither the editor's text nor the owner's onChange is touched;
// - leaving the list restores (the writer is asked to show nothing), once, and not again;
// - a click commits: the reference replaces the chip, the canvas keeps the previewed value to the save
//   (no restore to the original after it), and nothing is left previewing;
// - Escape and an outside press mid-hover restore and commit nothing; closing the window does too;
// - hovering three rows in one frame writes once, the last row winning, and never a stale one after a leave;
// - a writer that throws: no crash, one toast (never a paragraph), the restore is still asked, and no
//   second preview is attempted for the session;
// - a reference being typed (`--`) opens the same chooser, which previews while the editor keeps the
//   typed text, and takes the preview back when it closes;
// - a listed keyword's rows (`position`) preview the same way.
// Method: the real components are bundled with a four-variable project and mounted in jsdom through
// React inside a PreviewPropContext whose writer logs every call. Hover is the pointer events the page
// dispatches (pointerover/pointerout); rows are clicked as a person does; every wait polls the document
// (test/helpers/waitFor.js), never a fixed pause. The frame itself is covered in Chromium by
// test/renderer/code/codeWindowHoverPreviewChromium.test.js.

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
        onAdd({ name: 'wide', collection: 'Sizes', group: '', value: '3rem', binding: 'var(--wide)', type: 'Size' });
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
  const output = repoPath('node_modules/.stacki-test/code-chips-hover-preview.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import CodeWindow from './src/features/code/CodeWindow';
        import { codeChipTextOf, useCodeChips } from './src/features/style/codeChips/CodeChips';
        export { EditorView } from '@codemirror/view';
        export { ensureSharedVars } from './src/features/style/sharedVars';
        export { PreviewPropContext } from './src/features/style/connectFieldHelpers';
        export { subscribeErrorToasts } from './src/ui/errorNotices';
        // The code window over a CSS file, as AppPanes' CodeWindowHost mounts it.
        export function CodeWindowSurface({ value, onChange, onClose }) {
          const chips = useCodeChips(codeChipTextOf('css'));
          return createElement(CodeWindow, { title: 'site.css', language: 'css', value, onChange, onClose, extensions: chips.extension, overlay: chips.overlay });
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

// One task boundary inside act, so queued effects and state updates land. Never a fixed pause.
const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
const pickerOf = () => document.querySelector('.embed-editor_varpicker');
const pickerNames = () => [...document.querySelectorAll('.embed-editor_varpicker-item-name')].map((name) => name.textContent);
const waitUntil = (what, until) =>
  waitFor({
    what,
    read: async () => {
      await settle();
      return until();
    },
    until: (held) => held,
  });
const pickerOpen = () => waitUntil('the chooser is placed with its rows', () => pickerOf()?.style.visibility === 'visible' && pickerNames().length > 0);
const pickerClosed = () => waitUntil('the chooser is closed', () => pickerOf() === null);
const mouse = (type, init = {}) => new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
const press = async (element) => {
  await act(async () => {
    element.dispatchEvent(mouse('mousedown'));
    element.dispatchEvent(mouse('mouseup'));
    element.dispatchEvent(mouse('click'));
  });
  await settle();
};
const rowOf = (name) => [...document.querySelectorAll('.embed-editor_varpicker-item')].find((row) => row.dataset.binding === `var(--${name})`);

// A canvas writer that logs each call as `prop: value`, and `prop: -` for a restore.
function fakeCanvas({ failing } = {}) {
  const calls = [];
  const write = (prop, value) => {
    calls.push(`${prop}: ${value === undefined ? '-' : value}`);
    if (failing && value !== undefined) {
      throw new Error('the frame is gone');
    }
  };
  return { calls, write };
}

async function mount(css, canvas) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const changes = [];
  const toasts = [];
  const unsubscribe = surfaces.subscribeErrorToasts(
    (notice) => toasts.push(notice.message),
    () => undefined,
  );
  let closed = false;
  function Owner() {
    const [text, setText] = React.useState(css);
    const [open, setOpen] = React.useState(true);
    if (!open) {
      closed = true;
      return undefined;
    }
    return React.createElement(surfaces.CodeWindowSurface, {
      value: text,
      onChange: (next) => {
        changes.push(next);
        setText(next);
      },
      onClose: () => setOpen(false),
    });
  }
  await act(async () => {
    root.render(React.createElement(surfaces.PreviewPropContext.Provider, { value: canvas.write }, React.createElement(Owner)));
  });
  // A value still being typed has no chip yet: the editor itself is the sign it is ready.
  await waitUntil(
    'the editor draws',
    () => host.querySelector(css.includes('--') && css.includes('var(') ? '.cm-editor [data-code-chip]' : '.cm-editor') !== null,
  );
  const view = surfaces.EditorView.findFromDOM(host.querySelector('.cm-editor'));
  const chipFor = (reference) => {
    const chip = [...view.contentDOM.querySelectorAll('[data-code-chip="variable"]')].find((candidate) => candidate.dataset.binding === reference);
    assert.ok(chip, `${reference} is drawn as a chip`);
    return chip;
  };
  const hover = (name) => act(async () => rowOf(name).dispatchEvent(mouse('pointerover')));
  const leaveList = () =>
    act(async () => document.querySelector('.embed-editor_varpicker-list').dispatchEvent(mouse('pointerout', { relatedTarget: document.body })));
  const escape = () => act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const done = async () => {
    unsubscribe();
    await act(async () => root.unmount());
    host.remove();
  };
  return { view, changes, toasts, chipFor, hover, leaveList, escape, done, isClosed: () => closed };
}

const CSS = '.a {\n\tpadding: 0 var(--accent) 2rem;\n}';

test("hovering a row previews the declaration with that variable in the chip's place, and writes nothing", async () => {
  const canvas = fakeCanvas();
  const { view, changes, chipFor, hover, done } = await mount(CSS, canvas);
  await press(chipFor('var(--accent)'));
  await pickerOpen();
  assert.deepEqual(canvas.calls, [], 'opening the chooser previews nothing');
  await hover('brand');
  await waitUntil('the hover reaches the canvas', () => canvas.calls.length === 1);
  assert.deepEqual(canvas.calls, ['padding: 0 var(--brand) 2rem']);
  assert.equal(view.state.doc.toString(), CSS, 'the editor text is untouched by a preview');
  assert.equal(changes.length, 0, 'the owner saw no edit');
  await done();
});

test('leaving the list restores once, and a second leave does nothing more', async () => {
  const canvas = fakeCanvas();
  const { chipFor, hover, leaveList, done } = await mount(CSS, canvas);
  await press(chipFor('var(--accent)'));
  await pickerOpen();
  await hover('brand');
  await waitUntil('the hover reaches the canvas', () => canvas.calls.length === 1);
  await leaveList();
  await settle();
  assert.deepEqual(canvas.calls, ['padding: 0 var(--brand) 2rem', 'padding: -']);
  await leaveList();
  await settle();
  assert.equal(canvas.calls.length, 2, 'restoring twice is idempotent');
  await done();
});

test('a click commits the reference, keeps the preview for the save and leaves nothing previewing', async () => {
  const canvas = fakeCanvas();
  const { view, changes, chipFor, hover, done } = await mount(CSS, canvas);
  await press(chipFor('var(--accent)'));
  await pickerOpen();
  await hover('wide');
  await waitUntil('the hover reaches the canvas', () => canvas.calls.length === 1);
  await press(rowOf('wide'));
  await pickerClosed();
  assert.equal(view.state.doc.toString(), CSS.replace('var(--accent)', 'var(--wide)'), 'only the reference changed');
  assert.ok(changes.length > 0, 'the pick reaches the owner like an edit');
  await settle();
  assert.deepEqual(canvas.calls, ['padding: 0 var(--wide) 2rem'], 'no restore to the original after a pick: the save settles the preview');
  await done();
  assert.equal(canvas.calls.length, 1, 'closing the window afterwards adds no stray call');
});

test('Escape and an outside press mid-hover restore and commit nothing', async () => {
  for (const way of ['escape', 'press']) {
    const canvas = fakeCanvas();
    const { view, changes, chipFor, hover, escape, done } = await mount(CSS, canvas);
    await press(chipFor('var(--accent)'));
    await pickerOpen();
    await hover('brand');
    await waitUntil('the hover reaches the canvas', () => canvas.calls.length === 1);
    if (way === 'escape') {
      await escape();
    } else {
      await press(document.body);
    }
    await waitUntil('the preview is taken back', () => canvas.calls.at(-1) === 'padding: -');
    assert.equal(view.state.doc.toString(), CSS, `${way}: the text is as it was`);
    assert.equal(changes.length, 0, `${way}: nothing was committed`);
    await done();
  }
});

test('closing the code window mid-hover restores', async () => {
  const canvas = fakeCanvas();
  const { chipFor, hover, done } = await mount(CSS, canvas);
  await press(chipFor('var(--accent)'));
  await pickerOpen();
  await hover('brand');
  await waitUntil('the hover reaches the canvas', () => canvas.calls.length === 1);
  await done();
  assert.equal(canvas.calls.at(-1), 'padding: -', 'unmounting with a preview up takes it back');
});

test('rapid hovers across rows write once per frame, the last row winning, and a leave cancels the pending one', async () => {
  const canvas = fakeCanvas();
  const { chipFor, leaveList, done } = await mount(CSS, canvas);
  await press(chipFor('var(--accent)'));
  await pickerOpen();
  await act(async () => {
    for (const name of ['accent', 'brand', 'wide']) {
      rowOf(name).dispatchEvent(mouse('pointerover'));
    }
  });
  await waitUntil('the frame lands', () => canvas.calls.length === 1);
  await settle();
  assert.deepEqual(canvas.calls, ['padding: 0 var(--wide) 2rem'], 'three hovers in one frame make one write, the last row');
  await act(async () => {
    rowOf('brand').dispatchEvent(mouse('pointerover'));
    document.querySelector('.embed-editor_varpicker-list').dispatchEvent(mouse('pointerout', { relatedTarget: document.body }));
  });
  await settle();
  assert.ok(!canvas.calls.includes('padding: 0 var(--brand) 2rem'), 'a hover cancelled by leaving never previews');
  assert.equal(canvas.calls.at(-1), 'padding: -');
  await leaveList();
  await done();
});

test('a failing canvas writer does not crash, toasts once, and the restore is still asked', async () => {
  const canvas = fakeCanvas({ failing: true });
  const { view, toasts, chipFor, hover, leaveList, escape, done } = await mount(CSS, canvas);
  await press(chipFor('var(--accent)'));
  await pickerOpen();
  await hover('brand');
  await waitUntil('the failed write is reported', () => toasts.length === 1);
  assert.match(toasts[0], /preview/i, 'the failure is a toast');
  assert.ok(pickerOf(), 'the chooser is still open');
  await hover('wide');
  await settle();
  assert.equal(canvas.calls.filter((call) => call !== 'padding: -').length, 1, 'no second preview is tried after a failure');
  assert.equal(toasts.length, 1, 'one toast, not one per row');
  await leaveList();
  await escape();
  await waitUntil('the restore was asked', () => canvas.calls.includes('padding: -'));
  assert.equal(view.state.doc.toString(), CSS);
  assert.equal(document.body.textContent.includes('the frame is gone'), false, 'no error paragraph in the UI');
  await done();
});

test('a reference being typed previews in the chooser while the editor keeps the typed text, and closing restores', async () => {
  const canvas = fakeCanvas();
  const css = '.a {\n\tpadding: 0 ;\n}';
  const { view, changes, hover, escape, done } = await mount(css, canvas);
  const at = css.indexOf('0 ') + 2;
  view.focus();
  view.dispatch({ changes: { from: at, insert: '--' }, selection: { anchor: at + 2 }, userEvent: 'input.type' });
  await pickerOpen();
  await hover('brand');
  await waitUntil('the typed chooser previews', () => canvas.calls.length === 1);
  assert.equal(canvas.calls[0], 'padding: 0 var(--brand)');
  assert.equal(view.state.doc.toString(), css.replace('0 ;', '0 --;'), "the typed text is the editor's own");
  await escape();
  await waitUntil('the preview is taken back', () => canvas.calls.at(-1) === 'padding: -');
  assert.equal(changes.filter((next) => next.includes('var(')).length, 0, 'nothing was committed');
  await done();
});

test("a listed keyword's rows preview on hover and restore on leave", async () => {
  const canvas = fakeCanvas();
  const css = '.a {\n\tposition: relative;\n}';
  const { view, changes, done } = await mount(css, canvas);
  const chip = view.contentDOM.querySelector('[data-code-chip="keyword"]');
  assert.ok(chip, 'the keyword is drawn as a chip');
  await press(chip);
  await waitUntil('the keyword list is open', () => document.querySelector('.code-chip-keyword-list [role="option"]') !== null);
  const option = [...document.querySelectorAll('.code-chip-keyword-list [role="option"]')].find((row) => row.textContent.toLowerCase().includes('sticky'));
  assert.ok(option, 'sticky is offered');
  await act(async () => option.dispatchEvent(mouse('pointerover')));
  await waitUntil('the hover reaches the canvas', () => canvas.calls.length === 1);
  assert.equal(canvas.calls[0], 'position: sticky');
  await act(async () => document.querySelector('.code-chip-keyword-list').dispatchEvent(mouse('pointerout', { relatedTarget: document.body })));
  await waitUntil('the preview is taken back', () => canvas.calls.at(-1) === 'position: -');
  assert.equal(view.state.doc.toString(), css);
  assert.equal(changes.length, 0);
  await done();
});
