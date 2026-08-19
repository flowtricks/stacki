// A popup opened from inside a popover belongs to it.
//
//   node test/popup-layers.js
//
// The variable picker and the colour picker are drawn through portals: whatever
// they were opened from, they land at the end of <body>. Every popover closes on
// "a press outside me", and outside is a `contains()` — which for a portalled
// child is always true. So pressing the purple dot closed the spacing editor the
// dot lives in, and pressing HEX closed the shadow layer whose colour was being
// picked, each taking its own child popup down with it.
//
// A popup registers where it was opened FROM, and that anchor is the link the DOM
// doesn't have. These check the registry that answers it.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'popup-layers.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { registerPopupLayer, inOwnedPopup, hasOwnedPopup } from './lib/popup-layer'`,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
      loader: 'ts',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { registerPopupLayer, inOwnedPopup, hasOwnedPopup } = require(bundlePath);

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<!doctype html><body>
    <div id="popover"><span id="dot"></span><div id="swatch"></div></div>
    <div id="picker"><button id="option">brand</button></div>
    <div id="colour"><button id="hex">HEX</button></div>
    <div id="elsewhere"><button id="other">x</button></div>
  </body>`);
  const $ = (id) => dom.window.document.getElementById(id);

  const offPicker = registerPopupLayer($('picker'), $('dot'));
  const offColour = registerPopupLayer($('colour'), $('swatch'));

  check(
    'a press in the variable picker is a press in the popover it opened from',
    inOwnedPopup($('option'), $('popover'))
  );
  check(
    'so is a press on HEX, in the layer holding the swatch',
    inOwnedPopup($('hex'), $('popover'))
  );
  check('a press anywhere else is still outside', !inOwnedPopup($('other'), $('popover')));
  check('the popover can tell it has a popup of its own open', hasOwnedPopup($('popover')));
  check('an unrelated element owns nothing', !hasOwnedPopup($('elsewhere')));

  // Chains: a popup opened from inside another popup still belongs to the popover
  // at the bottom of the stack — the picker inside the big value editor, say.
  const offNested = registerPopupLayer($('elsewhere'), $('hex'));
  check(
    'a popup opened from inside another still belongs to the popover',
    inOwnedPopup($('other'), $('popover'))
  );
  offNested();

  offPicker();
  offColour();
  check('a closed popup stops counting', !inOwnedPopup($('option'), $('popover')));
  check('and stops being owned', !hasOwnedPopup($('popover')));

  // The wiring: the popovers that close on an outside press have to ask.
  const files = {
    'LayerPopover.tsx': 'the layer editor',
    'SpacingBox.tsx': 'the spacing editor',
  };
  for (const [file, what] of Object.entries(files)) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'style-panel', file), 'utf8');
    check(`${what} asks before closing on a press`, /inOwnedPopup\(/.test(src), file);
  }
  const pickers = {
    'components/ColorPicker.tsx': 'the colour picker',
    'VariableConnect.tsx': 'the variable picker',
  };
  for (const [file, what] of Object.entries(pickers)) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'style-panel', file), 'utf8');
    check(`${what} says where it was opened from`, /registerPopupLayer\(/.test(src), file);
  }

  // --- and the popover it all happens in stays open --------------------------
  //
  // The registry is only half of it: the spacing editor also closes when its field
  // loses focus, and both of these take focus away — the picker for its search box,
  // the big editor outright. Driven through the real component, because the timing
  // is the part that was wrong (the search box takes focus as it mounts, before a
  // passive effect could announce the popup).
  {
    const popupBundle = path.join(buildDir, 'popup-layers-spacing.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'SpacingBox.tsx')],
      outfile: popupBundle,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
      loader: { '.css': 'empty' },
      logLevel: 'silent',
      plugins: [
        {
          name: 'stub-variables',
          setup(build) {
            build.onResolve({ filter: /lib\/webflow$/ }, () => ({ path: 'stub-webflow', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
              contents: `
                export function streamProjectVariables(onAdd) {
                  onAdd({ name: 'site-margin', collection: 'Sizes', group: '', value: '2rem', binding: 'var(--site-margin)', kind: 'Size' });
                  return Promise.resolve([]);
                }
              `,
              loader: 'js',
            }));
          },
        },
      ],
    });

    const win = new (require('jsdom').JSDOM)('<!doctype html><div id="root"></div>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    }).window;
    const prev = { window: global.window, document: global.document, navigator: global.navigator };
    global.window = win;
    global.document = win.document;
    global.navigator = win.navigator;
    global.Node = win.Node;
    global.Element = win.Element;
    global.HTMLElement = win.HTMLElement;
    global.getComputedStyle = win.getComputedStyle;
    global.MutationObserver = win.MutationObserver;
    global.requestAnimationFrame = (fn) => win.setTimeout(fn, 0);
    global.cancelAnimationFrame = (id) => win.clearTimeout(id);
    global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    win.ResizeObserver = global.ResizeObserver;
    global.IS_REACT_ACT_ENVIRONMENT = true;

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { act } = React;
    const { SpacingEditor } = require(popupBundle);

    const value = 'calc(2rem + )';
    const writes = [];
    let closes = 0;
    const root = createRoot(win.document.getElementById('root'));
    const settle = () => act(async () => { await new Promise((r) => win.setTimeout(r, 25)); });
    await act(async () => {
      root.render(
        React.createElement(SpacingEditor, {
          prop: 'padding-bottom',
          side: 'bottom',
          placeholder: '0',
          read: (p) =>
            p === 'padding-bottom'
              ? {
                  prop: p,
                  source: 'selected',
                  selectedValue: { value, important: false },
                  winner: { value, selectorText: '.hero', important: false },
                  overridden: false,
                  contributors: [],
                }
              : undefined,
          setProp: (p, v) => writes.push(`${p}: ${v}`),
          clearProp: () => {},
          liveSetProp: () => {},
          onSelectSelector: () => {},
          onClose: () => { closes += 1; },
          onSameLabelPress: () => {},
        })
      );
    });
    await settle();
    const popover = () => win.document.querySelector('.embed-editor_spacing-popover');
    check('the spacing editor opens', !!popover());

    const press = (el) => {
      el.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    };

    await act(async () => { press(popover().querySelector('.embed-editor_varconnect-dot')); });
    await settle();
    check('the dot opens the variable picker', !!win.document.querySelector('.embed-editor_varpicker'));
    check('and the editor it opened from stays open', closes === 0, `${closes} closes`);

    const row = [...win.document.querySelectorAll('button')].find((b) => /site-margin/.test(b.textContent || ''));
    check('the picker lists a variable', !!row);
    if (row) {
      await act(async () => { press(row); });
      await settle();
      check('choosing one writes it', writes.length === 1, JSON.stringify(writes));
    }

    const rich = popover()?.querySelector('.embed-editor_varconnect-editor');
    if (rich) {
      await act(async () => {
        rich.focus();
        rich.dispatchEvent(new win.KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
      });
      await settle();
      check('= opens the big value editor', !!win.document.querySelector('.var-custom'));
      check('which does not close the editor under it', closes === 0, `${closes} closes`);
    }

    await act(async () => { root.unmount(); });
    global.window = prev.window;
    global.document = prev.document;
    global.navigator = prev.navigator;
  }

  if (failures.length) {
    console.error(`popup-layers: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`popup-layers: ${checked} passed  [ownership, chains, wiring]`);
})();
