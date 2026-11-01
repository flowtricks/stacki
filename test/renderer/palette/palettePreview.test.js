// Goal: palette previews open immediately and switch instantly and reuse recently loaded frames.
// Methodology: mount the real palette, move between rows and gaps, retain iframe identity,
// and deliver ready/empty messages including late replies from abandoned requests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const COMPONENTS = [
  { name: 'Input', folder: 'Forms', path: '/project/src/components/Forms/Input.astro' },
  { name: 'Hero', folder: 'Content', path: '/project/src/components/Content/Hero.astro' },
  {
    name: 'AccordionItem',
    folder: 'Interactive',
    path: '/project/src/components/Interactive/AccordionItem.astro',
  },
  {
    name: 'AccordionItem',
    folder: 'Marketing',
    path: '/project/src/components/Marketing/AccordionItem.astro',
  },
  {
    name: 'Base',
    folder: 'layouts',
    isLayout: true,
    path: '/project/src/layouts/Base.astro',
  },
];

test('hover preview opens immediately, targets exact files and closes on exit', async () => {
  const bundle = await buildPalette();
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
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
    await React.act(async () =>
      root.render(
        React.createElement(Palette, {
          components: COMPONENTS,
          devUrl: 'http://localhost:4321',
          trailingSlash: 'always',
          onInsert: (name) => inserted.push(name),
          onCreateComponent() {},
          createFrom: { kind: 'unavailable', reason: 'Select an element.' },
        }),
      ),
    );
    await checkCancelledHover(context);
    const interactiveFrame = await checkPreviewTarget(context, 'Interactive', 'src/components/Interactive/AccordionItem.astro');
    await sendPreviewStatus(context, interactiveFrame, 'empty');
    assert.equal(document.querySelector('.comp-preview').style.visibility, 'hidden', 'An empty active component hides its preview');
    await checkPreviewTarget(context, 'Marketing', 'src/components/Marketing/AccordionItem.astro');
    await checkPreviewTarget(context, 'layouts', 'src/layouts/Base.astro');
    await checkPreviewHandoff(context);
    await checkPreviewCacheBound(context);
    await React.act(async () => {
      itemInFolder('layouts').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
    });
    assert.deepEqual(inserted, ['/project/src/layouts/Base.astro'], 'Insertion retains the exact component path');
    await checkResolvedPreviewHandoff(context, root, React, Palette);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});

async function checkCancelledHover(context) {
  await pointerEvent(context, itemInFolder('Interactive'), 'mouseover');
  assert.ok(document.querySelector('.comp-preview'), 'Hover opens without waiting for a timer');
  await pointerEvent(context, itemInFolder('Interactive'), 'mouseout');
  assert.ok(document.querySelector('.comp-preview') === null, 'Leaving closes the preview');
}

async function checkResolvedPreviewHandoff(context, root, React, Palette) {
  const requests = [];
  await context.act(async () =>
    root.render(
      React.createElement(Palette, {
        components: COMPONENTS,
        devUrl: 'http://localhost:4321',
        trailingSlash: 'always',
        onInsert() {},
        onCreateComponent() {},
        createFrom: { kind: 'unavailable', reason: 'Select an element.' },
        resolvePreviewURL: async (url) => {
          requests.push(url);
          return url;
        },
      }),
    ),
  );
  const shown = await checkPreviewTarget(context, 'Interactive', 'src/components/Interactive/AccordionItem.astro');
  const next = itemInFolder('Marketing');
  await pointerEvent(context, context.hoveredItem, 'mouseout', next);
  assert.equal(requests.length, 2, 'Keeping the visible frame does not resolve its URL again');
  const pending = document.querySelectorAll('.comp-preview iframe')[1];
  assert.equal(shown.style.opacity, '0', 'A new target replaces the old preview immediately');
  assert.equal(document.querySelector('.comp-preview').dataset.loading, 'true');
  await sendPreviewStatus(context, pending, 'ready');
  await pointerEvent(context, next, 'mouseout', itemInFolder('Interactive'));
  assert.equal(requests.length, 2, 'Revisiting a cached frame does not resolve its URL again');
  assert.equal(document.querySelector('.comp-preview iframe'), shown);
  assert.equal(shown.style.opacity, '1');
  assert.equal(document.querySelector('.comp-preview').dataset.loading, 'false');
  await pointerEvent(context, itemInFolder('Interactive'), 'mouseout');
  context.hoveredItem = undefined;
}

