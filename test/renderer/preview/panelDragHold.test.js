// Goal: while an editor side panel is dragged, the canvas follows the panel live, widening
// and narrowing, without a React render of the preview at each step; a fixed-width frame
// still rescales each step, and the frame skips its width transition so it does not ease
// behind the pointer.
// Methodology: mount `usePreviewSizing` in jsdom with a stubbed ResizeObserver, drive the
// shared panel drag phase and the container width, and record the viewport each render.
// A fluid frame is sized by CSS during the drag (PreviewPane), so its measure is put off:
// no renders mid-drag, one on release with the final width. A fixed-width frame renders
// each step with the live scale. `previewViewport` itself is checked as space grows and shrinks.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const directory = repoPath('node_modules/.stacki-test/panel-drag-hold');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'hold.cjs');
buildSync({
  stdin: {
    contents: [
      "export { usePreviewSizing, usePreviewDimensions } from './src/features/preview/usePreviewSizing';",
      "export { previewViewport } from './src/features/preview/previewViewport';",
      "export { setPanelDragPhase, panelDragPhase } from './src/ui/panelDragPhase';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const hold = require(output);

test('the viewport follows the space it has, growing and shrinking', () => {
  assert.deepEqual(hold.previewViewport(undefined, { width: 500, height: 600 }, undefined), { width: 500, height: 600, scale: 1 });
  assert.deepEqual(hold.previewViewport(undefined, { width: 1400, height: 600 }, undefined), { width: 1400, height: 600, scale: 1 });
  const fixed = hold.previewViewport(768, { width: 400, height: 600 }, undefined);
  assert.equal(fixed.width, 768);
  assert.equal(fixed.scale, (400 - 24) / 768);
  assert.equal(hold.previewViewport(768, { width: 1400, height: 600 }, undefined).scale, 1, 'A fixed frame never scales up');
  assert.throws(() => hold.previewViewport(undefined, { width: Number.NaN, height: 1 }, undefined), /Preview container width must be finite/);
});

test('the canvas follows a panel drag live and renders the fluid frame once, on release', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(global, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  let containerWidth = 1000;
  const observers = new Set();
  global.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
  };
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => containerWidth });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  const renders = [];
  let device = 'desktop';
  function Canvas() {
    const dimensions = hold.usePreviewDimensions();
    const sizing = hold.usePreviewSizing(device, dimensions, () => {});
    renders.push({ width: sizing.viewport.width, scale: sizing.viewport.scale, settling: sizing.panelSettling });
    return React.createElement('div', { ref: sizing.wrapRef });
  }
  const resize = (width) =>
    act(() => {
      containerWidth = width;
      for (const observer of observers) {
        observer.callback([]);
      }
    });
  const last = () => renders.at(-1);
  const root = createRoot(document.getElementById('root'));
  try {
    await act(() => root.render(React.createElement(Canvas)));
    assert.equal(last().width, 1000);
    assert.equal(last().settling, false);
    await act(() => hold.setPanelDragPhase('dragging'));
    assert.equal(last().settling, true, 'The frame skips its width transition during the drag');
    const dragStart = renders.length;
    // Widen the panel (the canvas narrows), then narrow it back past the start.
    for (const width of [900, 760, 640, 820, 1100]) {
      await resize(width);
    }
    assert.equal(renders.length, dragStart, 'A fluid frame follows by CSS: no preview render mid-drag');
    await act(() => hold.setPanelDragPhase('idle'));
    assert.equal(last().width, 1100, 'Release measures once, with the final width');
    assert.ok(renders.length - dragStart <= 3, 'Release renders the preview a fixed few times, not once per step');
    assert.equal(last().settling, true, 'The release frame also skips the width transition');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    assert.equal(last().settling, false, 'The transition returns the frame after release');
    await resize(700);
    assert.equal(last().width, 700, 'Without a drag the canvas follows its container');
    // A fixed-width frame rescales at each step, both ways, because its scale is React state.
    device = 'tablet';
    await act(() => root.render(React.createElement(Canvas)));
    await act(() => hold.setPanelDragPhase('dragging'));
    const scales = [];
    for (const width of [500, 400, 900]) {
      await resize(width);
      scales.push(last().scale);
    }
    assert.ok(scales[0] < 1, 'Narrowing scales a fixed frame down live');
    assert.ok(scales[1] < scales[0]);
    assert.equal(scales[2], 1, 'Widening scales it back up live');
    await act(() => hold.setPanelDragPhase('idle'));
  } finally {
    hold.setPanelDragPhase('idle');
    await act(() => root.unmount());
    window.close();
  }
});
