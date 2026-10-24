// Goal: preview frames retain their lifecycle and render the paths users interact with.
// Methodology: mount the real preview, deliver iframe messages, and answer only
// requested measurements so a missing hover subscription cannot pass unnoticed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/preview-lifecycle');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      'export { default as PreviewPane, deviceForWidth }',
      "  from './src/features/preview/PreviewPane.tsx';",
      "export { hasCanvas, queryCanvas } from './src/editor/canvasQuery.ts';",
      "export { useCanvasMessages } from './src/app/state/appNodeEdits.ts';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'preview.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('starting and failed previews never show an iframe with a stale URL', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  let retries = 0;
  const props = {
    ...hoverPreviewProps(),
    onRestart: () => {
      retries += 1;
    },
  };
  try {
    for (const device of ['desktop', 'canvas']) {
      await React.act(async () => {
        root.render(React.createElement(PreviewPane, { ...props, device, devStatus: 'starting' }));
      });
      assert.equal(document.querySelector('iframe') === null, true);
      assert.match(document.body.textContent, /Starting Astro/);
      await React.act(async () => {
        root.render(React.createElement(PreviewPane, { ...props, device, devStatus: 'off' }));
      });
      assert.equal(document.querySelector('iframe') === null, true);
      assert.match(document.body.textContent, /Preview is offline/);
      const retry = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Start dev server',
      );
      assert.ok(retry);
      await React.act(async () => retry.click());
    }
    assert.equal(retries, 2);
    await React.act(async () => root.render(React.createElement(PreviewPane, props)));
    assert.ok(document.querySelector('iframe'));
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});

test('iframe load requests the verified render again after listeners mount', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => {
      root.render(React.createElement(PreviewPane, hoverPreviewProps()));
      await settle();
    });
    const iframe = document.querySelector('iframe');
    assert.ok(iframe);
    const sent = [];
    iframe.contentWindow.postMessage = (message) => sent.push(message);
    await React.act(async () => {
      iframe.dispatchEvent(new dom.window.Event('load'));
      await settle();
    });
    assert.ok(sent.some((message) => message.type === 'avb:request-render'));
    assert.ok(sent.some((message) => message.type === 'avb:track'));
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});

