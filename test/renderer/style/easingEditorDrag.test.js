// Goal: the easing editor (and every PanelSheet with a header) moves by its header,
// stays inside the window, and leaves the bezier graph's handles to the graph.
// Method: the pure clamp is checked against edges, oversize boxes and invalid input;
// then the real EasingEditor is mounted in jsdom with a stubbed layout box (jsdom has
// no layout), and pointer sequences are dispatched on the header, its close button
// and a graph handle, reading the offset the sheet applies as margins.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources');
const { installPopupDOM } = require('../../helpers/popupDom');
const load = require('../../helpers/rendererModule');

const { clampFloatingOffset, FLOATING_EDGE_PX } = load('src/ui/floatingDrag.ts');

test('the clamp keeps a dragged box inside the window', () => {
  const viewport = { width: 1000, height: 800 };
  const box = { left: 200, top: 100, width: 400, height: 300 };
  const none = { x: 0, y: 0 };
  assert.deepEqual(clampFloatingOffset(box, none, { x: 50, y: -20 }, viewport), { x: 50, y: -20 });
  // Far past each edge: the box stops FLOATING_EDGE_PX inside it.
  assert.deepEqual(clampFloatingOffset(box, none, { x: -5000, y: -5000 }, viewport), {
    x: FLOATING_EDGE_PX - 200,
    y: FLOATING_EDGE_PX - 100,
  });
  assert.deepEqual(clampFloatingOffset(box, none, { x: 5000, y: 5000 }, viewport), {
    x: 1000 - FLOATING_EDGE_PX - 400 - 200,
    y: 800 - FLOATING_EDGE_PX - 300 - 100,
  });
  // The box is measured at its current offset: the base placement is recovered from it.
  const moved = { left: 260, top: 80, width: 400, height: 300 };
  assert.deepEqual(clampFloatingOffset(moved, { x: 60, y: -20 }, { x: -5000, y: 0 }, viewport), { x: FLOATING_EDGE_PX - 200, y: 0 });
  // Larger than the window: the top-left corner (where the header is) stays in view.
  const huge = { left: 0, top: 0, width: 2000, height: 1600 };
  assert.deepEqual(clampFloatingOffset(huge, none, { x: 300, y: -300 }, viewport), { x: FLOATING_EDGE_PX, y: FLOATING_EDGE_PX });
  // Invalid input is a programmer error, and the message says which value.
  assert.throws(() => clampFloatingOffset(box, none, { x: Number.NaN, y: 0 }, viewport), /Floating horizontal offset must be finite/);
  assert.throws(() => clampFloatingOffset(box, none, { x: 0, y: Infinity }, viewport), /Floating vertical offset must be finite/);
  assert.throws(() => clampFloatingOffset({ ...box, width: -1 }, none, none, viewport), /Floating box width must not be negative/);
  assert.throws(() => clampFloatingOffset(box, none, none, { width: Number.NaN, height: 800 }), /Floating viewport width must be finite/);
});

