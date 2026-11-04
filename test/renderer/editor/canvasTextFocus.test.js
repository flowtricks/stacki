// Goal: while canvas text is being edited, the app counts the canvas frame as
// a focused field, so the menu's Copy, Cut and Paste (⌘V) go to the text, not
// to "paste the copied element". Only then: an idle canvas, or focus on any
// other element, is not a field.
// Method: the module with a stand-in document whose focused element is set.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

class HTMLIFrameElement {}
globalThis.HTMLIFrameElement = HTMLIFrameElement;
globalThis.document = { activeElement: new HTMLIFrameElement() };
const { canvasTextHasFocus, noteCanvasTextEditing } = load('src/editor/canvasTextFocus.ts');

assert.equal(canvasTextHasFocus(), false, 'nothing is being edited yet');
noteCanvasTextEditing('active');
assert.equal(canvasTextHasFocus(), true);
globalThis.document = { activeElement: {} };
assert.equal(canvasTextHasFocus(), false, 'focus moved to the app: its own fields decide');
globalThis.document = { activeElement: new HTMLIFrameElement() };
noteCanvasTextEditing('inactive');
assert.equal(canvasTextHasFocus(), false, 'the editor closed');
console.log('canvas text focus: ok');
