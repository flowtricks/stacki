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
  // JSDOM has no editing commands: the ones the editor asks for are recorded (recordCommands).
  const commands = [];
  Reflect.set(window, 'stackiCommands', commands);
  window.document.execCommand = (name) => {
    commands.push(name);
    return true;
  };
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

// With line breaks the words are edited as the browser edits a block (frameRichText.ts): JSDOM has no editing
// commands, so the commands the keys ask for are recorded, and the save is read from a DOM written as the browser
// would leave it.
function recordCommands(window) {
  return Reflect.get(window, 'stackiCommands');
}

test('with line breaks, Enter and ⌘ Enter both break the line; a press elsewhere saves the whole content', () => {
  session('line', ({ caret, press, paragraph, posted }) => {
    const commands = recordCommands(paragraph.ownerDocument.defaultView);
    caret(5);
    assert.equal(paragraph.getAttribute('contenteditable'), 'true', 'the block is editable');
    press('Enter');
    press('Enter', { metaKey: true });
    press('Enter', { ctrlKey: true });
    press('Enter', { shiftKey: true });
    assert.equal(commands.filter((name) => name === 'insertLineBreak').length, 4, 'Enter, ⌘ Enter, Ctrl Enter and Shift Enter each break the line');
    assert.equal(paragraph.getAttribute('contenteditable'), 'true', 'still editing: no key finishes');
    // As the browser leaves it after two breaks at the end, then words.
    paragraph.innerHTML = 'Hello world<br>Some text<br>';
    paragraph.dispatchEvent(new paragraph.ownerDocument.defaultView.MouseEvent('mousedown', { bubbles: true }));
    assert.equal(paragraph.hasAttribute('contenteditable'), true, 'a press inside keeps editing');
  });
});

test('an Escape leaves without saving and puts the words back', () => {
  session('line', ({ press, paragraph, posted }) => {
    recordCommands(paragraph.ownerDocument.defaultView);
    paragraph.innerHTML = 'Changed<br>';
    press('Escape');
    assert.equal(paragraph.textContent, 'Hello world');
    assert.equal(paragraph.hasAttribute('contenteditable'), false);
    assert.equal(
      posted.some((message) => message.type === 'avb:rich-save'),
      false,
    );
  });
});

test('a lone break at the end is not saved; two show an empty line and are', () => {
  const { withoutTrailingCaretBreak } = loadRenderer('electron/preload/frameRichText.ts');
  assert.equal(withoutTrailingCaretBreak('Hello<br>'), 'Hello');
  assert.equal(withoutTrailingCaretBreak('Hello<br><br>'), 'Hello<br><br>');
  assert.equal(withoutTrailingCaretBreak('Hello<br>World'), 'Hello<br>World');
  assert.equal(withoutTrailingCaretBreak(''), '');
});

test('an Enter that ends an IME composition is the IME’s', () => {
  session('line', ({ caret, press, paragraph }) => {
    const commands = recordCommands(paragraph.ownerDocument.defaultView);
    caret(5);
    press('Enter', { isComposing: true });
    assert.deepEqual(
      commands.filter((name) => name === 'insertLineBreak'),
      [],
    );
    assert.equal(paragraph.getAttribute('contenteditable'), 'true');
  });
});
