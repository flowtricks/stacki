// Goal: the menu's Undo and Redo reach the rich text editor that has focus, because a block placed whole (an image, a
// divider, a list) is only in that editor's history: the browser's undo alone passes it by.
// Method: the router both menu items use (editor/canvasTextFocus.ts) in JSDOM: a focused dialog field that takes the
// step, one that does not, and the canvas editor while its frame has focus. The route from the real menu items was
// checked in the built app, on the canvas and in the dialog.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

test('the focused rich text editor takes the step; otherwise it is left to the caller', () => {
  const dom = new JSDOM('<!doctype html><body><div class="html-content" tabindex="0"></div><iframe></iframe></body>');
  const saved = {
    document: global.document,
    window: global.window,
    Element: global.Element,
    HTMLIFrameElement: global.HTMLIFrameElement,
    CustomEvent: global.CustomEvent,
  };
  const { window } = dom;
  Object.assign(global, {
    document: window.document,
    window,
    Element: window.Element,
    HTMLIFrameElement: window.HTMLIFrameElement,
    CustomEvent: window.CustomEvent,
  });
  try {
    const focus = loadRenderer('src/editor/canvasTextFocus.ts');
    const field = window.document.querySelector('.html-content');
    assert.equal(focus.stepRichHistory('undo'), false, 'no editor has focus');
    field.focus();
    assert.equal(focus.stepRichHistory('undo'), false, 'a field with nothing of its own leaves it to the browser');
    const steps = [];
    field.addEventListener(focus.RICH_HISTORY_EVENT, (event) => {
      steps.push(event.detail);
      event.preventDefault();
    });
    assert.equal(focus.stepRichHistory('redo'), true);
    assert.deepEqual(steps, ['redo']);
    const asked = [];
    window.document.querySelector('iframe').focus();
    focus.noteCanvasTextEditing('active');
    focus.noteCanvasRichHistory((step) => asked.push(step));
    assert.equal(focus.stepRichHistory('undo'), true);
    assert.deepEqual(asked, ['undo']);
    focus.noteCanvasRichHistory(undefined);
    focus.noteCanvasTextEditing('inactive');
  } finally {
    Object.assign(global, saved);
    window.close();
  }
});
