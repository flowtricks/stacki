// Goal: on the canvas, Enter types a line break only in text whose component allows it; there ⌘/Ctrl Enter finishes,
// Escape still cancels, an IME composition's Enter is left to the IME, and a break typed at the end of the words keeps a
// caret line open with a space that is never saved. Everywhere else Enter finishes editing, as it always did.
// Method: open a real canvas text session in JSDOM over rendered markup with a catalog target that carries `breaks`
// (or not), press keys on the editing element, and read the words and the messages the frame posts. JSDOM lays
// nothing out; the editor's own text model is what is checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const LINE_END = '​';

function session(breaks, run) {
  const dom = new JSDOM('<!doctype html><body><p data-avb-p="0">Hello world</p></body>', { pretendToBeVisual: true });
  const { window } = dom;
  for (const name of ['HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter', 'AbortController', 'InputEvent', 'getComputedStyle']) {
    global[name] = window[name];
  }
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.CSSStyleSheet = class {
    replaceSync() {}
  };
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 0, 0);
  window.document.caretRangeFromPoint = () => undefined;
  window.document.adoptedStyleSheets = [];
  const posted = [];
  const { createCanvasTextSession } = loadRenderer('electron/preload/frameTextSession.ts');
  const { matchCanvasText } = loadRenderer('electron/preload/frameTextMatch.ts');
  const target = {
    kind: 'element',
    key: 'k0',
    path: '0.0',
    parent: '0',
    value: 'Hello world',
    label: 'p',
    nested: false,
    tag: 'p',
    siblings: [],
    literal: true,
    ...(breaks === undefined ? {} : { breaks }),
  };
  const canvas = createCanvasTextSession((message) => posted.push(message));
  canvas.receive({ type: 'avb:text-catalog', session: 'one', file: 'src/pages/index.astro', checksum: 'a'.repeat(64), targets: [target] });
  const paragraph = window.document.querySelector('p');
  try {
    canvas.open(target, matchCanvasText(target, paragraph), { clientX: 0, clientY: 0 });
    const text = paragraph.firstChild;
    const caret = (offset) => window.getSelection().collapse(text, offset);
    const press = (key, init = {}) => paragraph.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    // JSDOM renders no source stamps, so a finished edit is refused as a changed page: the words the editor would save
    // are read from its drafts, which carry the same value the save does (canvasTextWithoutLineEnds on both).
    const drafts = () => posted.filter((message) => message.type === 'avb:text-draft').map((message) => message.value);
    run({ paragraph, text, caret, press, posted, drafts, saves: () => posted.filter((message) => message.type === 'avb:text-save') });
  } finally {
    canvas.dismiss();
    window.close();
  }
}

test('without the setting, Enter finishes editing and types nothing', () => {
  session(undefined, ({ caret, press, paragraph, posted }) => {
    caret(5);
    press('Enter');
    assert.equal(paragraph.textContent, 'Hello world');
    assert.equal(paragraph.hasAttribute('contenteditable'), false, 'the editor closed');
    assert.ok(posted.some((message) => message.type === 'avb:text-inactive'));
  });
});

test('with line breaks, Enter types a break where the caret is, and ⌘ Enter saves it', () => {
  session('line', ({ caret, press, text, paragraph, drafts }) => {
    caret(5);
    press('Enter');
    assert.equal(text.data, 'Hello\n world');
    assert.equal(paragraph.getAttribute('contenteditable'), 'true', 'still editing');
    press('Enter', { shiftKey: true });
    assert.equal(text.data, 'Hello\n\n world', 'Shift Enter types a break too');
    press('Enter', { metaKey: true });
    assert.equal(paragraph.hasAttribute('contenteditable'), false, 'the editor closed');
    assert.equal(drafts().at(-1), 'Hello\n\n world');
  });
});

test('a break at the end keeps an empty caret line open, and the space is never saved', () => {
  session('line', ({ caret, press, text, drafts }) => {
    caret(11);
    press('Enter');
    assert.equal(text.data, `Hello world\n${LINE_END}`);
    press('Enter', { ctrlKey: true });
    assert.equal(drafts().at(-1), 'Hello world\n');
  });
});

test('rich text types a break the save turns into a paragraph; Escape cancels and restores the words', () => {
  session('rich', ({ caret, press, text, paragraph, saves }) => {
    caret(5);
    press('Enter');
    assert.equal(text.data, 'Hello\n world');
    press('Escape');
    assert.equal(paragraph.textContent, 'Hello world');
    assert.deepEqual(saves(), []);
  });
});

test('an Enter that ends an IME composition is the IME’s', () => {
  session('line', ({ caret, press, text, paragraph }) => {
    caret(5);
    press('Enter', { isComposing: true });
    assert.equal(text.data, 'Hello world');
    assert.equal(paragraph.getAttribute('contenteditable'), 'true');
  });
});
