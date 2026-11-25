// Goal: the canvas's width and height handles are the same element in the design canvas, in
// interact mode and in the preview mode (the play button in the title bar), and a drag in the
// preview mode resizes the page as one on the canvas does: the frame takes the new size, the
// device turns custom, the toolbar's width field shows the new width, and leaving and
// re-entering the preview keeps that size. The side handles of a scaled frame stay the same distance out on screen, so
// they never cover the canvas's scrollbar beside the frame.
// Methodology: mount the real PreviewPane beside the real PreviewModeStage, wired the way
// Desktop's AppShell PreviewModeView wires it (one window state holding the device and the
// custom size, read by both), in jsdom with a fixed layout: every element measures 1600 by
// 900, and a frame's offset size is its inline pixel size, 1600 by 900 when it fills the
// canvas. Drags are pointer events on the handle and the window, as usePointerDrag listens.
// A source check pins that AppShell draws the preview through that stage and that state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/resize-handles-modes');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as PreviewPane } from './src/features/preview/PreviewPane.tsx';",
      "export { PreviewModeStage } from './src/features/preview/SizedFrame.tsx';",
      "export { usePreviewSizing, usePreviewDimensions } from './src/features/preview/usePreviewSizing.ts';",
      "export { useProjectBreakpoints } from './src/ipc/useProjectBreakpoints.ts';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'modes.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const CANVAS_WIDTH_PX = 1600;
const CANVAS_HEIGHT_PX = 900;
const HANDLE_CLASSES = ['rz-handle rz-w', 'rz-handle rz-e', 'rz-handle rz-s'];
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('AppShell draws the preview mode through the shared stage and the window size state', () => {
  const shell = fs.readFileSync(repoPath('src/app/shell/AppShell.tsx'), 'utf8');
  assert.match(shell, /<PreviewModeStage sizing=\{sizing\}>/);
  assert.match(shell, /usePreviewSizing\(app\.device, app\.previewDimensions, breakpoints, \{ deviceShortcuts: false, desktopFramePx \}, app\.setDevice\)/);
  const panes = fs.readFileSync(repoPath('src/app/shell/AppPanes.tsx'), 'utf8');
  assert.match(panes, /dimensions=\{app\.previewDimensions\}/);
});