async function checkPreviewHandoff(context) {
  const card = document.querySelector('.comp-preview');
  const shown = card.querySelector('iframe');
  const next = itemInFolder('Interactive');
  await pointerEvent(context, context.hoveredItem, 'mouseout', next);
  assert.equal(document.querySelector('.comp-preview'), card, 'Switching rows retains the card');
  assert.equal(shown.style.opacity, '0', 'The previous component disappears immediately');
  assert.equal(card.dataset.loading, 'true', 'A fresh component shows its loading state');
  assert.equal(card.querySelector('.comp-preview-title').textContent, 'Accordion Item');
  const pending = card.querySelectorAll('iframe')[1];
  const latest = itemInFolder('Marketing');
  await pointerEvent(context, next, 'mouseout', latest);
  const active = card.querySelectorAll('iframe')[2];
  await sendPreviewStatus(context, pending, 'ready');
  assert.equal(pending.style.opacity, '0', 'Late replies cannot reveal an inactive component');
  assert.equal(card.dataset.loading, 'true');
  await sendPreviewStatus(context, active, 'ready');
  assert.equal(active.style.opacity, '1');
  await pointerEvent(context, latest, 'mouseout', next);
  assert.equal(card.querySelectorAll('iframe')[1], pending, 'Revisiting retains frame identity');
  assert.equal(pending.style.opacity, '1');
  assert.equal(card.dataset.loading, 'false', 'A cached preview appears without loading');
  assert.equal(card.querySelectorAll('iframe')[0], shown, 'Cache reuse keeps DOM order stable');

  const gap = next.previousElementSibling;
  await pointerEvent(context, next, 'mouseout', gap);
  assert.equal(document.querySelector('.comp-preview'), card, 'Folder gaps do not close the card');
  await pointerEvent(context, gap, 'mouseout');
  assert.ok(document.querySelector('.comp-preview') === null, 'Leaving the panel closes the card');
  context.hoveredItem = undefined;
}

async function checkPreviewCacheBound(context) {
  const folders = ['Interactive', 'Marketing', 'layouts', 'Forms', 'Interactive', 'Content'];
  let previous;
  let first;
  let evicted;
  for (const folder of folders) {
    const next = itemInFolder(folder);
    if (previous) {
      await pointerEvent(context, previous, 'mouseout', next);
    } else {
      await pointerEvent(context, next, 'mouseover');
    }
    const frames = document.querySelectorAll('.comp-preview iframe');
    assert.ok(frames.length <= 4, 'The cache never retains more than four frames');
    first ??= frames[0];
    if (folder === 'Marketing') {
      evicted = frames[1];
    }
    previous = next;
  }
  assert.equal(first.isConnected, true, 'Recently revisited content remains cached');
  assert.equal(evicted.isConnected, false, 'The least recently used frame is released');
  await pointerEvent(context, previous, 'mouseout');
}

async function checkPreviewTarget(context, folder, componentPath) {
  if (context.hoveredItem) {
    await pointerEvent(context, context.hoveredItem, 'mouseout');
    assert.ok(document.querySelector('.comp-preview') === null, 'The previous target closes');
  }
  context.hoveredItem = itemInFolder(folder);
  await pointerEvent(context, context.hoveredItem, 'mouseover');
  const iframe = document.querySelector('.comp-preview iframe');
  assert.ok(iframe, `${folder} hover opens a real preview frame`);
  const url = new URL(iframe.src);
  const name = path.basename(componentPath, '.astro');
  assert.equal(url.origin, 'http://localhost:4321');
  assert.equal(url.pathname, '/__avb/preview/');
  assert.equal(url.searchParams.get('c'), name);
  assert.equal(url.searchParams.get('p'), componentPath, 'Duplicate basenames retain file identity');
  assert.equal(iframe.title, `${name} preview`);
  const preview = document.querySelector('.comp-preview');
  assert.equal(preview.style.visibility, 'visible', 'The box appears immediately while loading');
  assert.equal(preview.dataset.loading, 'true');
  assert.match(preview.querySelector('[role="status"]').textContent, /Loading preview/);
  await context.act(async () => {
    window.dispatchEvent(
      new context.dom.window.MessageEvent('message', {
        source: iframe.contentWindow,
        data: { type: 'avb:component-preview', status: 'unknown' },
      }),
    );
  });
  assert.equal(preview.dataset.loading, 'true', 'Malformed preview status is ignored');
  await sendPreviewStatus(context, iframe, 'ready');
  assert.equal(preview.style.visibility, 'visible', 'Rendered content reveals the preview box');
  assert.ok(preview.querySelector('[role="status"]') === null, 'Ready content replaces loading');
  return iframe;
}

async function sendPreviewStatus(context, iframe, status) {
  await sendPreviewWindowStatus(context, iframe.contentWindow, status);
}

async function sendPreviewWindowStatus(context, source, status) {
  await context.act(async () => {
    window.dispatchEvent(
      new context.dom.window.MessageEvent('message', {
        source,
        data: { type: 'avb:component-preview', status },
      }),
    );
  });
}

async function pointerEvent({ dom, act }, item, type, relatedTarget = document.body) {
  await act(async () => {
    item.dispatchEvent(
      new dom.window.MouseEvent(type, {
        bubbles: true,
        relatedTarget,
      }),
    );
  });
}

function itemInFolder(folder) {
  const heading = [...document.querySelectorAll('.palette-folder')].find((element) => element.textContent === folder);
  assert.ok(heading, `Folder ${folder} is listed`);
  const item = heading.nextElementSibling;
  assert.ok(item?.classList.contains('palette-item'), `${folder} has a component`);
  return item;
}

async function buildPalette() {
  const output = repoPath('node_modules/.stacki-test/palette-preview.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await esbuild.build({
    entryPoints: [repoPath('src/features/palette/PalettePanel.tsx')],
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