test('canvas hover measures and outlines the active copy, then clears on leave', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  const props = hoverPreviewProps();
  const act = (action) =>
    React.act(async () => {
      await action();
      await settle();
    });
  const render = () => act(() => root.render(React.createElement(PreviewPane, props)));
  try {
    await render();
    const frame = document.querySelector('iframe').contentWindow;
    const tracked = [];
    frame.postMessage = (message) => {
      if (message.type === 'avb:track') {
        tracked.push(message.paths);
      }
    };
    const send = (data, source = frame) =>
      act(() => window.dispatchEvent(new window.MessageEvent('message', { source, data })));
    const boxes = [
      { x: 10, y: 30, w: 80, h: 40 },
      { x: 10, y: 90, w: 80, h: 40 },
    ];
    const measure = () =>
      send({
        type: 'avb:rects',
        classes: {},
        spacing: {},
        rects: Object.fromEntries(tracked.at(-1).map((nodePath) => [nodePath, boxes])),
      });
    // The frame announces its rendering first (step 7): hover from any other
    // rendering is not drawn.
    const token = 'a'.repeat(64);
    const hovered = () => tracked.some((paths) => paths.includes('1'));
    await send({ type: 'avb:hover-node', path: '1', occurrence: 1, token });
    assert.equal(hovered(), false, 'A hover before the rendering is announced is not drawn');
    await send({ type: 'avb:render', token, stamps: [] });
    await send({ type: 'avb:hover-node', path: '1', occurrence: 1, token: 'b'.repeat(64) });
    assert.equal(hovered(), false, 'A hover from another rendering is not drawn');
    await send({ type: 'avb:hover-node', path: '1', occurrence: 1, token });
    assert.deepEqual(tracked.at(-1), ['0', '1', '2'], 'Hover joins selection and focus tracking');
    await measure();
    assert.equal(document.querySelectorAll('.node-outline.hover').length, 1);
    assert.equal(document.querySelector('.node-outline.hover').style.top, '90px');
    assert.equal(document.querySelectorAll('.node-outline.sel').length, 2);
    const trackCount = tracked.length;
    await send({ type: 'avb:hover-node', path: '1', occurrence: 0, token });
    assert.equal(tracked.length, trackCount, 'Moving between copies reuses their measurements');
    assert.equal(document.querySelector('.node-outline.hover').style.top, '30px');
    props.navHoverPath = '3';
    await render();
    assert.deepEqual(tracked.at(-1), ['0', '3', '2']);
    await measure();
    assert.equal(document.querySelectorAll('.node-outline.hover').length, 1);
    assert.equal(document.querySelector('.node-outline.hover').style.top, '30px');
    props.navHoverPath = undefined;
    await render();
    assert.deepEqual(tracked.at(-1), ['0', '1', '2'], 'Canvas hover resumes after navigator hover');
    await measure();
    await send({ type: 'avb:hover-node', path: undefined, occurrence: 0, token }, window);
    assert.equal(document.querySelectorAll('.node-outline.hover').length, 1);
    await send({ type: 'avb:hover-node', path: undefined, occurrence: 0, token });
    assert.deepEqual(tracked.at(-1), ['0', '2']);
    assert.ok(document.querySelector('.node-outline.hover') === null);
    assert.equal(document.querySelectorAll('.node-outline.sel').length, 2);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

test('navigator selection uses the first loop item; canvas clicks keep their item', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  const props = {
    ...hoverPreviewProps(),
    selPath: '0.1',
    focusPath: undefined,
    navigatorSelectionTick: 0,
    onSelectPath() {},
  };
  const act = (action) =>
    React.act(async () => {
      await action();
      await settle();
    });
  const render = () => act(() => root.render(React.createElement(PreviewPane, props)));
  try {
    await render();
    const frame = document.querySelector('iframe').contentWindow;
    const posted = [];
    frame.postMessage = (message) => posted.push(message);
    const send = (data) =>
      act(() => window.dispatchEvent(new window.MessageEvent('message', { source: frame, data })));
    const token = 'a'.repeat(64);
    await send({ type: 'avb:render', token, stamps: [] });
    await send({
      type: 'avb:rects',
      classes: {},
      spacing: {},
      rects: {
        0.1: [
          { x: 10, y: 30, w: 80, h: 40 },
          { x: 10, y: 90, w: 80, h: 40 },
        ],
        0.2: [
          { x: 20, y: 40, w: 80, h: 40 },
          { x: 20, y: 100, w: 80, h: 40 },
        ],
      },
    });
    await send({ type: 'avb:click-node', path: '0.1', occurrence: 1, outside: false, token });
    assert.equal(document.querySelector('.node-outline.sel').style.top, '90px');
    props.navigatorSelectionTick += 1;
    await render();
    assert.equal(document.querySelectorAll('.node-outline.sel').length, 1);
    assert.equal(document.querySelector('.node-outline.sel').style.top, '30px');
    assert.equal(posted.filter((message) => message.type === 'avb:scroll-to').at(-1)?.occ, 0);
    await send({ type: 'avb:click-node', path: '0.1', occurrence: 1, outside: false, token });
    assert.equal(document.querySelector('.node-outline.sel').style.top, '90px');
    props.selPath = '0.2';
    props.navigatorSelectionTick += 1;
    await render();
    assert.equal(document.querySelector('.node-outline.sel').style.top, '40px');
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

test('a loaded preview frame announces that recovery should be checked', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  let loaded = 0;
  const props = {
    ...hoverPreviewProps(),
    onPreviewLoaded: () => {
      loaded++;
    },
  };
  try {
    await React.act(async () => {
      root.render(React.createElement(PreviewPane, props));
      await settle();
    });
    const designFrame = document.querySelector('iframe');
    await React.act(async () => designFrame.dispatchEvent(new window.Event('load')));
    assert.equal(loaded, 1, 'the design frame starts a recovery check');

    props.device = 'canvas';
    await React.act(async () => {
      root.render(React.createElement(PreviewPane, props));
      await settle();
    });
    const canvasFrame = document.querySelector('iframe');
    await React.act(async () => canvasFrame.dispatchEvent(new window.Event('load')));
    assert.equal(loaded, 2, 'a canvas overview frame starts the same recovery check');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});

test('wide preview keeps outline labels outside the scaled frame', async () => {
  const dom = installHoverDOM();
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: {
      configurable: true,
      get() {
        return this.classList.contains('preview-frame-wrap') ? 400 : 0;
      },
    },
    clientHeight: {
      configurable: true,
      get() {
        return this.classList.contains('preview-frame-wrap') ? 600 : 0;
      },
    },
  });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  const props = { ...hoverPreviewProps(), device: 'tablet', focusPath: undefined };
  const act = (action) =>
    React.act(async () => {
      await action();
      await settle();
    });
  try {
    await act(() => root.render(React.createElement(PreviewPane, props)));
    const iframe = document.querySelector('iframe');
    const frame = document.querySelector('.frame-sized');
    const layer = document.querySelector('.preview-overlay-layer');
    assert.equal(frame.parentElement, layer.parentElement);
    assert.match(frame.style.transform, /scale\(0\.48958/);
    assert.equal(layer.style.width, '376px');
    const send = (data) =>
      act(() =>
        window.dispatchEvent(
          new window.MessageEvent('message', { source: iframe.contentWindow, data }),
        ),
      );
    await send({ type: 'avb:render', token: 'a'.repeat(64), stamps: [] });
    await send({
      type: 'avb:rects',
      classes: {},
      spacing: {},
      rects: { 0: [{ x: 100, y: 40, w: 300, h: 80 }] },
    });
    const outline = layer.querySelector('.node-outline.sel');
    assert.ok(outline);
    assert.ok(Math.abs(Number.parseFloat(outline.style.left) - 48.958) < 0.01);
    assert.ok(Math.abs(Number.parseFloat(outline.style.top) - 19.583) < 0.01);
    assert.ok(Math.abs(Number.parseFloat(outline.style.width) - 146.875) < 0.01);
    assert.ok(layer.contains(outline.querySelector('.node-outline-tag')));
    assert.equal(frame.contains(outline), false);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

test('hovering or selecting a map outlines its parent box', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  const props = {
    ...hoverPreviewProps(),
    selPath: '0.1',
    navHoverPath: undefined,
    focusPath: undefined,
    overlayInfo: (nodePath) => ({
      label: nodePath,
      kind: 'map',
      tag: undefined,
      nodeKind: 'map',
      astroAsset: false,
      dynamicTag: false,
      isLayout: false,
      bound: false,
    }),
  };
  const act = (action) =>
    React.act(async () => {
      await action();
      await settle();
    });
  try {
    await act(() => root.render(React.createElement(PreviewPane, props)));
    const frame = document.querySelector('iframe').contentWindow;
    const tracked = [];
    frame.postMessage = (message) => {
      if (message.type === 'avb:track') {
        tracked.push(message.paths);
      }
    };
    props.navHoverPath = '0.2';
    await act(() => root.render(React.createElement(PreviewPane, props)));
    assert.deepEqual(tracked.at(-1), ['0.1', '0.2', '0']);
    const send = (data) =>
      act(() => window.dispatchEvent(new window.MessageEvent('message', { source: frame, data })));
    await send({ type: 'avb:render', token: 'a'.repeat(64), stamps: [] });
    await send({
      type: 'avb:rects',
      classes: {},
      spacing: {},
      rects: {
        0: [{ x: 10, y: 20, w: 400, h: 300 }],
        0.1: [{ x: 40, y: 50, w: 80, h: 60 }],
        0.2: [{ x: 200, y: 150, w: 80, h: 60 }],
      },
    });
    for (const kind of ['sel', 'hover']) {
      const outline = document.querySelector(`.node-outline.${kind}`);
      assert.ok(outline);
      assert.deepEqual(
        [outline.style.left, outline.style.top, outline.style.width, outline.style.height],
        ['10px', '20px', '400px', '300px'],
      );
    }
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

function installHoverDOM() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.KeyboardEvent = dom.window.KeyboardEvent;
  global.CustomEvent = dom.window.CustomEvent;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  global.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

function hoverPreviewProps() {
  return {
    devUrl: 'http://localhost:4321',
    route: '/',
    devStatus: 'on',
    device: 'desktop',
    selPath: '0',
    navHoverPath: undefined,
    focusPath: '2',
    crumbs: [],
    onDevice() {},
    judgeEvent: async () => ({ tag: 'current' }),
    onStaleEvent() {},
    overlayInfo: () => ({
      label: 'Card',
      kind: 'element',
      tag: 'div',
      nodeKind: 'element',
      astroAsset: false,
      dynamicTag: false,
      isLayout: false,
      bound: false,
    }),
  };
}

test('preview owns only mounted frames and cleans canceled/unmounted drags', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'CustomEvent',
  ]) {
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
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { PreviewPane, deviceForWidth, hasCanvas, queryCanvas } = require(
    path.join(directory, 'preview.js'),
  );
  const root = createRoot(document.getElementById('root'));
  let selected = [];
  const props = {
    devUrl: 'http://localhost:4321',
    route: '/',
    devStatus: 'on',
    device: 'desktop',
    onDevice: (key) => selected.push(key),
    crumbs: [],
    selPath: '0',
    pathScope: '',
    focusPath: undefined,
  };
  const render = async (patch = {}) => {
    Object.assign(props, patch);
    await act(async () => {
      root.render(React.createElement(PreviewPane, props));
      await settle();
    });
  };
  const send = async (source, data) =>
    act(async () => {
      window.dispatchEvent(new window.MessageEvent('message', { source, data }));
      await settle();
    });
  const pointer = (target, type, extra = {}) =>
    target.dispatchEvent(
      new window.MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
        ...extra,
      }),
    );
  await render();
  assert.equal(hasCanvas(), true);
  const oldFrame = document.querySelector('iframe').contentWindow;
  const navigationMessages = [];
  oldFrame.postMessage = (message) => navigationMessages.push(message);
  const scrolls = () => navigationMessages.filter((message) => message.type === 'avb:scroll-to');
  await render({ selPath: '0.1', pathScope: '', focusPath: undefined });
  assert.equal(
    scrolls().at(-1)?.path,
    '0.1',
    'ordinary selections still reveal the selected element',
  );
  navigationMessages.length = 0;
  await render({
    selPath: 'src/components/Card.astro|0',
    pathScope: 'src/components/Card.astro|',
    focusPath: '0.1',
  });
  assert.equal(scrolls().length, 0, 'entering a component retains the canvas scroll position');
  await render({
    selPath: 'src/components/Button.astro|0',
    pathScope: 'src/components/Button.astro|',
    focusPath: '0.1',
  });
  assert.equal(
    scrolls().length,
    0,
    'entering a nested component retains scroll even when the outer focus is unchanged',
  );
  await render({
    selPath: 'src/components/Card.astro|0',
    pathScope: 'src/components/Card.astro|',
    focusPath: '0.1',
  });
  assert.equal(scrolls().length, 0, 'closing a nested component retains scroll');
  await render({ selPath: 'src/components/Card.astro|0.1' });
  assert.equal(
    scrolls().at(-1)?.path,
    'src/components/Card.astro|0.1',
    'selections within the open component still reveal elements',
  );
  navigationMessages.length = 0;
  await render({ selPath: '0', pathScope: '', focusPath: undefined });
  assert.equal(scrolls().length, 0, 'closing the component retains scroll');
  assert.equal(
    document.querySelector('iframe').contentWindow,
    oldFrame,
    'component navigation retains the same loaded frame',
  );
  const pendingQuery = queryCanvas('0');
  await render({ device: 'canvas' });
  assert.equal(hasCanvas(), false);
  assert.equal(await pendingQuery, undefined);
  assert.equal(document.querySelectorAll('iframe').length, 3);
  const canvasFrame = document.querySelector('iframe').contentWindow;
  const viewportMessages = [];
  canvasFrame.postMessage = (message) => viewportMessages.push(message);
  for (const type of ['studio:preview-ready', 'avb:canvas-ready']) {
    await send(canvasFrame, { type });
    assert.deepEqual(viewportMessages.at(-1), { type: 'avb:set-vh', px: 900 });
  }
  window.dispatchEvent(new window.CustomEvent('studio:source-updated', { detail: 'structure' }));
  assert.deepEqual(viewportMessages.at(-1), { type: 'avb:patch-now', immediate: true });
  await send(canvasFrame, { type: 'avb:page-height', height: NaN });
  assert.equal(document.querySelector('.canvas-frame').style.height, '900px');
  await send(canvasFrame, { type: 'avb:page-height', height: Infinity });
  assert.equal(document.querySelector('.canvas-frame').style.height, '900px');
  await send(canvasFrame, { type: 'avb:page-height', height: 4200 });
  assert.equal(document.querySelector('.canvas-frame').style.height, '4200px');
  await send(canvasFrame, { type: 'avb:page-height', height: 80000 });
  assert.equal(document.querySelector('.canvas-frame').style.height, '30000px');
  await send(oldFrame, { type: 'avb:page-height', height: 1000 });
  assert.equal(document.querySelector('.canvas-frame').style.height, '30000px');
  await send(canvasFrame, { type: 'avb:page-height', height: 600 });
  assert.equal(document.querySelector('.canvas-frame').style.height, '600px');
  const phoneFrame = document.querySelectorAll('iframe')[2].contentWindow;
  await send(phoneFrame, { type: 'avb:page-height', height: 80000 });
  assert.equal(document.querySelectorAll('.canvas-frame')[2].style.height, '30000px');
  await render({ refreshKey: 1 });
  assert.equal(document.querySelector('.canvas-frame').style.height, '900px');
  await act(async () => {
    pointer(document.querySelector('.canvas-view'), 'pointerdown');
    await settle();
  });
  assert.ok(document.querySelector('.canvas-view').classList.contains('panning'));
  await act(async () => {
    pointer(window, 'pointercancel');
    await settle();
  });
  assert.equal(document.querySelector('.canvas-view').classList.contains('panning'), false);
  await render({ device: 'tablet' });
  assert.equal(hasCanvas(), true);
  const replacementCalls = [];
  await render({ onDevice: (key) => replacementCalls.push(key) });
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '3' }));
    await settle();
  });
  assert.deepEqual(replacementCalls, ['phone']);
  assert.deepEqual(selected, []);
  document.body.style.cursor = 'crosshair';
  await act(async () => {
    pointer(document.querySelector('.rz-e'), 'pointerdown');
    await settle();
  });
  assert.equal(document.body.style.cursor, 'col-resize');
  await act(async () => {
    window.dispatchEvent(new window.Event('blur'));
    await settle();
  });
  assert.equal(document.body.style.cursor, 'crosshair');
  await act(async () => {
    pointer(document.querySelector('.rz-s'), 'pointerdown');
    await settle();
  });
  assert.equal(document.body.style.cursor, 'row-resize');
  await act(async () => root.unmount());
  assert.equal(document.body.style.cursor, 'crosshair');
  assert.equal(hasCanvas(), false);
  assert.deepEqual([767, 768, 1023, 1024, NaN, 0].map(deviceForWidth), [
    'phone',
    'tablet',
    'tablet',
    'desktop',
    undefined,
    undefined,
  ]);
  dom.window.close();
});

