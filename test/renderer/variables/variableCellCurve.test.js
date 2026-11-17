// Goal: the curve button on a timing-function row of the variables sheet opens the easing
// editor, and only the easing editor, however long the value is. A `cubic-bezier()` with
// three-decimal numbers is longer than the custom-value box's threshold, and the cell's
// long-value press capture used to take the button's press too: the custom-value box opened
// on top of the curve editor. Dragging a control point drafts the value, closing the editor
// writes it once (one undo step), and Escape or a press outside closes it.
// Method: the real VariableCell is bundled with esbuild and mounted in jsdom with the popup
// helpers (reduced motion, so closing is immediate). jsdom has no layout, so the graph's box
// is stubbed; presses are dispatched as the browser would send them (mousedown, mouseup,
// click), and the control point is dragged with pointer events on the graph.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom');

const LONG_CURVE = 'cubic-bezier(0.455, 0.03, 0.515, 0.955)';
const NAME = '--transition-timing-inoutquad';

function bundleCell() {
  const output = repoPath('node_modules/.stacki-test/variable-cell-curve.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    entryPoints: [repoPath('src/features/variables/VariableCell.tsx')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return output;
}

function installDOM() {
  const dom = new JSDOM('<!doctype html><div class="vars-view"><div id="root"></div></div>', { pretendToBeVisual: true, url: 'https://stacki.test/' });
  global.window = dom.window;
  for (const name of ['document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'SVGElement', 'MutationObserver', 'DOMRect', 'Window']) {
    global[name] = dom.window[name];
  }
  installPopupDOM(dom.window);
  global.getComputedStyle = dom.window.getComputedStyle;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  // `jsdom` has no pointer capture; the graph only needs the call to succeed.
  dom.window.Element.prototype.setPointerCapture = () => {};
  dom.window.Element.prototype.releasePointerCapture = () => {};
  return dom;
}

test('the curve button opens the easing editor, a drag writes once, and Escape or outside closes it', async () => {
  const output = bundleCell();
  const dom = installDOM();
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Cell = require(output).default;
  const saves = [];
  // The sheet rereads the file after a write; here the row simply keeps what was saved.
  const Row = () => {
    const [value, setValue] = React.useState(LONG_CURVE);
    return React.createElement(Cell, {
      cell: { name: NAME, value, file: 'global.css', selector: ':root', column: '0', line: 1, valueStart: 10, valueEnd: 10 + value.length },
      onSave(_cell, next) {
        saves.push(next);
        setValue(next);
      },
    });
  };
  const root = createRoot(document.getElementById('root'));
  const mouse = (target, type) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  const press = (target) =>
    act(async () => {
      mouse(target, 'pointerdown');
      mouse(target, 'mousedown');
      mouse(target, 'pointerup');
      mouse(target, 'mouseup');
      mouse(target, 'click');
    });
  const pointer = (target, type, x, y) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
    target.dispatchEvent(event);
  };
  const editor = () => document.querySelector('.embed-editor_ease-modal') ?? undefined;
  const customBox = () => document.querySelector('.var-custom') ?? undefined;
  try {
    await act(async () => root.render(React.createElement(Row)));
    const button = document.querySelector('.var-ease');
    assert.ok(button, 'A timing-function row draws the curve button');
    assert.equal(button.getAttribute('aria-label'), `Edit the curve for ${NAME}`);
    assert.ok(LONG_CURVE.length > 34, 'The value is long enough for the long-value press capture');

    await press(button);
    assert.ok(editor(), 'The press opens the easing editor');
    assert.equal(customBox(), undefined, 'The press does not also open the custom-value box');

    // Drag the first control point to the middle of the graph's top quarter.
    const area = editor().querySelector('.embed-editor_ease-grid');
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 280, right: 280, bottom: 280, x: 0, y: 0 });
    const svg = editor().querySelector('.embed-editor_ease-curve');
    const handle = editor().querySelector('.embed-editor_ease-handle');
    await act(async () => pointer(handle, 'pointerdown', 10, 270));
    await act(async () => {
      pointer(svg, 'pointermove', 100, 120);
      pointer(svg, 'pointermove', 140, 70);
      pointer(svg, 'pointerup', 140, 70);
    });
    const dragged = 'cubic-bezier(0.5, 0.75, 0.515, 0.955)';
    assert.equal(document.querySelector('.var-input').value, dragged, 'The field follows the curve while it is dragged');
    assert.deepEqual(saves, [], 'Nothing is written while the editor is open');

    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.equal(editor(), undefined, 'Escape closes the editor');
    assert.deepEqual(saves, [dragged], 'Closing writes the dragged curve once: one edit, one undo step');

    await press(document.querySelector('.var-ease'));
    assert.ok(editor(), 'The editor opens again');
    await press(document.body);
    assert.equal(editor(), undefined, 'A press outside closes the editor');
    assert.equal(customBox(), undefined, 'No custom-value box is left behind');
    assert.deepEqual(saves, [dragged], 'Closing an unchanged curve writes nothing');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