test('the handles are the same in design, interact and preview modes, and a preview drag resizes like the canvas', async () => {
  const dom = installDOM();
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const modes = require(path.join(directory, 'modes.js'));
  const root = createRoot(document.getElementById('root'));
  const shown = { preview: false };
  const window = dom.window;
  // Desktop's window state (appState.ts useWindowState) and preview mode (AppShell PreviewModeView).
  function PreviewModeView({ device, setDevice, dimensions }) {
    const { resolved } = modes.useProjectBreakpoints(undefined);
    const sizing = modes.usePreviewSizing(device, dimensions, resolved, { deviceShortcuts: false, desktopFramePx: 1440 }, setDevice);
    return React.createElement(modes.PreviewModeStage, { sizing }, React.createElement('iframe', { title: 'Site' }));
  }
  function Window() {
    const [device, setDevice] = React.useState('desktop');
    const dimensions = modes.usePreviewDimensions();
    return React.createElement(
      React.Fragment,
      undefined,
      React.createElement(modes.PreviewPane, { ...paneProps(), device, onDevice: setDevice, dimensions }),
      shown.preview ? React.createElement(PreviewModeView, { device, setDevice, dimensions }) : undefined,
    );
  }
  const render = async () =>
    act(async () => {
      root.render(React.createElement(Window));
      await settle();
    });
  const canvasFrame = () => document.querySelector('.preview-frame-wrap > .frame-sized');
  const stageFrame = () => document.querySelector('.preview-mode-stage > .frame-sized');
  const handleClasses = (frame) => [...frame.children].filter((node) => node.classList.contains('rz-handle')).map((node) => node.className);
  const widthField = () => document.querySelector('.preview-width-field input');
  const pointer = (target, type, point) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, clientX: point.x, clientY: point.y }));
  try {
    await render();
    // The design canvas.
    assert.deepEqual(handleClasses(canvasFrame()), HANDLE_CLASSES);
    assert.equal(canvasFrame().querySelector('.frame-clip .rz-handle') === null, true, 'The handles sit outside the clipped page');
    // Interact mode keeps the same frame and handles.
    const interact = document.querySelector('button[aria-label="Interact with canvas"]');
    assert.equal(interact === null, false);
    await act(async () => {
      interact.click();
      await settle();
    });
    assert.equal(document.querySelector('.preview-frame-wrap').getAttribute('data-canvas-interactive'), 'true');
    assert.deepEqual(handleClasses(canvasFrame()), HANDLE_CLASSES);
    // The preview mode: the same handles, on a frame of the same shape, over a stage of its own.
    shown.preview = true;
    await render();
    assert.equal(stageFrame() === null, false);
    assert.deepEqual(handleClasses(stageFrame()), HANDLE_CLASSES);
    assert.equal(stageFrame().className, canvasFrame().className, 'The preview frame has the canvas frame classes');
    assert.equal(stageFrame().querySelector('.frame-clip > iframe').title, 'Site');
    assert.equal(stageFrame().querySelector('.frame-clip .rz-handle') === null, true);
    assert.equal(stageFrame().classList.contains('full'), true, 'Fit fills the stage, as the preview always did');
    assert.equal(
      stageFrame().querySelector('.rz-e').getAttribute('style') ?? undefined,
      undefined,
      'a fluid frame keeps its handles inside, by the stylesheet',
    );
    // A right-edge drag widens both sides of the centred frame: 1600 + 2 × 100.
    await act(async () => pointer(stageFrame().querySelector('.rz-e'), 'pointerdown', { x: 1000, y: 400 }));
    await act(async () => {
      pointer(window, 'pointermove', { x: 1100, y: 400 });
      await settle();
    });
    assert.equal(stageFrame().classList.contains('resizing'), true);
    assert.match(stageFrame().querySelector('.rz-readout').textContent, /^1800 × \d+$/);
    await act(async () => {
      pointer(window, 'pointerup', { x: 1100, y: 400 });
      await settle();
    });
    assert.equal(stageFrame().querySelector('.rz-readout') === null, true, 'The readout leaves with the drag');
    assert.equal(stageFrame().style.width, '1800px');
    assert.equal(stageFrame().classList.contains('full'), false);
    assert.equal(canvasFrame().style.width, '1800px', 'The canvas below takes the same width');
    assert.equal(widthField().value, '1800', 'The toolbar width field follows the preview drag');
    // A bottom-edge drag upward shortens the page, in page pixels at the frame's scale.
    const heightBefore = Number.parseFloat(stageFrame().style.height);
    const scale = (CANVAS_WIDTH_PX - 24) / 1800;
    await act(async () => pointer(stageFrame().querySelector('.rz-s'), 'pointerdown', { x: 800, y: 700 }));
    await act(async () => {
      pointer(window, 'pointerup', { x: 800, y: 600 });
      await settle();
    });
    const heightAfter = Number.parseFloat(stageFrame().style.height);
    assert.equal(heightAfter, Math.round(heightBefore - 100 / scale));
    assert.equal(Number.parseFloat(canvasFrame().style.height), heightAfter, 'The canvas below takes the same height');
    // The 1800px frame is scaled to fit: its side handles stay 12 screen pixels out (12 / scale frame pixels), past the
    // canvas's scrollbar, which sits 2 to 7 screen pixels out (CanvasScrollbar.tsx). Fill mode keeps them inside the page.
    assert.equal(Number.parseFloat(stageFrame().querySelector('.rz-e').style.right), -12 / scale);
    assert.equal(Number.parseFloat(stageFrame().querySelector('.rz-w').style.left), -12 / scale);
    assert.ok(-12 / scale < -12, 'further out in frame pixels than at scale 1, so the same on screen');
    assert.equal(stageFrame().querySelector('.rz-s').getAttribute('style') ?? undefined, undefined, 'the bottom handle is nowhere near the bar');
    // Leaving the preview keeps the size on the canvas, and coming back opens on it.
    shown.preview = false;
    await render();
    assert.equal(stageFrame() === null, true);
    assert.equal(canvasFrame().style.width, '1800px');
    assert.equal(widthField().value, '1800');
    shown.preview = true;
    await render();
    assert.equal(stageFrame().style.width, '1800px');
    assert.equal(Number.parseFloat(stageFrame().style.height), heightAfter);
    // A width typed in the toolbar reaches the preview the same way.
    await act(async () => {
      const field = widthField();
      setInputValue(window, field, '768');
      field.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
      await settle();
    });
    assert.equal(stageFrame().style.width, '768px');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test('a press that is not the main button does not start a resize in the preview mode', async () => {
  const dom = installDOM();
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const modes = require(path.join(directory, 'modes.js'));
  const root = createRoot(document.getElementById('root'));
  function Stage() {
    const [device, setDevice] = React.useState('desktop');
    const dimensions = modes.usePreviewDimensions();
    const { resolved } = modes.useProjectBreakpoints(undefined);
    const sizing = modes.usePreviewSizing(device, dimensions, resolved, { deviceShortcuts: false, desktopFramePx: 1440 }, setDevice);
    return React.createElement(modes.PreviewModeStage, { sizing }, React.createElement('iframe', { title: 'Site' }));
  }
  try {
    await act(async () => {
      root.render(React.createElement(Stage));
      await settle();
    });
    const frame = document.querySelector('.preview-mode-stage > .frame-sized');
    await act(async () =>
      frame.querySelector('.rz-e').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 2, clientX: 10, clientY: 10 })),
    );
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 400, clientY: 10 }));
      await settle();
    });
    assert.equal(frame.classList.contains('resizing'), false);
    assert.equal(frame.classList.contains('full'), true, 'The frame keeps filling the stage');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

// React tracks an input's value through its own setter, so a test sets it through the prototype's.
function setInputValue(window, input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function installDOM() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'KeyboardEvent']) {
    global[key] = key === 'window' ? window : window[key];
  }
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const prototype = window.HTMLElement.prototype;
  Object.defineProperty(prototype, 'clientWidth', { configurable: true, get: () => CANVAS_WIDTH_PX });
  Object.defineProperty(prototype, 'clientHeight', { configurable: true, get: () => CANVAS_HEIGHT_PX });
  Object.defineProperty(prototype, 'offsetWidth', { configurable: true, get: inlinePixels('width', CANVAS_WIDTH_PX) });
  Object.defineProperty(prototype, 'offsetHeight', { configurable: true, get: inlinePixels('height', CANVAS_HEIGHT_PX) });
  return dom;
}

// An element's inline pixel size, or the canvas size when it has none (a frame filling the canvas).
function inlinePixels(property, fallback) {
  return function measure() {
    const value = this.style[property];
    if (typeof value === 'string' && value.endsWith('px')) {
      return Math.round(Number.parseFloat(value));
    }
    return fallback;
  };
}

function paneProps() {
  return {
    devUrl: 'http://localhost:4321',
    route: '/',
    devStatus: 'on',
    crumbs: [],
    selPath: undefined,
    pathScope: '',
    focusPath: undefined,
    onEditRoute() {},
    judgeEvent: async () => ({ tag: 'current' }),
    onCanvasNotice() {},
  };
}