test(
  'custom widths preserve layout size, scale ' + 'to fit, and reset with device controls',
  async () => {
    const dom = installHoverDOM();
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { Simulate } = require('react-dom/test-utils');
    const { PreviewPane } = require(path.join(directory, 'preview.js'));
    const observers = [];
    let containerWidth = 1_024;
    global.ResizeObserver = class {
      constructor(callback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    };
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => containerWidth },
      clientHeight: { configurable: true, get: () => 700 },
    });
    const root = createRoot(document.getElementById('root'));
    const act = (action) =>
      React.act(async () => {
        await action();
        await settle();
      });
    function Preview() {
      const [device, onDevice] = React.useState('desktop');
      return React.createElement(PreviewPane, { ...hoverPreviewProps(), device, onDevice });
    }
    const widthInput = () => document.querySelector('[aria-label="Canvas width"]');
    const setWidth = async (value) => {
      await act(() => {
        widthInput().value = value;
        Simulate.change(widthInput());
      });
      await act(() => Simulate.blur(widthInput()));
    };
    try {
      await act(() => root.render(React.createElement(Preview)));
      const frame = document.querySelector('iframe');
      await setWidth('2000');
      const sized = document.querySelector('.frame-sized');
      assert.equal(sized.style.width, '2000px');
      assert.equal(sized.style.height, '1336px');
      assert.match(sized.style.transform, /scale\(0\.5\)/);
      assert.equal(document.querySelector('[aria-label="Canvas scale"]').textContent, '50%');
      assert.equal(
        document.querySelector('.device-btns button[aria-pressed="true"]').title,
        'Desktop — 1',
      );
      assert.equal(
        document.querySelector('iframe'),
        frame,
        'Changing width retains the loaded page',
      );
      containerWidth = 824;
      await act(() => observers.forEach((callback) => callback()));
      assert.equal(sized.style.width, '2000px', 'Panel resize preserves the requested viewport');
      assert.match(sized.style.transform, /scale\(0\.4\)/);
      for (const invalid of ['', '279', '7681', 'NaN', 'Infinity', '-100', '2e3', '400.5']) {
        await setWidth(invalid);
        assert.equal(sized.style.width, '2000px');
        assert.equal(widthInput().value, '2000');
      }
      Object.defineProperties(sized, {
        offsetWidth: { get: () => Number.parseFloat(sized.style.width) },
        offsetHeight: { get: () => Number.parseFloat(sized.style.height) },
      });
      await act(() =>
        document
          .querySelector('.rz-e')
          .dispatchEvent(
            new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 800 }),
          ),
      );
      await act(() =>
        window.dispatchEvent(
          new window.MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 880 }),
        ),
      );
      assert.equal(
        sized.style.width,
        '2400px',
        'Dragging accounts for scale without capping at the panel',
      );
      await act(() => document.querySelector('[title="Phone (375px) — 3"]').click());
      assert.equal(sized.style.width, '375px');
      assert.match(sized.style.transform, /scale\(1\)/);
      await setWidth('7680');
      assert.equal(sized.style.width, '7680px');
      await act(() => document.querySelector('[title="Reset canvas to available width"]').click());
      assert.equal(sized.style.width, '824px');
      assert.equal(sized.style.height, '700px');
      assert.equal(document.querySelector('iframe'), frame);
    } finally {
      await act(() => root.unmount());
      dom.window.close();
    }
  },
);

