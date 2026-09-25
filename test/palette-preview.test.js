// Goal: palette hover previews identify the exact component file and cancel
// obsolete hover requests. Methodology: mount the real palette, dispatch pointer
// entry/exit events, inspect iframe identity, and apply validated ready/empty statuses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const HOVER_WAIT_MS = 490;
const COMPONENTS = [
  {
    name: 'AccordionItem', folder: 'Interactive',
    path: '/project/src/components/Interactive/AccordionItem.astro',
  },
  {
    name: 'AccordionItem', folder: 'Marketing',
    path: '/project/src/components/Marketing/AccordionItem.astro',
  },
  {
    name: 'Base', folder: 'layouts', isLayout: true,
    path: '/project/src/layouts/Base.astro',
  },
];

test('hover preview targets exact files and cancels obsolete delayed opens', async () => {
  const bundle = await buildPalette();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  global.window = dom.window;
  for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[name] = dom.window[name];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const Palette = require(bundle).default;
  const root = createRoot(document.getElementById('root'));
  const inserted = [];
  const context = { dom, act: React.act, hoveredItem: undefined };
  try {
    await React.act(async () => root.render(React.createElement(Palette, {
      components: COMPONENTS,
      devUrl: 'http://localhost:4321',
      trailingSlash: 'always',
      onInsert: (name) => inserted.push(name),
      onCreateComponent() {},
      createFrom: { kind: 'unavailable', reason: 'Select an element.' },
    })));
    await checkCancelledHover(context);
    const interactiveFrame = await checkPreviewTarget(
      context,
      'Interactive',
      'src/components/Interactive/AccordionItem.astro',
    );
    await sendPreviewStatus(context, interactiveFrame, 'empty');
    assert.equal(
      document.querySelector('.comp-preview').style.visibility,
      'hidden',
      'An empty component has no preview box',
    );
    await checkPreviewTarget(context, 'Marketing', 'src/components/Marketing/AccordionItem.astro');
    await checkPreviewTarget(context, 'layouts', 'src/layouts/Base.astro');
    await React.act(async () => {
      itemInFolder('layouts').dispatchEvent(
        new dom.window.MouseEvent('dblclick', { bubbles: true }),
      );
    });
    assert.deepEqual(inserted, ['Base'], 'Preview identity does not change insertion names');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});

async function checkCancelledHover(context) {
  await pointerEvent(context, itemInFolder('Interactive'), 'mouseover');
  assert.equal(document.querySelector('.comp-preview'), null, 'Hover waits before opening');
  await pointerEvent(context, itemInFolder('Interactive'), 'mouseout');
  await context.act(() => new Promise((resolve) => setTimeout(resolve, HOVER_WAIT_MS)));
  assert.equal(document.querySelector('.comp-preview'), null, 'Leaving cancels the delayed open');
}

async function checkPreviewTarget(context, folder, componentPath) {
  if (context.hoveredItem) {
    await pointerEvent(context, context.hoveredItem, 'mouseout');
    assert.equal(document.querySelector('.comp-preview'), null, 'The previous target closes');
  }
  context.hoveredItem = itemInFolder(folder);
  await pointerEvent(context, context.hoveredItem, 'mouseover');
  await context.act(() => new Promise((resolve) => setTimeout(resolve, HOVER_WAIT_MS)));
  const iframe = document.querySelector('.comp-preview iframe');
  assert.ok(iframe, `${folder} hover opens a real preview frame`);
  const url = new URL(iframe.src);
  const name = path.basename(componentPath, '.astro');
  assert.equal(url.origin, 'http://localhost:4321');
  assert.equal(url.pathname, '/__avb/preview/');
  assert.equal(url.searchParams.get('c'), name);
  assert.equal(
    url.searchParams.get('p'),
    componentPath,
    'Duplicate basenames retain file identity',
  );
  assert.equal(iframe.title, `${name} preview`);
  const preview = document.querySelector('.comp-preview');
  assert.equal(preview.style.visibility, 'hidden', 'The box waits for rendered preview content');
  await context.act(async () => {
    window.dispatchEvent(new context.dom.window.MessageEvent('message', {
      source: iframe.contentWindow,
      data: { type: 'avb:component-preview', status: 'unknown' },
    }));
  });
  assert.equal(preview.style.visibility, 'hidden', 'Malformed preview status is ignored');
  await sendPreviewStatus(context, iframe, 'ready');
  assert.equal(preview.style.visibility, 'visible', 'Rendered content reveals the preview box');
  return iframe;
}

async function sendPreviewStatus(context, iframe, status) {
  await context.act(async () => {
    window.dispatchEvent(new context.dom.window.MessageEvent('message', {
      source: iframe.contentWindow,
      data: { type: 'avb:component-preview', status },
    }));
  });
}

async function pointerEvent({ dom, act }, item, type) {
  await act(async () => {
    item.dispatchEvent(new dom.window.MouseEvent(type, {
      bubbles: true, relatedTarget: document.body,
    }));
  });
}

function itemInFolder(folder) {
  const heading = [...document.querySelectorAll('.palette-folder')].find(
    (element) => element.textContent === folder,
  );
  assert.ok(heading, `Folder ${folder} is listed`);
  const item = heading.nextElementSibling;
  assert.ok(item?.classList.contains('palette-item'), `${folder} has a component`);
  return item;
}

async function buildPalette() {
  const output = path.join(__dirname, '../node_modules/.stacki-test/palette-preview.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/panels/PalettePanel.tsx')],
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  return output;
}
