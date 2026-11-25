// Goal: editing background layers keeps what the `background` shorthand says
// beyond the five modelled longhands. Converting it to longhands dropped
// padding-box / border-box (the gradient-border technique), and a layer written
// as var() or image-set() was not read as an image, so it was lost or became the
// colour. Method: the model's split / serialize functions over such shorthands,
// then the Backgrounds section mounted in jsdom with its own Remove button, and
// the recorded writes. The negative space: no box keywords writes no box
// longhand, a longhand the rule already declares beside the shorthand is left
// alone, and a variable that is a colour stays the colour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const loadModule = require('../../helpers/rendererModule');

const model = loadModule('src/features/style/model/background.ts');

const BORDER = 'linear-gradient(white, white) padding-box, linear-gradient(90deg, red, blue) border-box';

test('the shorthand keeps its boxes, one entry per layer', () => {
  const longhands = model.splitBackgroundShorthand(BORDER);
  assert.equal(longhands.origin, 'padding-box, border-box');
  assert.equal(longhands.clip, 'padding-box, border-box');
  const pair = model.splitBackgroundShorthand('url(a.png) content-box border-box');
  assert.deepEqual([pair.origin, pair.clip], ['content-box', 'border-box']);
  const clipText = model.splitBackgroundShorthand('linear-gradient(red, blue) text');
  assert.deepEqual([clipText.clip, clipText.color], ['text', '']);
  const plain = model.splitBackgroundShorthand('url(a.png) center / cover, url(b.png) #fff');
  assert.deepEqual([plain.origin, plain.clip], ['', '']);
});

test('boxes move with their layer, and show in the layer code', () => {
  const layers = model.parseLayers(model.splitBackgroundShorthand(BORDER));
  assert.equal(model.serializeLayers([layers[1], layers[0]]).clip, 'border-box, padding-box');
  assert.equal(model.serializeLayers([layers[1]]).clip, 'border-box');
  for (const layer of layers) {
    assert.deepEqual(model.parseLayerShorthand(model.layerShorthand(layer)), layer);
  }
  const split = model.parseLayerShorthand('url(a.png) content-box border-box');
  assert.deepEqual(model.parseLayerShorthand(model.layerShorthand(split)), split);
});

test('a longhand box list shorter than the layers repeats, as CSS reads it', () => {
  const layers = model.parseLayers({
    image: 'url(a), url(b), url(c)',
    size: '',
    position: '',
    repeat: '',
    attachment: '',
    origin: '',
    clip: 'padding-box, border-box',
  });
  assert.deepEqual(
    layers.map((layer) => layer.clip),
    ['padding-box', 'border-box', 'padding-box'],
  );
});

test('a colour with its own box keeps it, behind a layer that paints nothing', () => {
  const longhands = model.splitBackgroundShorthand('url(a.png) padding-box, red content-box');
  assert.deepEqual([longhands.image, longhands.clip, longhands.color], ['url(a.png), none', 'padding-box, content-box', 'red']);
  assert.equal(model.parseLayers(longhands).length, 2);
});

test('image-set() and var() layers are images', () => {
  const set = 'image-set("a.png" 1x, "b.png" 2x)';
  assert.equal(model.splitBackgroundShorthand(`${set} center, #fff`).image, set);
  assert.equal(model.splitBackgroundShorthand(`-webkit-${set}`).image, `-webkit-${set}`);
  const first = model.splitBackgroundShorthand('var(--noise), url(a.png) #fff');
  assert.deepEqual([first.image, first.color], ['var(--noise), url(a.png)', '#fff']);
  const placed = model.splitBackgroundShorthand('var(--hero) center / cover no-repeat');
  assert.deepEqual([placed.image, placed.position, placed.size, placed.color], ['var(--hero)', 'center', 'cover', '']);
  const fallback = model.splitBackgroundShorthand('url(a.png), var(--grad, linear-gradient(red, blue))');
  assert.equal(fallback.image, 'url(a.png), var(--grad, linear-gradient(red, blue))');
  const resolved = model.splitBackgroundShorthand('url(a.png), var(--grad)', new Map([['--grad', 'linear-gradient(red, blue)']]));
  assert.deepEqual([resolved.image, resolved.color], ['url(a.png), var(--grad)', '']);
});