test('context events use the gate and translate zoomed frame coordinates', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  const verdicts = [];
  const token = 'a'.repeat(64);
  const props = {
    ...hoverPreviewProps(),
    selPath: '0.1',
    focusPath: undefined,
    judgeEvent: async (value, render, request) => {
      calls.push(['gate', request]);
      return value === render?.token
        ? { tag: 'current' }
        : { tag: 'stale', reason: 'no-render', file: undefined };
    },
    onContextPath: (path, point) => calls.push(['context', path, point]),
    onStaleEvent: (verdict) => verdicts.push(verdict),
  };
  const act = (action) =>
    React.act(async () => {
      await action();
      await settle();
    });
  try {
    await act(() => root.render(React.createElement(PreviewPane, props)));
    const frame = document.querySelector('iframe');
    Object.defineProperty(frame, 'offsetWidth', { value: 1000 });
    frame.getBoundingClientRect = () => ({ left: 200, top: 100, width: 500, height: 400 });
    const send = (data, source = frame.contentWindow) =>
      act(() => {
        window.dispatchEvent(new window.MessageEvent('message', { source, data }));
      });
    const event = {
      type: 'avb:context-node',
      path: '0.1',
      occurrence: 1,
      outside: false,
      left: 80,
      top: 120,
      token,
    };
    await send({ type: 'avb:render', token, stamps: [] });
    await send(event, window);
    assert.equal(calls.length, 0, 'another window cannot open the menu');
    await send({ ...event, token: 'b'.repeat(64) });
    assert.equal(verdicts.length, 1, 'a stale right-click is reported');
    assert.equal(calls.filter(([kind]) => kind === 'context').length, 0);
    await send(event);
    assert.deepEqual(calls.at(-2), ['gate', { kind: 'open' }]);
    assert.deepEqual(calls.at(-1), [
      'context',
      '0.1',
      {
        left: 240,
        top: 160,
        occurrence: 1,
        outside: false,
      },
    ]);
    await send({
      type: 'avb:rects',
      classes: {},
      spacing: {},
      rects: {
        0.1: [
          { x: 10, y: 20, w: 30, h: 40 },
          { x: 10, y: 90, w: 30, h: 40 },
        ],
      },
    });
    assert.equal(document.querySelectorAll('.node-outline.sel').length, 1);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

test('navigation keeps a loaded page visible while isolating its replacement', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane, queryCanvas } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  const props = hoverPreviewProps();
  const act = (action) =>
    React.act(async () => {
      action();
      await settle();
    });
  const render = (patch) =>
    act(() => {
      Object.assign(props, patch);
      root.render(React.createElement(PreviewPane, props));
    });
  const load = (frame) => act(() => frame.dispatchEvent(new window.Event('load')));
  const current = () => document.querySelector('iframe[title="Site preview"]');
  try {
    await render({});
    const first = current();
    await load(first);
    assert.ok(document.querySelector('[role="status"]') === null);
    const pending = queryCanvas('0');
    await render({ route: '/about' });
    const next = current();
    assert.notEqual(next, first);
    assert.equal(await pending, undefined, 'Navigation cancels old-page queries immediately');
    assert.equal(first.isConnected, true, 'The last loaded document remains on screen');
    assert.equal(first.style.visibility, 'visible');
    assert.equal(first.style.pointerEvents, 'none', 'The retained page cannot receive edits');
    assert.equal(first.tabIndex, -1);
    assert.equal(next.style.visibility, 'hidden', 'An unfinished document cannot flash white');
    assert.equal(document.querySelector('[role="status"]').textContent, 'Loading page…');
    const sent = [];
    next.contentWindow.postMessage = (message) => sent.push(message);
    const query = queryCanvas('0');
    assert.ok(sent.some((message) => message.type === 'avb:query'));
    await act(() =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source: first.contentWindow,
          data: {
            type: 'avb:rects',
            classes: {},
            spacing: {},
            rects: { 0: [{ x: 10, y: 10, w: 80, h: 40 }] },
          },
        }),
      ),
    );
    assert.equal(document.querySelectorAll('.node-outline.sel').length, 0);
    await render({ route: '/contact' });
    assert.equal(await query, undefined);
    assert.equal(next.isConnected, false, 'Abandoned loads are removed');
    assert.equal(document.querySelectorAll('iframe').length, 2, 'Retention is bounded');
    await load(next);
    assert.equal(current().style.visibility, 'hidden', 'An abandoned load cannot reveal a page');
    await load(current());
    assert.equal(first.isConnected, false);
    assert.equal(document.querySelectorAll('iframe').length, 1);
    assert.equal(current().style.visibility, 'visible');
    assert.ok(document.querySelector('[role="status"]') === null);
    const loaded = current();
    await render({ refreshKey: 1 });
    assert.notEqual(current(), loaded, 'Explicit refresh still creates a new document');
    assert.equal(loaded.isConnected, true);
    await load(current());
    assert.equal(loaded.isConnected, false);
    const defaultsFrame = current();
    const messages = [];
    defaultsFrame.contentWindow.postMessage = (message) => messages.push(message);
    const defaultsRoute = '/__avb/preview?defaults=11111111-1111-1111-1111-111111111111';
    await render({ route: defaultsRoute });
    assert.equal(current(), defaultsFrame, 'Defaults continue to morph the existing document');
    assert.ok(messages.some((message) => message.type === 'avb:preview-route'));
    await render({ route: '/contact' });
    assert.equal(current(), defaultsFrame, 'Leaving defaults retains the same document');
    assert.ok(document.querySelector('[role="status"]') === null);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

