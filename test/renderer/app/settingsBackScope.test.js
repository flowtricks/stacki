// Goal: a rail panel a person moved into the Settings panel opens with Settings' back chevron in its own header,
// returning to the Settings list, while a panel that lives on the rail opens without one. The chevron is the shared
// header's (one header, never two stacked), Escape outside a field returns too, a panel's own detail back wins over
// the inherited one, the chevron mirrors in right-to-left interfaces, and dragging the panel back out drops it.
// Method: bundle the real SettingsBackScope and PanelHeader with esbuild, mount them in jsdom with a rail order in
// localStorage (the store the rail and Settings share), and drive clicks and keys with real DOM events.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/settings-back-scope.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { SettingsBackScope } from './src/app/SettingsBackScope';",
      "export { PanelHeader } from './src/ui/PanelHeader';",
      "export { moveIntoSettings, moveOutOfSettings } from './src/app/railOrder';",
      "export { writeRailOrder } from './src/app/railOrderStore';",
      "export { DEFAULT_RAIL_ORDER } from './src/app/railDefaults';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'StorageEvent', 'localStorage']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const scope = require(output);

let root;
let backs = 0;
async function mount(tab, header = { title: 'Assets' }) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        scope.SettingsBackScope,
        { tab, onBack: () => (backs += 1) },
        React.createElement(
          'div',
          { className: 'panel-section' },
          React.createElement(scope.PanelHeader, header),
          React.createElement('input', { 'aria-label': 'Search' }),
        ),
      ),
    ),
  );
}
async function unmount() {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('dir');
}
const backButton = () => document.querySelector('.panel-header-back') ?? undefined;
const press = (target, key) => act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));

test.beforeEach(async () => {
  localStorage.clear();
  backs = 0;
  // Assets moved into Settings; Pages stays on the rail.
  await act(async () => scope.writeRailOrder(scope.DEFAULT_RAIL_ORDER, scope.moveIntoSettings(scope.DEFAULT_RAIL_ORDER, 'assets')));
});

test('a panel moved into Settings shows the back chevron in its own header and returns to the Settings list', async () => {
  await mount('assets');
  assert.ok(backButton(), 'the chevron is drawn');
  assert.equal(backButton().getAttribute('aria-label'), 'Back to settings');
  assert.equal(document.querySelectorAll('.panel-header').length, 1, 'one header: the chevron sits in the panel’s own, beside its title');
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Assets');
  await act(async () => backButton().click());
  assert.equal(backs, 1);
  await unmount();
});

test('a panel that lives on the rail opens without the chevron', async () => {
  await mount('pages', { title: 'Pages' });
  assert.equal(backButton(), undefined);
  await press(document.querySelector('.panel-section'), 'Escape');
  assert.equal(backs, 0, 'Escape does not leave a rail panel');
  await unmount();
});

test('Escape outside a field returns to Settings; inside a field, or already handled, it does not', async () => {
  await mount('assets');
  await press(document.querySelector('input'), 'Escape');
  assert.equal(backs, 0, 'a field keeps its Escape');
  const handled = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  handled.preventDefault();
  await act(async () => document.querySelector('.panel-section').dispatchEvent(handled));
  assert.equal(backs, 0, 'an Escape a menu already handled stays handled');
  backButton().focus();
  await press(backButton(), 'Escape');
  assert.equal(backs, 1);
  await press(backButton(), 'Enter');
  assert.equal(backs, 1, 'only Escape leaves by key');
  await unmount();
});

test('a panel’s own detail back wins over the inherited one', async () => {
  let own = 0;
  await mount('assets', { title: 'Folder', back: { label: 'Back to assets', onBack: () => (own += 1) } });
  assert.equal(backButton().getAttribute('aria-label'), 'Back to assets');
  await act(async () => backButton().click());
  assert.equal(own, 1);
  assert.equal(backs, 0);
  await unmount();
});

test('the chevron is the mirrored one, so it points toward the start in a right-to-left interface', async () => {
  document.documentElement.setAttribute('dir', 'rtl');
  await mount('assets');
  assert.ok(backButton().querySelector('svg').classList.contains('icon-mirror-rtl'), 'the chevron carries the mirroring class (controls.css)');
  await unmount();
});

test('dragging the panel back out to the rail drops the chevron at once', async () => {
  await mount('assets');
  assert.ok(backButton());
  const moved = scope.moveIntoSettings(scope.DEFAULT_RAIL_ORDER, 'assets');
  await act(async () => scope.writeRailOrder(scope.DEFAULT_RAIL_ORDER, scope.moveOutOfSettings(moved, 'assets')));
  assert.equal(backButton(), undefined);
  await unmount();
});
