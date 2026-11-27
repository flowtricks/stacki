// Goal: Frame settings' whole header is one button that opens and closes it, says whether it is open, and still moves
// the popover when dragged without also toggling it. The popover has the faded edge of the app's floating bars (the
// owner's exception to fills-not-borders) and no shadow.
//
// Method: the real popover (ComponentCanvasFramePopup.tsx), bundled as the app bundles it, renders in jsdom with a
// stand-in for the canvas control. The header is pressed, dragged and activated from the keyboard (a click with no click
// count, as a browser sends for Enter and Space). Layout is the browser's, so the edge, the shadow and the full-width
// header are read from the stylesheet's own rules.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/component-canvas-frame-header');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'component-canvas-frame-header.cjs');
buildSync({
  stdin: {
    contents: "export { ComponentCanvasFramePopup } from './src/features/preview/componentCanvas/ComponentCanvasFramePopup';",
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent']) {
  global[name] = dom.window[name];
}
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
installPopupDOM(dom.window);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const { ComponentCanvasFramePopup } = require(output);

const noop = () => undefined;

test('the whole header is one button: a press and the keyboard toggle, a drag only moves', async (context) => {
  const toggles = [];
  // Minimized, the popover draws its header alone; the settings under it need a whole canvas and have tests of their own.
  const canvas = { coverRight: noop, showFramePanel: () => toggles.push('shown'), hideFramePanel: () => toggles.push('hidden') };
  const Harness = () => React.createElement(ComponentCanvasFramePopup, { canvas, state: { kind: 'open', framePanel: 'hidden' } });
  const root = createRoot(document.getElementById('root'));
  context.after(() => act(async () => root.unmount()));
  await act(async () => root.render(React.createElement(Harness)));
  const head = document.querySelector('.component-canvas-popup-head');
  assert.equal(head.tagName, 'BUTTON', 'the header row itself is the button');
  assert.equal(head.getAttribute('type'), 'button');
  assert.equal(head.getAttribute('aria-expanded'), 'false', 'it says whether the settings are open');
  assert.ok(head.querySelector('.component-canvas-popup-title'), 'the title is inside it');
  assert.ok(head.querySelector('.component-canvas-popup-chevron svg'), 'and the chevron');
  assert.equal(head.querySelectorAll('button, input, select, a, [role="button"]').length, 0, 'no control inside that could take a press');
  assert.equal(document.querySelectorAll('.component-canvas-popup button').length, 1, 'one button, no second toggle');

  const pointer = (target, type, x, y) =>
    target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, detail: 1 }));
  const press = async (distance) => {
    await act(async () => {
      pointer(head.querySelector('.component-canvas-popup-title'), 'pointerdown', 100, 20);
      pointer(window, 'pointermove', 100 + distance, 20);
      pointer(window, 'pointerup', 100 + distance, 20);
      pointer(head, 'click', 100 + distance, 20);
    });
  };
  const surface = document.querySelector('.component-canvas-popup');
  await press(0);
  assert.deepEqual(toggles, ['shown'], 'a press opens it');
  await press(3);
  assert.equal(toggles.length, 2, 'a press that wobbles still toggles');
  assert.equal(surface.style.marginLeft, '0px', 'and moves nothing');
  await press(60);
  assert.equal(toggles.length, 2, 'a drag does not toggle');
  assert.notEqual(surface.style.marginLeft, '0px', 'it moves the popover');
  // Enter and Space reach a button as a click with no click count, even right after a drag.
  await act(async () => head.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 0 })));
  assert.equal(toggles.length, 3, 'the keyboard toggles');
});

test('the popover has the floating bars’ faded edge and no shadow, and its header fills it', () => {
  const read = (file) => fs.readFileSync(repoPath(file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const css = read('src/features/preview/componentCanvas/componentCanvas.css');
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, `${selector} has a rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  const popup = rule('.component-canvas-popup.component-canvas-popup');
  assert.match(popup, /border: 1px solid var\(--border-strong\);/);
  assert.match(popup, /box-shadow: none;/);
  const zoomBar = /\n\.canvas-controls \{([^}]*)\}/.exec(read('src/app/styles.css'))?.[1] ?? '';
  assert.match(zoomBar, /border: 1px solid var\(--border-strong\);/, 'the same edge as the canvas zoom bar');
  const head = rule('.component-canvas-popup.component-canvas-popup button.component-canvas-popup-head');
  assert.match(head, /width: 100%;/);
  assert.match(head, /margin: 0;/);
  assert.match(head, /cursor: pointer;/);
});