test('canvas retains one loaded page per breakpoint until replacements load', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  const props = { ...hoverPreviewProps(), device: 'canvas' };
  const act = (action) =>
    React.act(async () => {
      action();
      await settle();
    });
  const render = () => act(() => root.render(React.createElement(PreviewPane, props)));
  const load = (frame) => act(() => frame.dispatchEvent(new window.Event('load')));
  try {
    await render();
    const previous = [...document.querySelectorAll('iframe')];
    assert.equal(previous.length, 3);
    for (const frame of previous) {
      await load(frame);
    }
    props.route = '/about';
    await render();
    assert.equal(document.querySelectorAll('iframe').length, 6);
    assert.ok(previous.every((frame) => frame.isConnected));
    const replacements = [...document.querySelectorAll('iframe[aria-hidden="false"]')];
    assert.ok(replacements.every((frame) => frame.style.visibility === 'hidden'));
    for (const frame of replacements) {
      await load(frame);
    }
    assert.equal(document.querySelectorAll('iframe').length, 3);
    assert.ok(previous.every((frame) => !frame.isConnected));
    assert.ok(document.querySelector('[role="status"]') === null);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

test('retained preview pages cannot replay queued editing shortcuts', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { useCanvasMessages } = require(path.join(directory, 'preview.js'));
  window.avb = { onMenu: () => () => {} };
  const root = createRoot(document.getElementById('root'));
  const keys = [];
  document.addEventListener('keydown', (event) => keys.push(event.key));
  function Shortcuts() {
    useCanvasMessages(
      {
        inPreviewRef: React.useRef(false),
        pageStateRef: React.useRef({ pageState: { editable: true } }),
      },
      { setInsertOpen() {} },
    );
    return React.createElement(
      React.Fragment,
      undefined,
      React.createElement('iframe', { title: 'Retained', 'aria-hidden': 'true' }),
      React.createElement('iframe', { title: 'Current', 'aria-hidden': 'false' }),
    );
  }
  try {
    await React.act(async () => root.render(React.createElement(Shortcuts)));
    const send = (title) =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source: document.querySelector(`iframe[title="${title}"]`).contentWindow,
          data: { type: 'avb:shortcut', name: 'key', key: 'Delete', meta: false },
        }),
      );
    send('Retained');
    assert.deepEqual(keys, [], 'An old document cannot delete the new selection');
    send('Current');
    assert.deepEqual(keys, ['Delete'], 'Current canvas shortcuts still work');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});

