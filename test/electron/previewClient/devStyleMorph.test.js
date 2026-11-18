// Goal: when a <style> block is deleted, the canvas's patch removes that block's dev stylesheet from the live head
// and no other. The server inlines each block as <style data-vite-dev-id="File.astro?astro&type=style&index=N...">;
// unkeyed, every <style> was the same kind of node to the diff, so deleting one block removed the LAST stylesheet
// of the head instead: an is:global block went on styling the page after it was deleted, and another component
// lost its own rules. Undo puts the block back where the server renders it.
// Method: a jsdom page whose head holds the stylesheets of three components, as Astro's dev server renders them;
// renderings from that window's DOMParser without one block (the global one, then block 0 of two), and with it
// again, go through the real morph modules (patchChildren on the head, then refreshDevStyles). The checks name the
// stylesheets left in the live head, in order, and that the live elements of the blocks that stayed are the same
// nodes (Vite updates them in place; replacing them would flash the page unstyled).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadMorphModules = require('../../helpers/morphModules.js');

const DEV_ID = (file, index) => `/project/src/components/${file}.astro?astro&type=style&index=${index}&lang.css`;
const STYLE = (file, index, css) => `<style data-vite-dev-id="${DEV_ID(file, index).replaceAll('&', '&amp;')}">${css}</style>`;
const BLOCKS = {
  div: STYLE('Div', 0, '.my-class { padding: 1.25rem; }'),
  global: STYLE('Global', 0, '.g { padding-top: 6px; }'),
  twoFirst: STYLE('Two', 0, '.a { color: red; }'),
  twoSecond: STYLE('Two', 1, '.b { padding: 8px; }'),
  twoShifted: STYLE('Two', 0, '.b { padding: 8px; }'),
};
const PAGE = (styles) =>
  `<!doctype html><html><head><title>Page</title>${styles.join('')}<script type="module" src="/@vite/client"></script></head><body><main><p>Body</p></main></body></html>`;

function rendering(dom, morph, html) {
  const withAnchors = new dom.window.DOMParser().parseFromString(html, 'text/html');
  const clean = withAnchors.cloneNode(true);
  morph.stripAnchors(clean);
  return { withAnchors, clean };
}

function setup(styles) {
  const html = PAGE(styles);
  const dom = new JSDOM(html);
  global.document = dom.window.document;
  const morph = loadMorphModules();
  return { dom, morph, document: dom.window.document, current: rendering(dom, morph, html) };
}

// One server rendering applied as the morph client applies it to the head.
function apply(scene, styles) {
  const next = rendering(scene.dom, scene.morph, PAGE(styles));
  scene.morph.patchChildren(scene.document.head, scene.current.clean.head, next.clean.head);
  scene.morph.refreshDevStyles(scene.current.clean, next.clean);
  scene.current = next;
}

const liveStyles = (document) =>
  [...document.head.querySelectorAll('style')].map((style) => `${style.getAttribute('data-vite-dev-id').split('/').pop()} ${style.textContent}`);

test('deleting an is:global block removes its stylesheet, not the last one in the head', () => {
  const scene = setup([BLOCKS.div, BLOCKS.global, BLOCKS.twoFirst]);
  const kept = scene.document.head.querySelectorAll('style');
  apply(scene, [BLOCKS.div, BLOCKS.twoFirst]);
  assert.deepEqual(liveStyles(scene.document), [
    'Div.astro?astro&type=style&index=0&lang.css .my-class { padding: 1.25rem; }',
    'Two.astro?astro&type=style&index=0&lang.css .a { color: red; }',
  ]);
  const after = scene.document.head.querySelectorAll('style');
  assert.equal(after[0], kept[0], 'the blocks that stayed are the same live nodes');
  assert.equal(after[1], kept[2]);
  // Undo: the block is back where the server renders it.
  apply(scene, [BLOCKS.div, BLOCKS.global, BLOCKS.twoFirst]);
  assert.deepEqual(liveStyles(scene.document), [
    'Div.astro?astro&type=style&index=0&lang.css .my-class { padding: 1.25rem; }',
    'Global.astro?astro&type=style&index=0&lang.css .g { padding-top: 6px; }',
    'Two.astro?astro&type=style&index=0&lang.css .a { color: red; }',
  ]);
});

test('deleting block 0 of two leaves the old block 1 as block 0, and nothing else changes', () => {
  const scene = setup([BLOCKS.div, BLOCKS.twoFirst, BLOCKS.twoSecond]);
  const div = scene.document.head.querySelector('style');
  apply(scene, [BLOCKS.div, BLOCKS.twoShifted]);
  assert.deepEqual(liveStyles(scene.document), [
    'Div.astro?astro&type=style&index=0&lang.css .my-class { padding: 1.25rem; }',
    'Two.astro?astro&type=style&index=0&lang.css .b { padding: 8px; }',
  ]);
  assert.equal(scene.document.head.querySelector('style'), div, 'another component keeps its live stylesheet');
  apply(scene, [BLOCKS.div, BLOCKS.twoFirst, BLOCKS.twoSecond]);
  assert.deepEqual(liveStyles(scene.document), [
    'Div.astro?astro&type=style&index=0&lang.css .my-class { padding: 1.25rem; }',
    'Two.astro?astro&type=style&index=0&lang.css .a { color: red; }',
    'Two.astro?astro&type=style&index=1&lang.css .b { padding: 8px; }',
  ]);
});

test('deleting the only block of the first component keeps every other component styled', () => {
  const scene = setup([BLOCKS.div, BLOCKS.global, BLOCKS.twoFirst]);
  apply(scene, [BLOCKS.global, BLOCKS.twoFirst]);
  assert.deepEqual(liveStyles(scene.document), [
    'Global.astro?astro&type=style&index=0&lang.css .g { padding-top: 6px; }',
    'Two.astro?astro&type=style&index=0&lang.css .a { color: red; }',
  ]);
});