test('the easing editor drags by its header and not by its graph', async () => {
  const directory = repoPath('node_modules/.stacki-test/easing-editor-drag');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'easing.cjs');
  await esbuild.build({
    stdin: {
      contents: `export { default as EasingEditor } from ${sourceSpecifier('src/features/style/EasingEditor.tsx')};`,
      resolveDir: repoPath('src'),
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'https://stacki.test/' });
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'SVGElement']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  installPopupDOM(window);
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  global.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  // `jsdom` has no pointer capture; the graph only needs the call to succeed.
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.releasePointerCapture = () => {};
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { EasingEditor } = require(outfile);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  // Where the sheet's own CSS would put it, before any drag.
  const base = { left: 200, top: 120, width: 480, height: 400 };
  const changes = [];
  const root = createRoot(document.getElementById('root'));
  const pointer = (target, type, x, y) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
    target.dispatchEvent(event);
  };
  const drag = (target, from, to) =>
    act(async () => {
      pointer(target, 'pointerdown', from.x, from.y);
      pointer(window, 'pointermove', to.x, to.y);
      pointer(window, 'pointerup', to.x, to.y);
    });
  try {
    await act(async () =>
      root.render(
        React.createElement(EasingEditor, {
          value: 'cubic-bezier(0.16, 1, 0.3, 1)',
          frame: { left: 0, width: viewport.width },
          onChange: (timing) => changes.push(timing),
          onClose: () => {},
        }),
      ),
    );
    const sheet = document.querySelector('.panel-sheet');
    assert.ok(sheet, 'The easing editor opens in a panel sheet');
    const offset = () => ({ x: parseFloat(sheet.style.marginLeft) || 0, y: parseFloat(sheet.style.marginTop) || 0 });
    // The box follows the applied offset, as layout would.
    sheet.getBoundingClientRect = () => {
      const { x, y } = offset();
      const left = base.left + x;
      const top = base.top + y;
      return { left, top, width: base.width, height: base.height, right: left + base.width, bottom: top + base.height, x: left, y: top };
    };
    const header = sheet.querySelector('.embed-editor_ease-head');
    assert.ok(header.hasAttribute('data-floating-drag-handle'), 'The header is the drag handle');
    const title = sheet.querySelector('.embed-editor_ease-title');

    await drag(title, { x: 300, y: 130 }, { x: 360, y: 170 });
    assert.deepEqual(offset(), { x: 60, y: 40 }, 'Dragging the header moves the window');

    // A second drag starts from where the first left it, and is remembered while open.
    await drag(header, { x: 300, y: 130 }, { x: 280, y: 120 });
    assert.deepEqual(offset(), { x: 40, y: 30 });

    // Dragged far past every edge, it stops inside the window.
    await drag(header, { x: 300, y: 130 }, { x: -9000, y: -9000 });
    assert.deepEqual(offset(), { x: FLOATING_EDGE_PX - base.left, y: FLOATING_EDGE_PX - base.top }, 'Clamped at the top-left edge');
    await drag(header, { x: 300, y: 130 }, { x: 9000, y: 9000 });
    const box = sheet.getBoundingClientRect();
    assert.equal(box.right, viewport.width - FLOATING_EDGE_PX, 'Clamped at the right edge');
    assert.equal(box.bottom, viewport.height - FLOATING_EDGE_PX, 'Clamped at the bottom edge');
    const parked = offset();

    // The close button stays a button: pressing it does not start a drag.
    const close = header.querySelector('button[aria-label="Close"]');
    await drag(close, { x: 300, y: 130 }, { x: 100, y: 100 });
    assert.deepEqual(offset(), parked, 'A press on the close button does not move the window');

    // Dragging a graph handle moves the handle (a new curve), not the window.
    const area = sheet.querySelector('.embed-editor_ease-grid');
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 280, right: 280, bottom: 280, x: 0, y: 0 });
    const svg = sheet.querySelector('.embed-editor_ease-curve');
    const handle = sheet.querySelector('.embed-editor_ease-handle');
    // The graph holds the dragged handle in state, so the press commits before the move.
    await act(async () => pointer(handle, 'pointerdown', 50, 50));
    await act(async () => {
      pointer(svg, 'pointermove', 140, 70);
      pointer(svg, 'pointerup', 140, 70);
      pointer(window, 'pointermove', 500, 500);
      pointer(window, 'pointerup', 500, 500);
    });
    assert.deepEqual(offset(), parked, 'A graph handle drag does not move the window');
    assert.equal(changes.at(-1), 'cubic-bezier(0.5, 0.75, 0.3, 1)', 'The handle moved to the pointer');

    // A smaller window pulls a moved editor back inside it.
    window.innerWidth = 900;
    window.innerHeight = 600;
    await act(async () => window.dispatchEvent(new window.Event('resize')));
    const refit = sheet.getBoundingClientRect();
    assert.equal(refit.right, 900 - FLOATING_EDGE_PX);
    assert.equal(refit.bottom, 600 - FLOATING_EDGE_PX);
  } finally {
    await act(async () => root.unmount());
  }
});
