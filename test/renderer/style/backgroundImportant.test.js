// Goal: editing the background layer list keeps `!important`. The layers have no
// text to delete the flag from, and every list write dropped it, so removing one
// layer let a weaker rule's background take over.
// Method: the Backgrounds section is mounted in jsdom over a hand-built resolved
// model, a layer is removed with its own button, and the recorded writes are
// checked: from the longhand, and from the `background` shorthand the list
// migrates off. The negative space: an unflagged list stays unflagged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

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
const bundle = repoPath('node_modules/.stacki-test/background-important.bundle.js');
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

function declared(value, important) {
  const winner = { value, important, selectorText: '.hero' };
  return { source: 'selected', overridden: false, winner, selectedValue: winner, contributors: [] };
}

// The writes made by removing the first layer of the list `props` describes.
async function removeFirstLayer(props) {
  const writes = [];
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(BackgroundSection, {
        read: (prop) => props[prop],
        busy: false,
        setProp: (prop, value, important) => writes.push([prop, value, important]),
        clearProp: (prop) => writes.push(['clear', prop]),
        liveSetProp: () => {},
        onProvenance: () => {},
        onSelectSelector: () => {},
      }),
    );
  });
  const remove = host.querySelector('button[aria-label="Remove layer"]');
  assert.ok(remove, 'the layer list offers Remove layer');
  await act(async () => {
    remove.click();
  });
  await act(async () => root.unmount());
  host.remove();
  return writes;
}

test('removing a layer keeps the list flagged', async () => {
  const writes = await removeFirstLayer({ 'background-image': declared('url(a.png), url(b.png)', true) });
  assert.deepEqual(writes, [['background-image', 'url(b.png)', true]]);
});

test('migrating off a flagged shorthand flags the longhands', async () => {
  const writes = await removeFirstLayer({ background: declared('url(a.png), url(b.png) red', true) });
  assert.deepEqual(writes, [
    ['background-image', 'url(b.png)', true],
    ['clear', 'background'],
    ['background-color', 'red', true],
  ]);
});

test('an unflagged list stays unflagged', async () => {
  const writes = await removeFirstLayer({ 'background-image': declared('url(a.png), url(b.png)', false) });
  assert.deepEqual(writes, [['background-image', 'url(b.png)', false]]);
});
