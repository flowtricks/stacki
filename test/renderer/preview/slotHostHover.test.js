// Goal: hovering a <slot> inside a component reads as muted, not as something to pick.
// A slot renders the host page's content, which the open component cannot select, so its hover is
// a grey fill with the reason in its tag ("Slot: content comes from the page"), never the blue accent.
// Selecting the slot itself (a Navigator click) stays the ordinary selection outline.
// Method: the real PreviewOverlays rendered to static markup with a slot's overlay info, comparing the
// classes and label of the hover and of the selection, and an ordinary element for contrast.
const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { createRequire } = require('node:module');
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { repoPath } = require('../../helpers/sources.js');

async function overlays() {
  const { outputFiles } = await esbuild.build({
    entryPoints: [repoPath('test/fixtures/apps/hoverOverlayEntry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom'],
    write: false,
  });
  const file = repoPath('node_modules/.stacki-test/slot-host-hover.cjs');
  const bundle = { exports: {} };
  new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(file), bundle, bundle.exports);
  return bundle.exports.PreviewOverlays;
}

const info = (hostContent) => ({
  label: 'slot',
  kind: 'element',
  tag: 'slot',
  astroAsset: false,
  dynamicTag: false,
  nodeKind: 'element',
  childCount: 0,
  isLayout: false,
  bound: false,
  hostContent,
});
const props = {
  rects: { 0: [{ x: 0, y: 40, w: 900, h: 200 }] },
  spacing: {},
  scale: 1,
  selPath: undefined,
  selOcc: undefined,
  hoverPath: '0',
  hoverOcc: 0,
  focusPath: undefined,
  focusWhole: false,
  pathScope: '',
};

test('a hovered slot is muted and says its content comes from the page', async () => {
  const PreviewOverlays = await overlays();
  const html = renderToStaticMarkup(createElement(PreviewOverlays, { ...props, overlayInfo: () => info(true) }));
  assert.match(html, /node-outline hover element host-content/);
  assert.match(html, /Slot: content comes from the page/);
  assert.doesNotMatch(html, />slot</, 'the tag gives the reason instead of the bare name');
});

test('a plain element hover and a selected slot keep the ordinary outline', async () => {
  const PreviewOverlays = await overlays();
  const plain = renderToStaticMarkup(createElement(PreviewOverlays, { ...props, overlayInfo: () => info(false) }));
  assert.doesNotMatch(plain, /host-content/);
  const selected = renderToStaticMarkup(
    createElement(PreviewOverlays, { ...props, hoverPath: undefined, selPath: '0', selOcc: 0, overlayInfo: () => info(true) }),
  );
  assert.match(selected, /node-outline sel element/);
  assert.doesNotMatch(selected, /host-content/);
  assert.match(selected, />slot</);
});

test('a slot that is selected and hovered shows both: the selection and the muted reason', async () => {
  const PreviewOverlays = await overlays();
  const both = renderToStaticMarkup(createElement(PreviewOverlays, { ...props, selPath: '0', selOcc: 0, overlayInfo: () => info(true) }));
  assert.match(both, /node-outline sel element/);
  assert.match(both, /node-outline hover element host-content/);
  assert.match(both, /Slot: content comes from the page/);
});

test('hovering a slot while its parent is selected shows the muted reason beside the parent outline', async () => {
  const PreviewOverlays = await overlays();
  const parent = { ...info(false), label: 'main' };
  const html = renderToStaticMarkup(
    createElement(PreviewOverlays, {
      ...props,
      rects: { 0: [{ x: 0, y: 0, w: 900, h: 300 }], 1: [{ x: 0, y: 40, w: 900, h: 200 }] },
      hoverPath: '1',
      selPath: '0',
      selOcc: 0,
      overlayInfo: (path) => (path === '1' ? info(true) : parent),
    }),
  );
  assert.match(html, /node-outline sel element/);
  assert.match(html, /host-content/);
  assert.match(html, />main</);
});
