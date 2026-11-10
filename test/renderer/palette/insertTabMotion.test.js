// Goal: the insert palette's tabs are plain labels with one pill behind the active tab, and that pill
// sits under whichever tab is active however it became active: a click, the Tab key, or the tab the
// palette reopened on. Switching between the list tabs and the Components grid resizes the palette
// box smoothly, from the size on screen to the size of the new layout, and with reduced motion the
// pill and the box change instantly.
// Methodology: mount the real palette in jsdom. jsdom lays nothing out, so layout offsets are stubbed
// on the prototype: each tab's offset and width come from its position and label, and the palette is
// 640 × 400 as the list and 1180 × 800 as the grid. The pill's place is checked against the same
// measuring function the palette uses (src/ui/segmentIndicator.ts). `matchMedia` answers the reduced
// motion query either way. The pure resize plan is tested on its own, including every refusal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');

function bundle(entry, name) {
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, name);
  buildSync({
    entryPoints: [repoPath(entry)],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    logLevel: 'silent',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  });
  delete require.cache[output];
  return require(output);
}

/** Layout offsets for the elements the palette measures; everything else keeps jsdom's zero. */
function stubLayout(window) {
  const prototype = window.HTMLElement.prototype;
  const tabBox = (element) => {
    const tabs = [...element.parentElement.querySelectorAll('.insert-tab')];
    const index = tabs.indexOf(element);
    // Each label is 7 px a letter plus 20 px of padding, with 2 px between tabs, after 12 px of row padding.
    let left = 12;
    for (const tab of tabs.slice(0, index)) {
      left += tab.textContent.length * 7 + 20 + 2;
    }
    return { left, width: element.textContent.length * 7 + 20 };
  };
  const paletteBox = (element) => (element.classList.contains('insert-palette-grid') ? { width: 1180, height: 800 } : { width: 640, height: 400 });
  Object.defineProperty(prototype, 'offsetLeft', {
    configurable: true,
    get() {
      return this.classList.contains('insert-tab') ? tabBox(this).left : 0;
    },
  });
  Object.defineProperty(prototype, 'offsetWidth', {
    configurable: true,
    get() {
      if (this.classList.contains('insert-tab')) {
        return tabBox(this).width;
      }
      if (this.classList.contains('insert-palette')) {
        // A palette with an inline size (mid-transition) is that size.
        return this.style.width === '' ? paletteBox(this).width : Number.parseFloat(this.style.width);
      }
      return 0;
    },
  });
  Object.defineProperty(prototype, 'offsetHeight', {
    configurable: true,
    get() {
      if (this.classList.contains('insert-palette')) {
        return this.style.height === '' ? paletteBox(this).height : Number.parseFloat(this.style.height);
      }
      return 0;
    },
  });
  Object.defineProperty(prototype, 'clientWidth', {
    configurable: true,
    get() {
      // The palette's 1 px border on each side.
      return this.classList.contains('insert-palette') ? this.offsetWidth - 2 : 0;
    },
  });
}

async function setup({ reduced, tab = 'all' }) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.localStorage = dom.window.localStorage;
  dom.window.localStorage.setItem('stacki.insertPalette.tab', tab);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const queries = [];
  dom.window.matchMedia = (query) => {
    queries.push(query);
    return { matches: reduced && query === '(prefers-reduced-motion: reduce)', media: query };
  };
  stubLayout(dom.window);
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { Simulate } = require('react-dom/test-utils');
  const InsertSearch = bundle('src/features/palette/InsertSearch.tsx', 'insert-tab-motion.cjs').default;
  const { measureSegmentIndicator } = bundle('src/ui/segmentIndicator.ts', 'segment-indicator.cjs');
  const container = document.getElementById('root');
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(InsertSearch, { components: [], devUrl: undefined, onInsert() {}, onClose() {} }));
  });
  const act = (work) => React.act(async () => work());
  const tabs = () => [...container.querySelectorAll('.insert-tab')];
  const active = () => container.querySelector('.insert-tab.on');
  const indicator = () => container.querySelector('.insert-tab-indicator');
  const palette = () => container.querySelector('.insert-palette');
  /** Wait out the frame after mount, when the pill's transition may turn on. */
  const nextFrame = () => act(() => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve())));
  const press = (key, data = {}) => act(() => Simulate.keyDown(container.querySelector('.insert-search-row input'), { key, ...data }));
  const finish = async () => {
    await React.act(async () => root.unmount());
    dom.window.close();
    delete global.localStorage;
  };
  return { act, tabs, active, indicator, palette, nextFrame, press, finish, queries, measureSegmentIndicator };
}

function assertUnder(view, label) {
  const tab = view.active();
  assert.equal(tab.textContent, label);
  const box = view.measureSegmentIndicator(tab);
  assert.ok(box.width > 0, 'the stub gives the tab a width');
  assert.equal(view.indicator().style.transform, `translateX(${box.x}px)`, `the pill starts where ${label} starts`);
  assert.equal(view.indicator().style.width, `${box.width}px`, `the pill is as wide as ${label}`);
}

