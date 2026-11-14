// Goal: pin the two Central icons added for the style panel's menus and variables.
//
//   node test/renderer/style/variableIcons.test.js
//
// 1. The blue/orange field label's menu item ("Clear", Option + click) draws Central's
//    `arrow-rotate-counter-clockwise`; so does the clip-path label's.
// 2. A variable whose resolved value is a plain percentage (50%, -5%, a chain ending in one)
//    is typed Percentage by the picker's varKind and `percentage` by the Variables panel's
//    kindOf, and both draw Central's `pie-chart-1`. A calc() or color-mix() holding a %, a bare
//    number and a length are not percentages.
// Method: the real modules are bundled with esbuild into jsdom. Icons are asserted by their
// registered name (`data-central-icon`), never by pixels; the kind detectors are called
// directly, then the real PickerItem and panel VariableTypeIcon render what they return.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/variable-icons');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as FieldLabel } from './src/features/style/components/FieldLabel'
export { PickerItem } from './src/features/style/VariablePicker'
export { default as PanelTypeIcon } from './src/features/variables/VariableTypeIcon'
export { varKind, resolveAlias } from './src/features/style/model/projectResources'
export { kindOf } from './electron/project/cssVarValues'`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', 'postcss', 'electron'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.Element.prototype.scrollIntoView = () => {};
  // The jsdom window has no CSS.supports; the detectors only need it to say "not a colour / not a width"
  // for the values below, which the regex branches then decide.
  global.CSS = { supports: () => false };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { FieldLabel, PickerItem, PanelTypeIcon, varKind, resolveAlias, kindOf } = require(bundlePath);

  const PIE = 'pie-chart-1';

  // Picker kind: plain percentages only.
  for (const value of ['50%', '12.5%', '-5%', '0%', '100%', ' 25% ', '.5%']) {
    assert.equal(varKind('x', value), 'Percentage', `varKind ${JSON.stringify(value)}`);
    assert.equal(kindOf(value, value), 'percentage', `kindOf ${JSON.stringify(value)}`);
  }
  assert.equal(varKind('x', 'calc(100% - 1rem)'), 'Size', 'calc() holding a % is a size');
  assert.equal(kindOf('calc(100% - 1rem)', 'calc(100% - 1rem)'), 'size');
  assert.equal(varKind('x', 'color-mix(in srgb, red 20%, blue)'), 'Color', 'color-mix() holding a % is a colour');
  assert.equal(kindOf('color-mix(in srgb, red 20%, blue)', 'color-mix(in srgb, red 20%, blue)') === 'percentage', false);
  assert.equal(varKind('x', '50'), 'Number', 'a bare number');
  assert.equal(kindOf('50', '50'), 'number');
  assert.equal(varKind('x', '50px'), 'Size', 'a length');
  assert.equal(kindOf('50px', '50px'), 'size');
  assert.equal(varKind('x', '%'), 'String', 'a lone percent sign is nothing');
  assert.equal(varKind('x', '5%%'), 'String', 'a doubled percent sign is nothing');

  // A chain resolves before it is typed (the caller resolves, as streamProjectVariables does).
  const values = new Map([
    ['a', 'var(--b)'],
    ['b', 'var(--c)'],
    ['c', '37.5%'],
  ]);
  assert.equal(varKind('a', resolveAlias('var(--a)', values)), 'Percentage', 'a var() chain ending in a percentage');
  assert.equal(kindOf('var(--a)', '37.5%'), 'percentage', 'the panel types its resolved value');

  const host = document.getElementById('root');
  const root = createRoot(host);
  const mount = (element) =>
    act(async () => {
      root.render(element);
    });
  const iconsIn = (container) => [...container.querySelectorAll('svg[data-central-icon]')].map((svg) => svg.getAttribute('data-central-icon'));

  // The picker draws the pie for a percentage variable and not for a length.
  const pick = (value) => {
    const variable = { name: 'v', value, type: varKind('v', value), collection: 'site.css', group: ':root', binding: 'var(--v)' };
    return React.createElement(PickerItem, { variable, collection: 'site.css', group: '', selected: false, onPick() {} });
  };
  await mount(pick('50%'));
  assert.deepEqual(
    iconsIn(host).filter((name) => name === PIE),
    [PIE],
    'picker: a percentage variable shows pie-chart-1',
  );
  await mount(pick('50px'));
  assert.equal(iconsIn(host).includes(PIE), false, 'picker: a length does not');
  await mount(pick('calc(100% - 1rem)'));
  assert.equal(iconsIn(host).includes(PIE), false, 'picker: a calc() with a % does not');

  // The Variables panel's row icon.
  await mount(React.createElement(PanelTypeIcon, { kind: kindOf('12.5%', '12.5%') }));
  assert.deepEqual(iconsIn(host), [PIE], 'panel: a percentage variable shows pie-chart-1');
  await mount(React.createElement(PanelTypeIcon, { kind: kindOf('1rem', '1rem') }));
  assert.equal(iconsIn(host).includes(PIE), false, 'panel: a length does not');

  // The label menu's Clear item.
  await mount(React.createElement(FieldLabel, { active: true, onReset() {}, resetLabel: 'Clear' }, 'Width'));
  await act(async () => {
    host.querySelector('button.u-field-label').click();
  });
  const item = host.querySelector('[role="menuitem"]');
  assert.ok(item, 'the label opens a menu');
  assert.deepEqual(iconsIn(item), ['arrow-rotate-counter-clockwise'], 'Clear draws arrow-rotate-counter-clockwise');

  console.log('variableIcons: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
