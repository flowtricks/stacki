// The picker offers a variable only where its computed value is valid in the slot it would fill.
//
//   node test/renderer/style/variablePickerSlot.test.js
//
// Goal: the same variable is hidden directly in `width` and shown inside `calc(2rem * [slot])`;
// a percentage is hidden for `color` and shown in a `color-mix()` slot; a length is valid after
// `+` and not after `*`; a shorthand slot, a custom property, an empty field, a half-typed
// expression and an ancestor override each behave as the browser's grammar says; and through the
// mounted field the slot is read from the chip pressed.
// Method: the real picker is bundled into jsdom. jsdom has no CSS.supports, so `CSS` is given the
// small grammar below (the one the unit test uses), standing in for Chromium's; the call the
// picker makes is the real `CSS.supports(property, value)`. Variables carry the computed values a
// cascade would give two elements, passed as the canvas answer would be. Events are dispatched;
// nothing needs a pointer.

const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const LENGTH = /^-?[\d.]+(?:rem|em|px)$/;
const NUMBER = /^-?[\d.]+$/;
const PERCENT = /^-?[\d.]+%$/;
const COLOR = /^(?:#[0-9a-f]{3,8}|red|currentcolor|transparent)$/i;
const supports = (property, value) => {
  if (value === 'inherit') {
    return ['width', 'font-size', 'color', 'margin', 'font-weight'].includes(property);
  }
  const calculate = /^calc\((.+)\)$/.exec(value);
  if (calculate) {
    const [left = '', operator = '', right = ''] = calculate[1].split(/\s+([*+/-])\s+/);
    if (operator === '*') {
      return (LENGTH.test(left) && NUMBER.test(right)) || (NUMBER.test(left) && LENGTH.test(right));
    }
    return (operator === '+' || operator === '-') && LENGTH.test(left) && LENGTH.test(right);
  }
  const mix = /^color-mix\(in srgb, red (.+), transparent 90%\)$/.exec(value);
  if (mix) {
    return PERCENT.test(mix[1]);
  }
  switch (property) {
    case 'width':
    case 'font-size':
      return LENGTH.test(value) || PERCENT.test(value);
    case 'color':
      return COLOR.test(value);
    case 'margin':
      return value.split(/\s+/).every((part) => LENGTH.test(part) || part === '0');
    default:
      return false;
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'variable-picker-slot.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/VariableConnect.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('stub-variables', {
        'src/features/style/model/webflow.ts': () => ({
          contents: `
            const make = (name, value, type) => ({ name, collection: 'site.css', group: ':root', value, binding: 'var(--' + name + ')', type });
            export async function streamProjectVariables(onAdd) {
              for (const [name, value, type] of [['len', '1rem', 'Size'], ['factor', '1.5', 'Number'], ['pct', '10%', 'Size'], ['brand', '#ff0000', 'Color']]) onAdd(make(name, value, type));
              return [];
            }
            export const __stub = true;
          `,
          loader: 'js',
        }),
      }),
    ],
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.CSS = { supports };
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  dom.window.Element.prototype.scrollIntoView = () => {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const VariableConnect = require(bundlePath).default;
  const pickerPath = path.join(buildDirectory, 'variable-picker-slot-picker.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/VariablePicker.tsx')],
    outfile: pickerPath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('stub-webflow', {
        'src/features/style/model/webflow.ts': () => ({ contents: 'export const streamProjectVariables = async () => [];', loader: 'js' }),
      }),
    ],
  });
  const { pickerVariables } = require(pickerPath);
  const { slotOfMarked, SLOT_MARK } = require(repoPath('dist/shared/properties/valueSlot.js'));

  const variables = [
    ['len', '1rem', 'Size'],
    ['factor', '1.5', 'Number'],
    ['pct', '10%', 'Size'],
    ['brand', '#ff0000', 'Color'],
  ].map(([name, value, type]) => ({ name, value, type, collection: 'site.css', group: ':root', binding: `var(--${name})` }));
  const slot = (marked) => slotOfMarked(marked.replace('[slot]', SLOT_MARK));
  const names = (prop, marked, computed) =>
    pickerVariables(variables, prop, '', { slot: marked === undefined ? undefined : slot(marked), ...(computed === undefined ? {} : { computed }) }).map(
      (variable) => variable.name,
    );
  const same = (label, actual, expected) =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);

  same('width, whole value: lengths and percentages only', names('width'), ['len', 'pct']);
  same('width in calc(2rem * slot): the unitless factor only', names('width', 'calc(2rem * [slot])'), ['factor']);
  same('width in calc(2rem + slot): lengths', names('width', 'calc(2rem + [slot])'), ['len']);
  same('font-size, whole value', names('font-size'), ['len', 'pct']);
  same('color, whole value: the colour, no percentage', names('color'), ['brand']);
  same('color in a color-mix percentage slot: the percentage', names('color', 'color-mix(in srgb, red [slot], transparent 90%)'), ['pct']);
  same('margin shorthand slot: lengths', names('margin', '1rem [slot]'), ['len']);
  same('a custom property takes anything', names('--anything'), ['brand', 'factor', 'len', 'pct']);
  same('an empty value is the whole slot', names('width', '[slot]'), ['len', 'pct']);
  same('a half-typed expression never empties the list (property-level fallback)', names('width', 'calc(2rem * [slot]'), ['len', 'pct']);
  same('a property the engine does not know falls back to the type guess, not an empty list', names('panel-only').length > 0, true);
  same(
    'an ancestor override changes the verdict',
    names(
      'width',
      undefined,
      new Map([
        ['--len', '1.5'],
        ['--factor', '2rem'],
        ['--pct', '10%'],
        ['--brand', '#fff'],
      ]),
    ),
    ['factor', 'pct'],
  );

  // The applied variable stays, even where it does not fit.
  const kept = pickerVariables(variables, 'color', '', { selectedBinding: 'var(--pct)' }).map((variable) => variable.name);
  same('the applied variable stays listed', kept, ['brand', 'pct']);

  // Through the field: the slot comes from the chip pressed.
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(
        VariableConnect,
        { onPick() {}, onDraft() {}, ariaLabel: 'Width', prop: 'width', code: true },
        React.createElement('input', { className: 'u-input', value: 'calc(2rem * var(--factor))', onChange() {} }),
      ),
    );
  });
  await settle();
  const chip = host.querySelector('[data-chip]');
  check('the field draws a chip for the variable in the calc()', !!chip);
  if (chip) {
    await act(async () => chip.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })));
    await settle();
    const rows = [...document.querySelectorAll('.embed-editor_varpicker-item')].map((row) => row.dataset.binding);
    same('pressing the chip inside calc(2rem * slot) lists only what multiplies a length', rows, ['var(--factor)']);
  }
  await act(async () => root.unmount());

  if (failures.length > 0) {
    console.error(`variablePickerSlot: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variablePickerSlot: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