test('the pill sits under the active tab after a click, the Tab key, and a restored tab', async () => {
  const view = await setup({ reduced: false, tab: 'elements' });
  try {
    assertUnder(view, 'Elements');
    assert.equal(view.tabs().length, 4);
    assert.equal(view.indicator().getAttribute('aria-hidden'), 'true');
    assert.equal(view.indicator().closest('[role="tablist"]'), view.tabs()[0].parentElement, 'one pill, inside the tab row');
    assert.deepEqual(
      view.tabs().map((tab) => tab.getAttribute('aria-selected')),
      ['false', 'false', 'true', 'false'],
    );
    await view.nextFrame();
    assert.ok(view.indicator().classList.contains('is-animated'), 'after the first placement the pill slides');
    await view.act(() => view.tabs()[3].click());
    assertUnder(view, 'Other');
    await view.press('Tab');
    assertUnder(view, 'All results');
    await view.press('Tab', { shiftKey: true });
    assertUnder(view, 'Other');
    assert.equal(view.indicator().style.transform === `translateX(${view.measureSegmentIndicator(view.tabs()[0]).x}px)`, false);
    assert.equal(view.tabs().filter((tab) => tab.classList.contains('on')).length, 1, 'exactly one tab is active');
  } finally {
    await view.finish();
  }
});

test('switching to the grid animates the palette from its old size to the new one, then hands the size back', async () => {
  const { paletteResizeMs } = bundle('src/features/palette/paletteResize.ts', 'palette-resize.cjs');
  const view = await setup({ reduced: false, tab: 'all' });
  try {
    assert.equal(view.palette().classList.contains('is-resizing'), false, 'opening does not animate');
    await view.act(() => view.tabs()[1].click());
    const palette = view.palette();
    assert.ok(palette.classList.contains('insert-palette-grid'));
    assert.ok(palette.classList.contains('is-resizing'));
    assert.ok(palette.classList.contains('is-resizing-run'), 'the transition runs');
    assert.equal(palette.style.width, '1180px', 'it is moving to the grid width');
    assert.equal(palette.style.height, '800px');
    assert.equal(palette.style.getPropertyValue('--insert-palette-content-width'), '1178px', 'the grid is laid out at its final width');
    assert.equal(palette.style.getPropertyValue('--insert-palette-resize-ms'), `${paletteResizeMs}ms`);
    await view.act(() => new Promise((resolve) => setTimeout(resolve, paletteResizeMs + 20)));
    assert.equal(palette.classList.contains('is-resizing'), false);
    assert.equal(palette.style.width, '', 'CSS owns the size again');
    assert.equal(palette.style.getPropertyValue('--insert-palette-content-width'), '');
  } finally {
    await view.finish();
  }
});

test('with reduced motion the pill jumps and the palette snaps', async () => {
  const view = await setup({ reduced: true, tab: 'all' });
  try {
    await view.nextFrame();
    assert.equal(view.indicator().classList.contains('is-animated'), false, 'no transition on the pill');
    await view.act(() => view.tabs()[1].click());
    assertUnder(view, 'Components');
    assert.equal(view.indicator().classList.contains('is-animated'), false);
    const palette = view.palette();
    assert.ok(palette.classList.contains('insert-palette-grid'));
    assert.equal(palette.classList.contains('is-resizing'), false, 'no resize animation');
    assert.equal(palette.style.width, '');
    assert.ok(view.queries.includes('(prefers-reduced-motion: reduce)'));
  } finally {
    await view.finish();
  }
});

test('the resize plan animates only between two different measured sizes, and only with full motion', () => {
  const { planPaletteResize } = bundle('src/features/palette/paletteResize.ts', 'palette-resize.cjs');
  const list = { width: 640, height: 400 };
  const grid = { width: 1180, height: 800 };
  assert.deepEqual(planPaletteResize(list, grid, 'full'), { kind: 'animate', from: list, to: grid });
  assert.deepEqual(planPaletteResize(grid, list, 'full'), { kind: 'animate', from: grid, to: list });
  assert.deepEqual(
    planPaletteResize({ width: 640, height: 300 }, list, 'full'),
    { kind: 'animate', from: { width: 640, height: 300 }, to: list },
    'height alone',
  );
  assert.deepEqual(planPaletteResize(list, grid, 'reduced'), { kind: 'none' });
  assert.deepEqual(planPaletteResize(undefined, grid, 'full'), { kind: 'none' }, 'nothing measured yet');
  assert.deepEqual(planPaletteResize(list, { width: 640.2, height: 400.3 }, 'full'), { kind: 'none' }, 'the same box');
  assert.throws(() => planPaletteResize(list, { width: Number.NaN, height: 1 }, 'full'), /Assertion failed: paletteResize: width is finite/);
  assert.throws(() => planPaletteResize({ width: -1, height: 1 }, grid, 'full'), /Assertion failed: paletteResize: width is not negative/);
});
