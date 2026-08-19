// The number beside the swatch, while the swatch is being dragged.
//
//   node test/color-live.js
//
// Dragging in the colour picker writes straight to the canvas, deliberately not
// through the panel's model — that is rebuilt from the stylesheets, and doing
// that per pointer move would be absurd. But the field beside the swatch reads
// the model, so it kept showing the colour the drag started from: the page and
// the swatch moved together under the pointer while the value sat still, and
// only snapped to the truth when the mouse came up.
//
// So a colour control shows what it last emitted until the model answers with
// something of its own. These drive the real Backgrounds section, with a model
// that never changes — which is exactly what a live drag sees.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// jsdom lays nothing out, and a zero-width track divides to NaN, so the picker
// is given a geometry to measure.
const SIZE = 240;
const START = 'rgb(1, 2, 3)';

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'color-live.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as BackgroundSection } from './BackgroundSection'\nexport { default as ColorSwatch } from './components/ColorSwatch'`,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, top: 0, left: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE };
  };
  dom.window.avb = { listAssets: async () => ({ entries: [] }) };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { BackgroundSection } = require(bundlePath);

  // What the panel's resolver hands a field: the cascade winner for the property,
  // plus the picked selector's own value for it.
  const resolvedColor = (value) => ({
    prop: 'background-color',
    source: 'selected',
    selectedValue: { value, important: false },
    winner: { selectorText: '.card', value, important: false },
    overridden: false,
    contributors: [],
  });

  // The model the panel resolved before the drag started — and, since a live
  // write never touches it, for the whole drag as well.
  const live = [];
  const committed = [];
  const props = {
    read: (prop) => (prop === 'background-color' ? resolvedColor(START) : undefined),
    busy: false,
    setProp: (prop, value) => committed.push(`${prop}=${value}`),
    clearProp: () => {},
    liveSetProp: (prop, value) => live.push(`${prop}=${value}`),
    onProvenance: () => {},
    onSelectSelector: () => {},
  };

  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(BackgroundSection, props)); });

  const field = () => document.querySelector('input[data-prop="background-color"]');
  check('the colour field shows what the model resolved', field()?.value === START, field()?.value);

  // Open the picker on that field's swatch.
  const swatch = [...document.querySelectorAll('.u-color-swatch')].find(
    (b) => b.getAttribute('aria-label') === 'Background color'
  );
  check('the field has a swatch', swatch != null);
  await act(async () => { swatch.click(); });
  check('clicking it opens the picker', document.querySelector('.u-color-sb') != null);

  // A drag: pointerdown on the saturation square reports live, then moves do.
  const at = (type, fx, fy, target) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clientX', { value: fx * SIZE });
    Object.defineProperty(event, 'clientY', { value: fy * SIZE });
    (target ?? dom.window).dispatchEvent(event);
  };
  await act(async () => { at('pointerdown', 0.8, 0.2, document.querySelector('.u-color-sb')); });

  const afterDown = field()?.value;
  check('the field moves with the drag', afterDown !== START && !!afterDown, `${afterDown}`);
  check('and shows the colour the drag emitted', afterDown === live[live.length - 1]?.split('=')[1], `${afterDown} vs ${live[live.length - 1]}`);
  check('which went to the canvas, not the model', live.length > 0 && committed.length === 0, `${live.length} live / ${committed.length} committed`);

  // Further along the same drag.
  await act(async () => { at('pointermove', 0.2, 0.6); });
  const afterMove = field()?.value;
  check('it keeps up as the drag continues', afterMove !== afterDown && afterMove === live[live.length - 1]?.split('=')[1], `${afterMove} vs ${live[live.length - 1]}`);

  const fillOf = () => swatch.querySelector('.u-color-swatch-fill')?.getAttribute('style') || '';
  check('the swatch shows the drag too', /rgb|#/.test(fillOf()), fillOf());

  // Letting go commits — the model is told, and the field holds what was picked.
  await act(async () => { at('pointerup', 0.2, 0.6); });
  check('releasing commits to the model', committed.length === 1, committed.join(','));
  check('and the field holds the colour that was picked', field()?.value === committed[0].split('=')[1], `${field()?.value} vs ${committed[0]}`);

  // The model answers with a colour of its own (an undo, another selector
  // winning, a rescan): that is more authoritative than what a drag emitted.
  props.read = (prop) => (prop === 'background-color' ? resolvedColor('rgb(9, 9, 9)') : undefined);
  await act(async () => { root.render(React.createElement(BackgroundSection, { ...props })); });
  await act(async () => {});
  check('a value from the model wins over the last drag', field()?.value === 'rgb(9, 9, 9)', field()?.value);

  // --- the swatch on its own ---------------------------------------------------
  // The rows above hand the swatch a value they track themselves. A row that
  // doesn't — and there were three — must still show the drag, because the
  // swatch sits directly under the picker and is the thing a drag is watched in.
  // So the guarantee lives in ColorSwatch, and this is a consumer that offers no
  // help at all: a value that never changes.
  {
    const { ColorSwatch } = require(bundlePath);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const alone = createRoot(host);
    const seen = [];
    await act(async () => {
      alone.render(
        React.createElement(ColorSwatch, {
          value: 'rgb(1, 2, 3)',
          ariaLabel: 'Shadow color',
          onChange: (color, live) => seen.push(`${live ? 'live' : 'commit'}=${color}`),
        })
      );
    });
    const only = host.querySelector('.u-color-swatch');
    const fill = () => host.querySelector('.u-color-swatch-fill')?.getAttribute('style') || '';
    check('a swatch with no help from its row still opens', !!only);
    const before = fill();
    await act(async () => { only.click(); });
    const sb = document.querySelectorAll('.u-color-sb');
    const box = sb[sb.length - 1];
    const drag = (type, fx, fy, target) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clientX', { value: fx * SIZE });
      Object.defineProperty(event, 'clientY', { value: fy * SIZE });
      (target ?? dom.window).dispatchEvent(event);
    };
    await act(async () => { drag('pointerdown', 0.8, 0.2, box); });
    await act(async () => { drag('pointermove', 0.3, 0.7); });
    check('it emits the drag', seen.some((s) => s.startsWith('live=')), seen.join(', '));
    check('and paints what it emitted, with the value it was given unchanged', fill() !== before, `${before} → ${fill()}`);
    const last = seen.filter((s) => s.startsWith('live=')).pop().split('=')[1];
    check(
      'the same colour, not an older one',
      fill().replace(/\s/g, '').includes(last.replace(/\s/g, '')),
      `${fill()} vs ${last}`
    );
    await act(async () => { drag('pointerup', 0.3, 0.7); });
  }

  if (failures.length) {
    console.error(`color-live: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`color-live: ${checked} passed  [drag, commit, model wins]`);
  process.exit(0);
})();
