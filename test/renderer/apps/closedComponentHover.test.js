// Goal: pin the closed-component outline rules of v1.4.5 so they cannot drift again.
// - Closed: the page holds a component instance and its file is not open. Hovering or selecting any
//   content inside it (text, a wrapper, a nested instance) names the instance the page owns: ONE
//   green outline, ONE label with the cube and the component's name, never blue, never a second
//   label. The frame therefore reports no deep node in normal mode.
// - Open: the component's own file is the open one, its elements are real nodes of the tree, and
//   plain elements are blue and named as the Navigator names them (`p`, `.card-body`).
// - Deep mode (an app's) still reaches inside, unchanged.
// Method: jsdom markup written as the marker serializer writes it driving the frame modules; the real
// PreviewOverlays rendered to static markup, counting outline elements and their colour classes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');
const { createRequire } = require('node:module');
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

const frame = load('test/fixtures/apps/frameLayersEntry.ts');
const { elementLabel } = load('src/editor/classNames.ts');

const HERO = 'src/components/HomeHero.astro|';
const HEADING = 'src/components/Heading.astro|';
const PAGE =
  `<!doctype html><body><!--avb-s:0--><!--avb-s:${HERO}0--><section class="hero" id="root">` +
  `<!--avb-s:${HERO}0.0--><!--avb-s:${HEADING}0--><h2 id="heading">Hi</h2><!--avb-e:${HEADING}0--><!--avb-e:${HERO}0.0-->` +
  `<!--avb-s:${HERO}0.1--><div class="intro-wrap" id="wrap"><!--avb-s:${HERO}0.1.0--><p id="text">Build</p><!--avb-e:${HERO}0.1.0--></div><!--avb-e:${HERO}0.1-->` +
  `</section><!--avb-e:${HERO}0--><!--avb-e:0--></body>`;

test('closed component: nothing inside it is a hover target of its own in the editor mode', () => {
  const dom = new JSDOM(PAGE);
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  try {
    frame.setTracking({ paths: [], scope: '', focus: '', occurrence: 0 });
    frame.resetFocusCache();
    frame.collectRegions();
    frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'normal' });
    for (const id of ['text', 'wrap', 'root', 'heading']) {
      assert.equal(frame.deepHoverAt(document.getElementById(id), '0'), undefined, `${id}: the page's instance owns the hover`);
    }
    frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'deep' });
    assert.equal(frame.deepHoverAt(document.getElementById('text'), '0')?.node.label, 'p', 'an app deep mode still reaches inside');
    frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'normal' });
  } finally {
    dom.window.close();
  }
});

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
  const file = repoPath('node_modules/.stacki-test/closed-hover.cjs');
  const bundle = { exports: {} };
  new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(file), bundle, bundle.exports);
  return bundle.exports.PreviewOverlays;
}

const box = (x, y, width, height) => ({ x, y, w: width, h: height });
const baseProps = {
  rects: { 0: [box(0, 0, 900, 600)], 0.1: [box(0, 100, 900, 50)] },
  spacing: {},
  scale: 1,
  selPath: undefined,
  selOcc: undefined,
  hoverOcc: 0,
  focusPath: undefined,
  focusWhole: false,
  pathScope: '',
};
const component = {
  label: 'HomeHero',
  kind: 'component',
  tag: undefined,
  astroAsset: false,
  dynamicTag: false,
  nodeKind: 'component',
  childCount: 0,
  isLayout: false,
  bound: false,
};
const element = {
  label: 'p',
  kind: 'element',
  tag: 'p',
  astroAsset: false,
  dynamicTag: false,
  nodeKind: 'element',
  childCount: 0,
  isLayout: false,
  bound: false,
};
const count = (html, pattern) => (html.match(pattern) ?? []).length;

test('closed: hovering and selecting HomeHero is one green outline with one component label', async () => {
  const PreviewOverlays = await overlays();
  const hovered = renderToStaticMarkup(createElement(PreviewOverlays, { ...baseProps, hoverPath: '0', overlayInfo: () => component }));
  assert.equal(count(hovered, /node-outline hover component/g), 1);
  assert.equal(count(hovered, /node-outline-tag/g), 1, 'one label');
  assert.equal(count(hovered, /node-outline [a-z ]*element/g), 0, 'nothing blue');
  assert.match(hovered, /HomeHero/);
  assert.doesNotMatch(hovered, /node-outline-within/);
  const selected = renderToStaticMarkup(
    createElement(PreviewOverlays, { ...baseProps, hoverPath: '0', selPath: '0', selOcc: 0, overlayInfo: () => component }),
  );
  assert.equal(count(selected, /node-outline sel component/g), 1);
  assert.equal(count(selected, /node-outline hover/g), 0, 'hover on the selection draws no second outline or label');
  assert.equal(count(selected, /node-outline-tag/g), 1);
});

test('open: a plain element of the open file is blue, named as the Navigator names it', async () => {
  const PreviewOverlays = await overlays();
  const html = renderToStaticMarkup(createElement(PreviewOverlays, { ...baseProps, hoverPath: '0.1', overlayInfo: () => element }));
  assert.equal(count(html, /node-outline hover element/g), 1);
  assert.equal(count(html, /node-outline-tag/g), 1);
  assert.equal(elementLabel({ name: 'p' }), 'p');
  assert.equal(elementLabel({ name: 'p', props: { class: { type: 'string', value: 'card-body lead' } } }), '.card-body');
  const nested = renderToStaticMarkup(
    createElement(PreviewOverlays, { ...baseProps, hoverPath: '0', overlayInfo: () => ({ ...component, label: 'Heading' }) }),
  );
  assert.match(nested, /Heading/, 'a component instance in the open file is its own green outline');
  assert.equal(count(nested, /node-outline hover component/g), 1);
});
