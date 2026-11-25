// Goal: the right panel's Style and Settings tabs show the app's own tooltip with their key, in the rail's
// "Name (key)" form, after the pointer rests on them, and the key a tip names is the key that works.
// Method: mount the real InspectorTabButton (the one Desktop and Studio draw) in jsdom, hover it with mocked
// timers and read what is drawn before and after the delay, then press it. The keys are read through the real
// inspectorTabOfKey, with modified presses as the negative space. Source pins: Desktop's tab strip and Studio's
// draw this button, Desktop's key handler asks inspectorTabOfKey, and the canvas frames of both forward S and D.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/inspector-tab-tips');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'tabs.cjs');
buildSync({
  stdin: {
    contents: [
      "export { InspectorTabButton } from './src/app/shell/InspectorTabButton';",
      "export { INSPECTOR_TAB_KEYS, inspectorTabOfKey } from './src/app/inspectorTabKeys';",
      "export { TOOLTIP_DELAY_MS } from './src/ui/delayedTooltip';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(global, name, { value, configurable: true, writable: true });
}

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const tabs = require(output);

const press = (key, fields = {}) => ({ key, altKey: false, metaKey: false, ctrlKey: false, ...fields });

for (const [tab, label, key] of [
  ['style', 'Style', 'S'],
  ['settings', 'Settings', 'D'],
]) {
  test(`the ${label} tab tips "${label} (${key})" after the wait, and a press takes it away`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const picked = [];
    const root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(tabs.InspectorTabButton, { tab, label, active: false, select: (value) => picked.push(value) })));
    const button = document.querySelector(`[data-right-tab="${tab}"]`);
    const tip = () => document.querySelector('.rail-tooltip')?.textContent;
    const mouse = (type) => act(async () => button.dispatchEvent(new window.MouseEvent(type, { bubbles: true })));
    assert.equal(button.hasAttribute('title'), false, 'never a native tooltip');
    assert.equal(button.getAttribute('aria-keyshortcuts'), key);
    await mouse('mouseover');
    await act(async () => context.mock.timers.tick(tabs.TOOLTIP_DELAY_MS - 1));
    assert.equal(tip(), undefined, 'nothing before the pointer has rested');
    await act(async () => context.mock.timers.tick(1));
    assert.equal(tip(), `${label} (${key})`);
    await mouse('click');
    assert.equal(tip(), undefined, 'the press takes the tip away');
    assert.deepEqual(picked, [tab]);
    await mouse('mouseover');
    await mouse('mouseout');
    await act(async () => context.mock.timers.tick(tabs.TOOLTIP_DELAY_MS));
    assert.equal(tip(), undefined, 'a pointer that leaves early gets no tip');
    await act(async () => root.unmount());
  });
}

test('the keys the tips name pick their tabs, and no modified press does', () => {
  assert.equal(tabs.inspectorTabOfKey(press('s')), 'style');
  assert.equal(tabs.inspectorTabOfKey(press('S')), 'style');
  assert.equal(tabs.inspectorTabOfKey(press('d')), 'settings');
  assert.equal(tabs.inspectorTabOfKey(press('f')), undefined);
  for (const modifier of ['altKey', 'metaKey', 'ctrlKey']) {
    assert.equal(tabs.inspectorTabOfKey(press('s', { [modifier]: true })), undefined, modifier);
    assert.equal(tabs.inspectorTabOfKey(press('d', { [modifier]: true })), undefined, modifier);
  }
});

test('Desktop and Studio draw this tab, read these keys and forward them from the canvas', () => {
  const read = (file) => fs.readFileSync(repoPath(file), 'utf8');
  assert.match(read('src/app/shell/AppPanes.tsx'), /<InspectorTabButton /);
  assert.match(read('studio/src/app/Editor.tsx'), /<InspectorTabButton /);
  assert.match(read('src/app/model/appKeys.ts'), /inspectorTabOfKey\(event\)/);
  assert.match(read('studio/src/app/Editor.tsx'), /inspectorTabOfKey\(event\)/);
  assert.match(read('electron/preload/frameDesign.ts'), /\['s', 'd'\]\.includes/);
  assert.match(read('studio/src/features/preview/previewKeys.ts'), /\n {2}'s',\n/);
});
