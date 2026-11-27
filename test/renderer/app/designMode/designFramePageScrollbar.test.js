// Goal: a Design mode frame never lets the page's own scrollbar take width from it. A page taller than the frame's
// height cap scrolls inside its frame, and a computer that draws classic scrollbars would then lay it out 15px
// narrower than the width on its label. The rule written into the frame's document is the editor canvas's own
// (CANVAS_SCROLLBAR_CSS), written once however often the frame loads, and kept when the page already has styles.
//
// Method: the real helper, bundled by test/helpers/rendererModule.js, applied to jsdom documents. jsdom has no
// layout, so the width itself is held by designModeUnlinkSoak on a Mac set to "Show scroll bars: Always".
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const load = require('../../../helpers/rendererModule');

const { hideFramePageScrollbar } = load('src/app/designMode/DesignFrameDocument.tsx');
const { CANVAS_SCROLLBAR_CSS } = load('shared/properties/canvasScrollbar.ts');

const documentOf = (html) => new JSDOM(html).window.document;
const ruleStyles = (document) => [...document.querySelectorAll('style')].filter((style) => style.textContent === CANVAS_SCROLLBAR_CSS);

test("a frame's document gets the canvas's rule: no scrollbar on the page's scrolling root", () => {
  const document = documentOf('<!doctype html><html><head><title>Page</title></head><body><p>Text</p></body></html>');
  hideFramePageScrollbar(document);
  const styles = ruleStyles(document);
  assert.equal(styles.length, 1);
  assert.equal(styles[0].parentElement, document.head, 'in <head>, beside the page’s own styles');
  assert.match(CANVAS_SCROLLBAR_CSS, /scrollbar-width: none !important/, 'the rule outranks a page’s own scrollbar-width');
});

test('a frame that loads again keeps one rule, and the page keeps its own styles', () => {
  const document = documentOf('<!doctype html><html><head><style>html { scrollbar-width: thin; }</style></head><body></body></html>');
  hideFramePageScrollbar(document);
  hideFramePageScrollbar(document);
  assert.equal(ruleStyles(document).length, 1, 'written once');
  assert.equal(document.querySelectorAll('style').length, 2, 'the page’s style stays');
  assert.equal(document.head.lastElementChild.textContent, CANVAS_SCROLLBAR_CSS, 'last, so it is read after the page’s');
});
