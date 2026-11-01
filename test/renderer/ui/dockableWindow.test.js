// Goal: docking preserves the editor while floating tools coexist with the canvas.
// Method: mount the actual frame and nested popup in jsdom, then exercise pointer,
// keyboard, viewport and dismissal events, including iframe crossing and unmount cleanup.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, sourceSpecifier } = require('../../helpers/sources');

test('floating tools preserve content while docking and using the canvas', async () => {
  const directory = repoPath('node_modules/.stacki-test/dockable-window');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'window.cjs');
  await esbuild.build({
    stdin: {
      contents:
        `export {default as Window} from ${sourceSpecifier('src/ui/DockableWindow.tsx')};` +
        `export {default as Popup} from ${sourceSpecifier('src/ui/Popup.tsx')};`,
      resolveDir: repoPath('src'),
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const dom = new JSDOM('<button id="canvas">Canvas</button><div id="root"></div>', {
    pretendToBeVisual: true,
    url: 'https://stacki.test/',
  });
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  global.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  window.matchMedia = () => ({ matches: true });
  const storageDescriptor = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: window.localStorage,
  });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { Window, Popup } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  let changeMode;
  let openChild;
  function App({ hidden = false }) {
    const [mode, setMode] = React.useState('floating');
    const [child, setChild] = React.useState(false);
    changeMode = setMode;
    openChild = () => setChild(true);
    return React.createElement(
      Window,
      {
        mode,
        onModeChange: setMode,
        label: 'Variables',
        hidden,
        minimumSize: { width: 340, height: 220 },
        storageKey: 'test.variables',
        header: React.createElement('span', undefined, 'Styles'),
      },
      React.createElement('input', { defaultValue: 'draft' }),
      React.createElement('div', { className: 'sheet' }),
      child &&
        React.createElement(
          Popup,
          { mode: 'popover', role: 'dialog', label: 'Color', onClose: () => setChild(false) },
          React.createElement('input', { defaultValue: '#abcdef' }),
        ),
    );
  }
  const render = (hidden = false, generation = 0) => act(async () => root.render(React.createElement(App, { hidden, key: generation })));
  const press = (element, type, extra = {}) =>
    act(async () => {
      element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...extra }));
    });
  const key = (element, value) =>
    act(async () => {
      element.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true }));
    });
  try {
    await render();
    let frame = document.querySelector('.dockable-window');
    const input = frame.querySelector('input');
    const sheet = frame.querySelector('.sheet');
    input.value = 'unsaved';
    sheet.scrollTop = 140;
    const geometry = frame.style.cssText;
    input.focus();
    await act(async () => changeMode('docked'));
    assert.equal(frame.dataset.windowMode, 'docked');
    assert.equal(document.activeElement, input);
    assert.equal(frame.querySelector('input'), input);
    assert.equal(input.value, 'unsaved');
    assert.equal(sheet.scrollTop, 140);
    await render(true);
    assert.equal(frame.hidden, true, 'Docked editor follows the active tab');
    await press(frame.querySelector('[aria-label="Undock window"]'), 'click');
    assert.equal(frame.hidden, false, 'Floating editor survives tab changes');
    assert.equal(frame.style.cssText, geometry, 'The floating rectangle survives docking');
    await press(document.getElementById('canvas'), 'pointerdown');
    await act(async () =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data: { type: 'avb:click-node' },
        }),
      ),
    );
    await act(async () => window.dispatchEvent(new window.Event('blur')));
    assert.equal(frame.isConnected, true);
    assert.equal(frame.hidden, false);

    let header = frame.querySelector('.dockable-window-header');
    const originalLeft = Number.parseInt(frame.style.left, 10);
    await key(header, 'ArrowLeft');
    assert.equal(Number.parseInt(frame.style.left, 10), originalLeft - 10);
    await press(header, 'pointerdown', { clientX: 300, clientY: 200 });
    assert.ok(document.querySelector('.window-drag-cover'), 'Drag crosses iframes safely');
    await press(window, 'pointerup', { clientX: 270, clientY: 200 });
    assert.equal(document.querySelector('.window-drag-cover') === null, true);
    assert.equal(Number.parseInt(frame.style.left, 10), originalLeft - 40);
    const width = Number.parseInt(frame.style.width, 10);
    await key(frame.querySelector('.window-resize-e'), 'ArrowRight');
    assert.equal(Number.parseInt(frame.style.width, 10), width + 10);
    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
      window.dispatchEvent(new window.Event('resize'));
    });
    assert.ok(Number.parseInt(frame.style.left, 10) + Number.parseInt(frame.style.width, 10) <= 400);
    assert.equal(frame.querySelector('input'), input);

    await act(async () => openChild());
    await key(header, 'Escape');
    assert.equal(document.querySelector('[aria-label="Color"]') === null, true);
    assert.ok(frame.isConnected, 'Escape closes only the nested picker');
    const savedPlacement = frame.style.cssText;
    await render(false, 1);
    frame = document.querySelector('.dockable-window');
    header = frame.querySelector('.dockable-window-header');
    assert.equal(frame.style.cssText, savedPlacement, 'Closing and reopening restores geometry');
    await press(header, 'pointerdown');
    assert.ok(document.querySelector('.window-drag-cover'));
  } finally {
    await act(async () => root.unmount());
    assert.equal(document.querySelector('.window-drag-cover') === null, true);
    assert.equal(document.body.style.cursor, '');
    if (storageDescriptor) {
      Object.defineProperty(global, 'localStorage', storageDescriptor);
    } else {
      delete global.localStorage;
    }
    dom.window.close();
  }
});
