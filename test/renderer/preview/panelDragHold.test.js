// Goal: dragging an editor side panel must not re-lay out the canvas page at every
// intermediate width. Pages that re-measure on resize (text split into lines) flicker when
// they do. The canvas holds the page viewport for the drag and scales it to fit, then applies
// the real width once, on release, without the frame's width transition.
// Methodology: test the pure `heldPreviewViewport` with and without a hold, for fluid and
// fixed widths and as space shrinks and grows. Then mount `usePreviewSizing` in jsdom with a
// stubbed ResizeObserver, drive the shared panel drag phase and container width, and record the
// viewport each render: during the drag the width must not change; after release it must.
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
      "export { heldPreviewViewport, previewViewport } from './src/features/preview/previewViewport';",
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

test('a held viewport keeps its page size and only scales to fit', () => {
  const live = { width: 800, height: 600 };
  assert.deepEqual(hold.heldPreviewViewport(undefined, live, undefined, undefined), hold.previewViewport(undefined, live, undefined));
  const held = { width: 1000, height: 600 };
  const shrunk = hold.heldPreviewViewport(undefined, { width: 500, height: 600 }, held, undefined);
  assert.equal(shrunk.width, 1000, 'A fluid page keeps the width it had when the drag began');
  assert.equal(shrunk.height, 600);
  assert.equal(shrunk.scale, 0.5);
  const grown = hold.heldPreviewViewport(undefined, { width: 1400, height: 600 }, held, undefined);
  assert.equal(grown.width, 1000);
  assert.equal(grown.scale, 1, 'The frame never scales up past its held size');
  const fixed = hold.heldPreviewViewport(768, { width: 400, height: 600 }, held, undefined);
  assert.equal(fixed.width, 768);
  assert.equal(fixed.height, 568, 'The held height does not follow the live scale, so the page does not re-lay out');
  assert.equal(fixed.scale, 0.4);
  const unmeasured = hold.heldPreviewViewport(undefined, live, { width: 0, height: 0 }, undefined);
  assert.equal(unmeasured.scale, 1);
  assert.throws(() => hold.heldPreviewViewport(undefined, { width: Number.NaN, height: 1 }, held, undefined), /Preview container width must be finite/);
  assert.throws(() => hold.heldPreviewViewport(undefined, live, { width: -1, height: 1 }, undefined), /Held preview width must not be negative/);
});

test('the canvas holds its width for a panel drag and applies it on release', async () => {
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
  function Canvas() {
    const dimensions = hold.usePreviewDimensions();
    const sizing = hold.usePreviewSizing('desktop', dimensions, () => {});
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
    const dragStart = renders.length;
    for (const width of [900, 760, 640, 820, 500]) {
      await resize(width);
    }
    const during = renders.slice(dragStart);
    assert.ok(during.length >= 5, 'The canvas rendered for each drag step');
    assert.deepEqual([...new Set(during.map((entry) => entry.width))], [1000], 'The page width is held for the whole drag');
    assert.equal(last().scale, 0.5, 'The held page scales to the space it has');
    assert.ok(
      during.every((entry) => entry.settling),
      'The frame skips its width transition during the drag',
    );
    await act(() => hold.setPanelDragPhase('idle'));
    assert.equal(last().width, 500, 'Release applies the real width');
    assert.equal(last().scale, 1);
    assert.equal(last().settling, true, 'The release frame also skips the width transition');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    assert.equal(last().settling, false, 'The transition returns the frame after release');
    await resize(700);
    assert.equal(last().width, 700, 'Without a drag the canvas follows its container');
  } finally {
    hold.setPanelDragPhase('idle');
    await act(() => root.unmount());
    window.close();
  }
});
