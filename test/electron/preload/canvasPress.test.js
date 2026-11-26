// Goal: one click selects a component on the component canvas, however a hand moves while clicking. A press on a canvas
// box stays a click when the pointer drifts, so neither the click guard nor the move drag takes it; a pan still takes a
// moving press, and a press anywhere else (an ordinary page, the canvas between boxes) keeps its drag rules.
// A first-hand bug: with the canvas root selected, a click that moved seven pixels only marked the frame, and selecting
// the button took a second click.
// Method: ask the preload's rule with elements that answer `closest` as the page's do, with and without a pan under way.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { pressedCanvasBox, canvasPressStaysClick } = loadRenderer('electron/preload/frameCanvasPress.ts');

const inside = (...tags) => ({ closest: (selector) => (selector.split(', ').some((one) => tags.includes(one)) ? {} : undefined) });
const root = (panning) => ({ hasAttribute: (name) => panning && name === 'data-stacki-panning' });

test('a press on a frame or a group box, or on text in one, is a canvas box press', () => {
  assert.equal(pressedCanvasBox(inside('stacki-frame')), true);
  assert.equal(pressedCanvasBox(inside('stacki-group')), true);
  assert.equal(pressedCanvasBox({ parentElement: inside('stacki-frame') }), true, 'a text node asks through its element');
  assert.equal(pressedCanvasBox(inside('div', 'section')), false);
  assert.equal(pressedCanvasBox(undefined), false);
  assert.equal(pressedCanvasBox({ parentElement: undefined }), false);
});

test('it stays a click however far the pointer drifts, unless the canvas is panning', () => {
  assert.equal(canvasPressStaysClick({ onBox: true }, root(false)), true);
  assert.equal(canvasPressStaysClick({ onBox: true }, root(true)), false);
  assert.equal(canvasPressStaysClick({ onBox: false }, root(false)), false);
});
