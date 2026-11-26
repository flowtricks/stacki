// Goal: removing a comment pin shows no toast, so the app's Undo is how it comes back. The removal is a step of the one
// history every other change uses, so Undo and Redo take steps newest first, a pin's among the others.
// Method: the real pin store with the app's real history hooks (useHistoryPush's pushCommand and useUndoRedo), installed
// as DesktopPins.tsx installs them, with other recorded changes before and after the removal. The routing of ⌘Z
// between a text field and the app is appShortcuts.ts's and is not touched by this.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/pinUndoOrder.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: ["export * as pins from './src/features/ai/pins/pinStore';", "export { useHistoryPush, useUndoRedo } from './src/app/state/appHistory';"].join(
      '\n',
    ),
    resolveDir: repoPath('.'),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff2': 'empty' },
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
global.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
dom.window.avb = {
  platform: 'darwin',
  aiPinsRead: async () => ({ ok: true, value: { board: { version: 1, pins: [] }, images: [] } }),
  aiPinsWrite: async () => ({ ok: true, value: { saved: true } }),
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const ui = require(output);

test('Undo and Redo take a removed pin in order with the other changes', async () => {
  const historyRef = { current: { past: [], future: [], lastPush: 0, lastKey: undefined } };
  let app;
  const Host = () => {
    const push = ui.useHistoryPush({ pageStateRef: { current: {} } }, { historyRef });
    const steps = ui.useUndoRedo(
      { propertySave: { saving: { current: false } } },
      { setHistoryTick: () => undefined },
      { historyRef, showToast: (message) => assert.fail(`no toast: ${message}`) },
      { stepEdits: async () => assert.fail('no page edit here') },
    );
    app = { ...push, ...steps };
    return undefined;
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Host)));
  const translate = (key) => key;
  await ui.pins.loadPins('/site');
  ui.pins.setPinHistory((step) => app.pushCommand(step));
  const log = [];
  const change = (name) => app.pushCommand({ undo: async () => void log.push(`undo ${name}`), redo: async () => void log.push(`redo ${name}`) });
  const id = ui.pins.dropPin(
    {
      anchor: { path: '0.1', occurrence: 0, at: { x: 0.5, y: 0.5 }, tag: 'h1', text: 'Welcome' },
      place: {
        page: 'src/pages/index.astro',
        pageLabel: 'Home',
        scope: undefined,
        file: 'src/pages/index.astro',
        locator: '0.1',
        elementLabel: 'Heading',
        componentFile: undefined,
        breakpointPx: 768,
      },
    },
    translate,
  );
  ui.pins.setPinComment(id, 'Bigger');
  ui.pins.savePinBox();
  const there = () => ui.pins.pinState().board.pins.some((pin) => pin.id === id);
  change('first');
  ui.pins.deletePin(id, translate);
  change('last');

  await act(() => app.undo());
  assert.deepEqual([log.splice(0), there()], [['undo last'], false], 'the newest change goes first, the pin stays removed');
  await act(() => app.undo());
  assert.deepEqual([log.splice(0), there()], [[], true], 'then the pin comes back');
  await act(() => app.undo());
  assert.deepEqual([log.splice(0), there()], [['undo first'], true]);
  await act(() => app.redo());
  assert.deepEqual([log.splice(0), there()], [['redo first'], true]);
  await act(() => app.redo());
  assert.deepEqual([log.splice(0), there()], [[], false], 'Redo removes it again');
  await act(() => app.redo());
  assert.deepEqual([log.splice(0), there()], [['redo last'], false]);
  await act(async () => root.unmount());
  await ui.pins.closePins();
});
