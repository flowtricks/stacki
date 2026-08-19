// The first drag on a colour nobody has set yet.
//
//   node test/color-alpha.js
//
// An unset colour opens the picker at alpha 0 — there is no colour, and
// `transparent` is the honest way to show that. But it made the first drag
// useless: dragging around the saturation square picked a hue that rendered as
// nothing, so the field filled in with `rgba(206, 61, 61, 0)` and the page
// didn't change. Every new colour started with a trip to the alpha slider.
//
// So on an unset colour the first drag means "this colour, visible" — until the
// alpha is somebody's choice. Once it is, it is theirs, including 0: a colour
// deliberately faded to nothing must not spring back to full the next time its
// hue is touched.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// The picker's own geometry, since jsdom lays nothing out: a 240px square and
// 240px bars, so a fraction across is a pixel position.
const SIZE = 240;

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const entry = path.join(buildDir, 'color-alpha.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { default as ColorPicker } from ${JSON.stringify(
      path.join(__dirname, '..', 'src', 'style-panel', 'components', 'ColorPicker.tsx')
    )};\n`
  );
  const out = path.join(buildDir, 'color-alpha.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  // Everything the picker measures, since jsdom reports zeroes — a zero-width
  // track divides to NaN and no drag reports anything at all.
  dom.window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, top: 0, left: 0, right: SIZE, bottom: SIZE, width: SIZE, height: SIZE };
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { ColorPicker } = require(out);

  const host = dom.window.document.getElementById('root');
  let emitted = [];
  const open = async (value) => {
    emitted = [];
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ColorPicker, {
          value,
          anchor: { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
          trigger: null,
          onChange: (color, live) => emitted.push({ color, live }),
          onClose: () => {},
        })
      );
    });
    await act(async () => {});
    return root;
  };
  // A drag is a pointerdown on the surface, which reports immediately.
  const dragOn = async (selector, fx, fy = 0.5) => {
    const el = dom.window.document.querySelector(selector);
    if (!el) throw new Error(`no ${selector}`);
    await act(async () => {
      const event = new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clientX', { value: fx * SIZE });
      Object.defineProperty(event, 'clientY', { value: fy * SIZE });
      el.dispatchEvent(event);
    });
  };
  const last = () => emitted[emitted.length - 1]?.color ?? '';
  const alphaOf = (color) => {
    const m = color.match(/rgba?\(([^)]*)\)/);
    if (!m) return color.startsWith('#') && color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1;
    const parts = m[1].split(',').map((p) => parseFloat(p));
    return parts.length > 3 ? parts[3] : 1;
  };

  // --- nothing set yet ---------------------------------------------------------
  let root = await open('');
  await dragOn('.u-color-sb', 0.8, 0.3);
  check('a drag on an unset colour comes out visible', alphaOf(last()) === 1, last());
  check('and picks the colour that was dragged to', /^rgb/.test(last()) && !/, 0\)$/.test(last()), last());
  // A first colour has no notation to preserve, so it is written the way this
  // panel has always written one.
  check('a colour with nothing to follow is written as rgb()', /^rgba?\(/.test(last()), last());
  await act(async () => { root.unmount() });

  root = await open('');
  await dragOn('.u-color-slider', 0.5);
  check('so does a drag on the hue bar', alphaOf(last()) === 1, last());
  await act(async () => { root.unmount() });

  // --- the alpha, once it is a choice -------------------------------------------
  root = await open('');
  await dragOn('.u-color-alpha', 0.4);
  const chosen = alphaOf(last());
  check('dragging the alpha bar sets the alpha it was dragged to', chosen > 0.3 && chosen < 0.5, last());
  await dragOn('.u-color-sb', 0.2, 0.2);
  check('and a later drag keeps it', Math.abs(alphaOf(last()) - chosen) < 0.02, last());
  await act(async () => { root.unmount() });

  // 0 is a choice like any other: a colour faded to nothing on purpose must not
  // spring back to full the next time its hue is touched.
  root = await open('');
  await dragOn('.u-color-alpha', 0);
  check('including when what was chosen is nothing', alphaOf(last()) === 0, last());
  await dragOn('.u-color-sb', 0.6, 0.4);
  check('which a hue drag then leaves alone', alphaOf(last()) === 0, last());
  await act(async () => { root.unmount() });

  // --- a colour that was already set --------------------------------------------
  root = await open('rgba(255, 0, 0, 0.5)');
  await dragOn('.u-color-sb', 0.5, 0.5);
  check('an existing alpha is never touched', Math.abs(alphaOf(last()) - 0.5) < 0.02, last());
  await act(async () => { root.unmount() });

  root = await open('#3366ff');
  await dragOn('.u-color-sb', 0.5, 0.5);
  check('an opaque colour stays opaque', alphaOf(last()) === 1, last());
  await act(async () => { root.unmount() });

  // `transparent` written out and a property never set at all read the same in
  // the field, and a drag on either is somebody asking for a colour they can
  // see — so they behave the same.
  root = await open('transparent');
  await dragOn('.u-color-sb', 0.5, 0.5);
  check('an explicit `transparent` lifts the same way', alphaOf(last()) === 1, last());
  await act(async () => { root.unmount() });

  // …and it is understood as a colour in the first place, canvas or no canvas:
  // without that the picker opens on opaque black for a value that is nothing.
  root = await open('transparent');
  // The property, not the attribute: React writes the value onto the DOM node,
  // and reading the attribute would answer null and pass whatever happened.
  const hexShown = dom.window.document.querySelector('.u-color-field-input')?.value;
  check('and opens showing no opacity, not opaque black', hexShown === '#00000000', String(hexShown));
  await act(async () => { root.unmount() });

  // --- the notation toggle ------------------------------------------------------
  //
  // The button under the three channel fields cycles RGB → HSL → HSB. It was
  // only changing which channels the fields showed: pick HSL and the fields read
  // H/S/L while the declaration stayed `rgb(224, 4, 4)`, which is the toggle
  // appearing to do nothing to the thing it is about. Picking a notation now
  // rewrites the value in it.
  root = await open('rgb(224, 4, 4)');
  const press = async (selector) => {
    const button = dom.window.document.querySelector(selector);
    if (!button) throw new Error(`no ${selector}`);
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});
  };
  const cycle = () => press('.u-color-mode.is-channel');
  const pressHex = () => press('.u-color-mode.is-hex');
  const letters = () =>
    [...dom.window.document.querySelectorAll('.u-color-mode.is-channel span')].map((s) => s.textContent).join('');
  const hexOn = () => !!dom.window.document.querySelector('.u-color-mode.is-hex.is-on');

  // RGB → HEX → HSL, which are the three notations CSS can spell. (HSB was the
  // third and could only ever write rgb(), so the toggle changed the numbers and
  // left the declaration alone.)
  check('a colour written as rgb() opens on RGB', letters() === 'RGB' && !hexOn(), letters());

  // Two buttons, two jobs. HEX is its own, since hex is not a third kind of
  // channel — it is R/G/B spelled differently, with a label of its own already
  // sitting beside them.
  await pressHex();
  check('the HEX button writes a hex value', /^#[0-9a-f]{6,8}$/i.test(last()), last());
  check('and lights', hexOn());
  check(
    'while the numbers, which are still R/G/B, say what they are',
    letters() === 'RGB',
    letters()
  );
  await cycle();
  check('the pill comes back to the notation its letters show', /^rgba?\(/.test(last()), last());
  check('with hex no longer lit', !hexOn());
  check('and the letters unchanged', letters() === 'RGB', letters());
  await cycle();
  // `hsl(…)` exactly, not `rgb(…)`: the panel used to normalize every write
  // through hslaToRgba on its way out — a rule for Webflow's native API, which
  // rejects hsl and which this app does not have at all. So HSL could change the
  // numbers on screen and never the declaration.
  check('switching to HSL writes hsl()', /^hsl\(/.test(last()), last());
  check('and keeps the colour it was', /^hsla?\(\s*0[,\s]/.test(last()), last());
  check('with the columns following', letters() === 'HSL' && !hexOn(), letters());
  await cycle();
  check('and back to rgb() — two states, not three', /^rgba?\(/.test(last()) && letters() === 'RGB', last());
  // Hex from HSL keeps the H/S/L numbers on screen: the pill says what the
  // fields hold, and they still hold those.
  await cycle();
  await pressHex();
  check('HEX from HSL still writes hex', /^#[0-9a-f]{6,8}$/i.test(last()), last());
  check('and leaves the fields as they were', letters() === 'HSL', letters());
  await cycle();
  check('so the pill returns to hsl(), which is what it shows', /^hsl\(/.test(last()), last());
  await act(async () => { root.unmount() });

  // The picker opens in the notation the value is already written in, so opening
  // one never rewrites what it is looking at.
  root = await open('hsl(0, 96%, 45%)');
  check('an hsl value opens on HSL', letters() === 'HSL', letters());
  await act(async () => { root.unmount() });
  root = await open('#3366ff');
  check('and a hex value opens on HEX', hexOn(), 'hex not marked');
  await dragOn('.u-color-sb', 0.5, 0.5);
  check('so a drag on it stays hex', /^#[0-9a-f]{6,8}$/i.test(last()), last());
  await act(async () => { root.unmount() });

  // Cycling the notation on a colour nobody has set must not set one.
  root = await open('');
  await cycle();
  check('an unset colour is left unset', emitted.length === 0, JSON.stringify(emitted));
  await act(async () => { root.unmount() });

  // An opaque colour is `hsl()`; one with alpha is `hsla()`, which is the same
  // notation with the channel CSS needs for it.
  root = await open('rgba(224, 4, 4, 0.5)');
  await cycle();
  check('a colour with alpha writes hsla()', /^hsla\(/.test(last()), last());
  check('carrying the alpha it had', /0\.5\s*\)$/.test(last()), last());
  await act(async () => { root.unmount() });

  // The panel writes what was authored, and only converts on the way to a native
  // Webflow style — which is not a thing that exists here.
  const editor = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'EmbedEditor.tsx'),
    'utf8'
  );
  const setPropAt = editor.indexOf('const setProp = (prop: string');
  check(
    'a committed write is not converted on its way out',
    !/hslaToRgba/.test(editor.slice(setPropAt, setPropAt + 700)),
    'setProp still normalizes hsl away'
  );
  const liveAt = editor.indexOf('const liveSetProp = (prop: string');
  check(
    'nor is a live one',
    !/value = hslaToRgba/.test(editor.slice(liveAt, liveAt + 700)),
    'liveSetProp still normalizes hsl away'
  );
  check(
    'but a native write still is, where the API demands it',
    /const nativeSetOrFallback[\s\S]{0,200}hslaToRgba/.test(editor)
  );

  // --- the hex field ------------------------------------------------------------
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'utilities.css'),
    'utf8'
  );
  const wide = css.slice(css.indexOf('.u-color-field.is-wide .u-color-field-input'));
  check(
    'the hex field has room at the edge its text starts from',
    /padding-inline: var\(--space-4\)/.test(wide.slice(0, wide.indexOf('}'))),
    wide.slice(0, wide.indexOf('}'))
  );
  // The app used to paint a hover on every input, the panel's included:
  // `:where(.style-panel-host) input` costs zero specificity, so a plain
  // `input:hover` outranked the panel's own field styling and the fields
  // flickered on the way past. What matters is that no such rule reaches them —
  // whether by being scoped away or by not existing.
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  const unscoped = app
    .split('\n')
    .filter((line) => /^\s*(input|select|textarea):hover[^{]*\{/.test(line))
    .filter((line) => !line.includes('style-panel-host'));
  check(
    'and the app paints no hover over the panel it does not dress',
    unscoped.length === 0,
    unscoped.join(' | ')
  );

  if (failures.length) {
    console.error(`\ncolor-alpha: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`color-alpha: ${checked} passed  [first drag on an unset colour]`);
  process.exit(0);
})();
