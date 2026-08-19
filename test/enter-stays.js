// Pressing Enter in a value field.
//
//   node test/enter-stays.js
//
// The panel's value fields write on blur — one commit path, whether you tab
// away, click elsewhere, or press Enter — and Enter reached it by blurring. The
// value was saved and the field was gone: after typing `20rem` there was nothing
// focused, so the arrow keys that nudge a value (⇧ to the nearest ten, ⌥ finer)
// had nothing
// to nudge, and a value you wanted to feel your way to took a click to get back
// into. Typing a value and adjusting it are one thought.
//
// So Enter still commits through blur — that is what writes — and the field is
// handed straight back with the caret where it was. These drive the real Size
// section: type, Enter, and then arrow the value up without touching the mouse.

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
  const bundlePath = path.join(buildDir, 'enter-stays.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { default as SizeSection } from './SizeSection'
        export { commitInPlace } from './lib/commit-in-place'
      `,
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
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
  };
  dom.window.avb = { listAssets: async () => ({ entries: [] }) };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { SizeSection, commitInPlace } = require(bundlePath);

  const committed = [];
  const props = {
    read: () => undefined, // nothing set — every field starts empty
    busy: false,
    setProp: (prop, value) => committed.push(`${prop}=${value}`),
    clearProp: (prop) => committed.push(`${prop}=cleared`),
    liveSetProp: () => {},
    onProvenance: () => {},
    onSelectSelector: () => {},
  };

  const root = createRoot(document.getElementById('root'));
  await act(async () => { root.render(React.createElement(SizeSection, props)); });

  const field = document.querySelector('input[data-prop="max-width"]');
  check('the Max W field is there', field != null);

  const type = async (text) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(field, text);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const press = async (key, init = {}) => {
    await act(async () => {
      field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    });
  };

  await act(async () => { field.focus(); });
  await type('20rem');
  await press('Enter');

  check('Enter commits the value', committed.includes('max-width=20rem'), committed.join(','));
  check('and leaves the field focused', document.activeElement === field, String(document.activeElement?.tagName));
  check('with the value still in it', field.value === '20rem', field.value);
  check('and the caret where it was', field.selectionStart === '20rem'.length, `${field.selectionStart}`);

  // The point of staying: the arrow keys work straight away.
  await press('ArrowUp');
  check('an arrow key then steps the value', field.value === '21rem', field.value);
  // Shift snaps to the nearest ten (21 → 20), and Alt on a rem value nudges by a
  // pixel's worth of it — see lib/number-step.
  await press('ArrowDown', { shiftKey: true });
  check('shift snaps to the nearest ten', field.value === '20rem', field.value);
  await press('ArrowUp', { altKey: true });
  check('option nudges a rem by one pixel', field.value === '20.0625rem', field.value);

  // Enter again, on the stepped value: committed, and still focused.
  const before = committed.length;
  await press('Enter');
  check('Enter commits what the arrows made of it', committed.length === before + 1 && committed[committed.length - 1] === 'max-width=20.0625rem', committed[committed.length - 1]);
  check('and still does not throw the field away', document.activeElement === field);

  // Tabbing away still commits, and now the field really is left.
  await act(async () => { field.blur(); });
  check('blurring commits as it always did', committed[committed.length - 1] === 'max-width=20.0625rem', committed[committed.length - 1]);
  check('and leaves the field', document.activeElement !== field, String(document.activeElement?.tagName));

  // The helper itself, on a field with no selection to restore (a colour input
  // throws on setSelectionRange) — it must not take the caller down with it.
  const odd = document.createElement('input');
  odd.type = 'color';
  document.body.appendChild(odd);
  let threw = false;
  try { commitInPlace(odd); } catch { threw = true; }
  check('a field with no caret is handled', !threw);

  if (failures.length) {
    console.error(`enter-stays: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`enter-stays: ${checked} passed  [type, Enter, arrow, Enter]`);
  process.exit(0);
})();