test('parsed pages become visible before slow resources finish loading', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  let loads = 0;
  const props = {
    ...hoverPreviewProps(),
    onPreviewLoaded: () => {
      loads++;
    },
  };
  const act = (action) =>
    React.act(async () => {
      action();
      await settle();
    });
  const render = () => act(() => root.render(React.createElement(PreviewPane, props)));
  const current = () => document.querySelector('iframe[title="Site preview"]');
  const ready = (source) =>
    act(() =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source,
          data: { type: 'avb:canvas-ready' },
        }),
      ),
    );
  try {
    await render();
    const first = current();
    await ready(first.contentWindow);
    assert.ok(document.querySelector('[role="status"]') === null);
    props.route = '/about';
    await render();
    const next = current();
    assert.equal(next.style.visibility, 'hidden');
    await ready(first.contentWindow);
    await ready(window);
    assert.equal(next.style.visibility, 'hidden', 'Only the destination can announce readiness');
    // Withhold load, as happens while an image, video, or embed is still downloading.
    await ready(next.contentWindow);
    assert.equal(loads, 0, 'The full resource load has not finished');
    assert.equal(next.style.visibility, 'visible', 'Parsed content appears without that wait');
    assert.equal(first.isConnected, false);
    assert.ok(document.querySelector('[role="status"]') === null);
    await act(() => next.dispatchEvent(new window.Event('load')));
    assert.equal(loads, 1, 'The later load still performs the recovery handshake');
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});

