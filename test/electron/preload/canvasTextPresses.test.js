// Goal: while text is typed on the canvas, every press inside the edited block is the editor's. A single click moves the
// caret, a drag selects across a <br>, a right click ends nothing, and no focus ring of the browser's is drawn. Presses
// outside are still the canvas's. Pinned for the block editor (rich text and a line of words), which once registered
// with none of the guards, so each of its presses was cancelled.
// Method: the frame's real press guard (frameDesign), context menu (frameTargets) and text session over JSDOM, in one
// bundle so they share what is being edited. JSDOM places no caret itself; what is checked is that nothing cancels the
// press that would, and which clicks the session takes for its own.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/canvas-text-presses');
fs.mkdirSync(directory, { recursive: true });
const output = `${directory}/frame.cjs`;
buildSync({
  stdin: {
    contents: [
      "export { listenForDesign } from './electron/preload/frameDesign';",
      "export { isCanvasTextEditing } from './electron/preload/frameTextEditing';",
      "export { createCanvasTextSession } from './electron/preload/frameTextSession';",
      "export { matchCanvasText } from './electron/preload/frameTextMatch';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});

const PAGE = '<!doctype html><body><p data-avb-p="0">Hello world<br>Second line</p><p id="other">Elsewhere</p></body>';
const GLOBALS = ['HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter', 'AbortController', 'InputEvent', 'getComputedStyle', 'location'];

function onPage(breaks, check) {
  const dom = new JSDOM(PAGE, { pretendToBeVisual: true, url: 'http://localhost/#avb-design' });
  const { window } = dom;
  const names = [...GLOBALS, 'window', 'document', 'CSSStyleSheet'];
  const previous = names.map((name) => global[name]);
  GLOBALS.forEach((name) => (global[name] = window[name]));
  global.window = window;
  global.document = window.document;
  const rules = [];
  global.CSSStyleSheet = class {
    replaceSync(css) {
      rules.push(css);
    }
  };
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 0, 0);
  window.document.caretRangeFromPoint = () => undefined;
  window.document.adoptedStyleSheets = [];
  window.document.execCommand = () => true;
  try {
    delete require.cache[output];
    const frame = require(output);
    frame.listenForDesign();
    const paragraph = window.document.querySelector('p');
    const outside = window.document.querySelector('#other');
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
      breaks,
    };
    const session = frame.createCanvasTextSession(() => {});
    session.receive({ type: 'avb:text-catalog', session: 'one', file: 'src/pages/index.astro', checksum: 'a'.repeat(64), targets: [target] });
    // Whether a press of this kind on `element` is left to the browser.
    const native = (element, type = 'mousedown') => {
      const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      element.dispatchEvent(event);
      return !event.defaultPrevented;
    };
    assert.equal(native(paragraph), false, 'before editing, a press is a selection');
    session.open(target, frame.matchCanvasText(target, paragraph), { clientX: 0, clientY: 0 });
    check({ frame, session, window, paragraph, outside, native, rules });
    session.dismiss();
    assert.equal(frame.isCanvasTextEditing(paragraph), false, 'finishing gives the presses back to the canvas');
    window.close();
  } finally {
    names.forEach((name, index) => (global[name] = previous[index]));
  }
}

test('in a line of words, presses inside are the browser’s and presses outside the canvas’s', () => {
  onPage('line', ({ frame, paragraph, outside, native, rules }) => {
    assert.equal(paragraph.getAttribute('contenteditable'), 'true', 'the block editor opened');
    assert.equal(frame.isCanvasTextEditing(paragraph.lastChild), true, 'the words after the break are being edited');
    assert.equal(native(paragraph), true, 'a press inside places the caret');
    assert.equal(native(outside), false, 'a press outside is not the editor’s');
    assert.match(rules.at(-1), /outline: none !important/, 'no focus ring of the browser’s own');
    assert.match(rules.at(-1), /cursor: text !important/);
  });
});

test('a click that ends a press begun inside is the editor’s, wherever it lands', () => {
  onPage('line', ({ session, window, paragraph, outside, native }) => {
    // A drag out of the block clicks whatever holds both ends, with or without words left selected.
    native(paragraph);
    window.getSelection().removeAllRanges();
    assert.equal(session.contains({ target: window.document.body }), true);
    native(outside);
    assert.equal(session.contains({ target: window.document.body }), false, 'a press outside ends the edit as before');
    assert.equal(session.contains({ target: paragraph }), true);
  });
});