test('a variable alone in the last layer is still the colour unless it holds an image', () => {
  for (const value of ['var(--surface)', 'url(a.png), var(--surface)', 'url(a.png) var(--surface)']) {
    assert.equal(model.splitBackgroundShorthand(value).color, 'var(--surface)', value);
  }
  const resolved = model.splitBackgroundShorthand('var(--surface) no-repeat', new Map([['--surface', '#123456']]));
  assert.deepEqual([resolved.image, resolved.color], ['', 'var(--surface)']);
});

test('a `none` between longhand layers keeps the lists aligned', () => {
  const layers = model.parseLayers({
    image: 'none, url(b)',
    size: '10px, cover',
    position: '',
    repeat: '',
    attachment: '',
    origin: '',
    clip: '',
  });
  assert.equal(model.serializeLayers(layers).size, '10px, cover');
  assert.deepEqual(model.parseLayers({ image: 'none', size: '', position: '', repeat: '', attachment: '', origin: '', clip: '' }), []);
});

// ─── The section ───

const dom = new JSDOM('<!doctype html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.navigator = dom.window.navigator;
global.IS_REACT_ACT_ENVIRONMENT = true;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.MutationObserver = dom.window.MutationObserver;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = repoPath('node_modules/.stacki-test/background-boxes.bundle.js');
esbuild.buildSync({
  stdin: { contents: "export { default as BackgroundSection } from './src/features/style/BackgroundSection';", resolveDir: ROOT, loader: 'tsx' },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { BackgroundSection } = require(bundle);

function declared(value) {
  const winner = { value, important: false, selectorText: '.hero' };
  return { source: 'selected', overridden: false, winner, selectedValue: winner, contributors: [] };
}

// The writes made by removing layer `index` of the list `props` describes.
async function removeLayer(index, props) {
  const writes = [];
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(BackgroundSection, {
        read: (prop) => props[prop],
        busy: false,
        setProp: (prop, value) => writes.push([prop, value]),
        clearProp: (prop) => writes.push(['clear', prop]),
        liveSetProp: () => {},
        onProvenance: () => {},
        onSelectSelector: () => {},
      }),
    );
  });
  const buttons = host.querySelectorAll('button[aria-label="Remove layer"]');
  assert.ok(buttons[index], 'the layer list offers Remove layer');
  await act(async () => {
    buttons[index].click();
  });
  await act(async () => root.unmount());
  host.remove();
  return writes;
}

test('converting a shorthand writes its boxes', async () => {
  const writes = await removeLayer(2, {
    background: declared(`${BORDER}, url(c.png) border-box`),
  });
  assert.deepEqual(writes, [
    ['background-image', 'linear-gradient(white, white), linear-gradient(90deg, red, blue)'],
    ['background-origin', 'padding-box, border-box'],
    ['background-clip', 'padding-box, border-box'],
    ['clear', 'background'],
  ]);
});

test('a longhand declared beside the shorthand is not cleared or rewritten', async () => {
  const writes = await removeLayer(1, {
    background: declared('linear-gradient(red, blue), url(b.png)'),
    'background-clip': declared('text'),
    'background-size': declared('cover'),
  });
  assert.deepEqual(writes, [
    ['background-image', 'linear-gradient(red, blue)'],
    ['clear', 'background'],
  ]);
});

test('a box list among the longhands is edited with its layers; a single box is left alone', async () => {
  const listed = await removeLayer(0, {
    'background-image': declared('url(a.png), url(b.png)'),
    'background-clip': declared('padding-box, border-box'),
  });
  assert.deepEqual(listed, [
    ['background-image', 'url(b.png)'],
    ['background-clip', 'border-box'],
  ]);
  const single = await removeLayer(0, {
    'background-image': declared('url(a.png), url(b.png)'),
    'background-clip': declared('text'),
  });
  assert.deepEqual(single, [['background-image', 'url(b.png)']]);
});

test('a slash inside a url or a colour is not spaced out', () => {
  const longhands = model.splitBackgroundShorthand('url(/img/a.png) center/cover, url("b/c.png") rgb(0 0 0/50%)');
  assert.deepEqual([longhands.image, longhands.color, longhands.size], ['url(/img/a.png), url("b/c.png")', 'rgb(0 0 0/50%)', 'cover, auto']);
});