test('clicks follow handles and cancel when the frame changes during checking', async () => {
  const dom = installHoverDOM();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { PreviewPane } = require(path.join(directory, 'preview.js'));
  const root = createRoot(document.getElementById('root'));
  const selected = [];
  const token = 'a'.repeat(64);
  let answer;
  const act = (action) =>
    React.act(async () => {
      await action();
      await settle();
    });
  try {
    await act(() =>
      root.render(
        React.createElement(PreviewPane, {
          ...hoverPreviewProps(),
          onSelectPath: (path) => selected.push(path),
          judgeEvent: () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        }),
      ),
    );
    const frame = document.querySelector('iframe');
    const send = (data) =>
      act(() =>
        window.dispatchEvent(
          new window.MessageEvent('message', {
            source: frame.contentWindow,
            data,
          }),
        ),
      );
    const click = { type: 'avb:click-node', path: '0.1', outside: false, occurrence: 0, token };
    await send({ type: 'avb:render', token, stamps: [] });
    await send(click);
    await act(() => answer({ tag: 'current', path: '0.2' }));
    assert.deepEqual(selected, ['0.2'], 'the moved node is selected at its new path');
    await send(click);
    await send({ type: 'avb:render', token: 'b'.repeat(64), stamps: [] });
    await act(() => answer({ tag: 'current', path: '0.3' }));
    assert.deepEqual(selected, ['0.2'], 'a verdict for a superseded frame cannot select');
  } finally {
    await act(() => root.unmount());
    dom.window.close();
  }
});
