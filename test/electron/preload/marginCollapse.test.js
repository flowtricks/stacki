// Which margin an element's top and bottom margins collapse with, as the frame reports it.
//
//   node test/electron/preload/marginCollapse.test.js
//
// Hovering `margin-top` in the style panel draws the strip that margin holds open. The page does not always
// hold it open: next to a sibling whose margin is as large, the two collapse into one and the element's own
// adds nothing, and a first child's margin can pass through its parent. The frame says what each vertical
// margin is adjoining (`Spacing.collapse`) so the app can draw a marker instead of a strip that is not there.
// Margins never collapse in a flex or grid parent, nor for a float or a positioned box.
//
// Method: jsdom, whose computed style follows the markup but which lays nothing out, so the boxes are
// supplied (the seam a real browser fills; the real-layout half is test/electron/preload/spacingBandsLayout).
// Each case is the structure from a page: siblings, a first child, a last child, a flex parent.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const { document, window } = dom.window;
global.window = window;
global.document = document;
const { marginCollapses } = loadRenderer('electron/preload/frameMeasure.ts');

const place = (element, box) => {
  element.getBoundingClientRect = () => ({ left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h, width: box.w, height: box.h });
  return element;
};
const make = (html) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild;
};
const collapses = (element) => marginCollapses(element, window.getComputedStyle(element));

test('a heading under a sibling with a margin collapses with that sibling', () => {
  const root = make('<div><p id="above" style="margin-bottom:20px"></p><h2 id="heading" style="margin-top:20px"></h2></div>');
  const heading = root.querySelector('#heading');
  assert.deepEqual(collapses(heading).top, { partner: 'previous', margin: 20 });
});

test('a bottom margin meets the next sibling top margin', () => {
  const root = make('<div><h2 id="heading" style="margin-bottom:30px"></h2><p style="margin-top:12px"></p></div>');
  assert.deepEqual(collapses(root.querySelector('#heading')).bottom, { partner: 'next', margin: 12 });
});

test('blank text between siblings does not stop them collapsing; words do', () => {
  const blank = make('<div><p style="margin-bottom:8px"></p>   \n  <h2 id="heading"></h2></div>');
  assert.equal(collapses(blank.querySelector('#heading')).top.partner, 'previous');
  const words = make('<div><p style="margin-bottom:8px"></p>words<h2 id="heading"></h2></div>');
  // (No boxes are laid out here, so the bottom edge reads as flush with its parent: only the top is asked.)
  assert.equal(collapses(words.querySelector('#heading')).top, undefined);
});

test('a hidden or positioned sibling is not what a margin collapses with', () => {
  const root = make(
    '<div><p style="margin-bottom:50px"></p><p style="display:none;margin-bottom:90px"></p><p style="position:absolute;margin-bottom:70px"></p><h2 id="heading"></h2></div>',
  );
  assert.deepEqual(collapses(root.querySelector('#heading')).top, { partner: 'previous', margin: 50 });
});

test('a flex or grid parent never collapses its items margins', () => {
  for (const display of ['flex', 'grid', 'inline-flex']) {
    const root = make(`<div style="display:${display}"><p style="margin-bottom:20px"></p><h2 id="heading" style="margin-top:20px"></h2></div>`);
    assert.equal(collapses(root.querySelector('#heading')), undefined, display);
  }
});

test('a float or an absolutely positioned box does not collapse', () => {
  const floated = make('<div><p style="margin-bottom:20px"></p><h2 id="heading" style="float:left;margin-top:20px"></h2></div>');
  assert.equal(collapses(floated.querySelector('#heading')), undefined);
  const positioned = make('<div><p style="margin-bottom:20px"></p><h2 id="heading" style="position:absolute;margin-top:20px"></h2></div>');
  assert.equal(collapses(positioned.querySelector('#heading')), undefined);
});

test('a first child whose margin passes through its parent collapses with the parent margin', () => {
  const root = make('<section style="margin-top:12px"><h2 id="heading" style="margin-top:20px"></h2></section>');
  const heading = root.querySelector('#heading');
  // Passed through: the child's box starts where the parent's does.
  place(root, { x: 0, y: 32, w: 400, h: 50 });
  place(heading, { x: 0, y: 32, w: 400, h: 30 });
  assert.deepEqual(collapses(heading).top, { partner: 'parent', margin: 12 });
});

test('a first child held inside its parent by padding has nothing to collapse with', () => {
  const root = make('<section style="padding-top:8px"><h2 id="heading" style="margin-top:20px"></h2></section>');
  const heading = root.querySelector('#heading');
  place(root, { x: 0, y: 0, w: 400, h: 80 });
  place(heading, { x: 0, y: 28, w: 400, h: 30 });
  assert.equal(collapses(heading), undefined);
});

test('a last child collapses with the parent margin when its box ends where the parent ends', () => {
  const root = make('<section style="margin-bottom:6px"><h2 id="heading" style="margin-bottom:24px"></h2></section>');
  const heading = root.querySelector('#heading');
  place(root, { x: 0, y: 0, w: 400, h: 50 });
  place(heading, { x: 0, y: 20, w: 400, h: 30 });
  assert.deepEqual(collapses(heading).bottom, { partner: 'parent', margin: 6 });
});

test('an element with no parent has nothing to collapse with', () => {
  const orphan = document.createElement('h2');
  assert.equal(collapses(orphan), undefined);
});
