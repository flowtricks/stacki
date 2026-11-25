// Goal: an attribute, a class, the words of an element and a renamed tag appear on the canvas in the
// same turn as the edit, as real DOM changes (so attribute selectors and structure update at once);
// an element the server must render is marked updating only after a moment and never blanked; the
// rebuilt page replaces every change without a flash; a refusal restores the page byte for byte; and
// words are never put into an element being typed in.
// Method: JSDOM pages with tagged elements and source stamps, the real frame modules bundled for Node;
// a patch is the two events the morph client dispatches around a rendering Document with the stamps of
// the source it came from. Time is real but short (the updating wait is 80 ms).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const edits = loadRenderer('electron/preload/framePendingEdit.ts');

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const stamped = (checksum) => `<!--avb-d:${checksum}:src/pages/index.astro-->`;
function page() {
  const dom = new JSDOM(
    `<!doctype html><head><style>.card > .on { color: red; } [data-open] { margin: 0; }</style></head><body>${stamped(OLD)}` +
      '<div class="card" data-avb-p="0"><h2 class="on" data-avb-p="0.0">Title</h2><p data-avb-p="0.1" title="t">Words</p><div data-avb-p="0.2"><b>x</b></div></div></body>',
  );
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  global.Document = dom.window.Document;
  global.HTMLElement = dom.window.HTMLElement;
  global.NodeFilter = dom.window.NodeFilter;
  global.CSSStyleSheet = class {
    replaceSync(text) {
      this.text = text;
    }
  };
  document.adoptedStyleSheets = [];
  return dom;
}
const renderingOf = (dom, checksum) => new dom.window.DOMParser().parseFromString(`<!doctype html><body>${stamped(checksum)}</body>`, 'text/html');
const patchWith = (rendering) => {
  document.dispatchEvent(new CustomEvent('avb:before-morph', { detail: rendering }));
  document.dispatchEvent(new CustomEvent('avb:after-patch', { detail: rendering }));
};
const at = (path) => document.querySelector(`[data-avb-p="${path}"]`);
const attributes = (path, set = [], remove = []) => [{ kind: 'attributes', path, set, remove }];

test('attributes are set and removed at once, and the selectors that read them follow', () => {
  const dom = page();
  try {
    const heading = at('0.0');
    assert.equal(dom.window.getComputedStyle(heading).color, 'rgb(255, 0, 0)');
    assert.equal(
      edits.showCanvasEdits(
        attributes(
          '0.0',
          [
            ['class', 'off'],
            ['data-open', ''],
          ],
          [],
        ),
      ),
      1,
    );
    assert.equal(heading.getAttribute('class'), 'off');
    assert.equal(heading.matches('[data-open]'), true);
    assert.notEqual(dom.window.getComputedStyle(heading).color, 'rgb(255, 0, 0)', 'the class rule no longer applies in this turn');
    edits.showCanvasEdits(attributes('0.1', [], ['title']));
    assert.equal(at('0.1').hasAttribute('title'), false);
  } finally {
    edits.revertCanvasEdits();
    dom.window.close();
  }
});

test('words and a tag change at once; words are never put in an element being typed in', () => {
  const dom = page();
  try {
    edits.showCanvasEdits([{ kind: 'text', path: '0.1', text: 'New words' }]);
    assert.equal(at('0.1').textContent, 'New words');
    edits.showCanvasEdits([{ kind: 'tag', path: '0.0', tag: 'h3' }]);
    const renamed = at('0.0');
    assert.equal(renamed.tagName, 'H3');
    assert.equal(renamed.textContent, 'Title');
    assert.equal(renamed.getAttribute('class'), 'on');
    const typed = at('0.2');
    typed.setAttribute('contenteditable', 'true');
    Object.defineProperty(typed, 'isContentEditable', { value: true });
    assert.equal(edits.showCanvasEdits([{ kind: 'text', path: '0.2', text: 'overwritten' }]), 0);
    assert.equal(typed.textContent, 'x', 'the caret’s element is left alone');
  } finally {
    edits.revertCanvasEdits();
    dom.window.close();
  }
});

test('a refusal restores the page byte for byte', () => {
  const dom = page();
  try {
    const before = document.body.innerHTML;
    edits.showCanvasEdits([
      ...attributes('0.0', [['class', 'z']], ['title']),
      { kind: 'text', path: '0.1', text: 'q' },
      { kind: 'tag', path: '0.2', tag: 'section' },
    ]);
    assert.notEqual(document.body.innerHTML, before);
    edits.revertCanvasEdits();
    assert.equal(document.body.innerHTML, before);
  } finally {
    dom.window.close();
  }
});

test('a patch from the new source takes the edits back first; a render of the old source draws them again', () => {
  const dom = page();
  try {
    edits.listenForCanvasEdits();
    edits.showCanvasEdits(attributes('0.0', [['class', 'z']]));
    patchWith(renderingOf(dom, OLD));
    assert.equal(at('0.0').getAttribute('class'), 'z', 'a render of the old file keeps it');
    patchWith(renderingOf(dom, NEW));
    assert.equal(edits.canvasEditsPending(), false);
    assert.equal(at('0.0').getAttribute('class'), 'on', 'the page the patch starts from is the previous rendering');
  } finally {
    edits.revertCanvasEdits();
    dom.window.close();
  }
});

test('an element the server must render keeps its DOM, and says it is updating only after a moment', async () => {
  const dom = page();
  try {
    const before = document.body.innerHTML;
    edits.showCanvasEdits([{ kind: 'updating', path: '0.1' }]);
    assert.equal(document.body.innerHTML, before, 'nothing changes at once, nothing is blanked');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(at('0.1').hasAttribute('data-avb-updating'), true);
    assert.equal(at('0.1').textContent, 'Words');
    edits.revertCanvasEdits();
    assert.equal(document.querySelector('[data-avb-updating]') ?? undefined, undefined);
  } finally {
    edits.revertCanvasEdits();
    dom.window.close();
  }
});

test('a path that is not on the page, and bad messages, change nothing', () => {
  const dom = page();
  try {
    const before = document.body.innerHTML;
    assert.equal(edits.showCanvasEdits(attributes('9.9', [['class', 'z']])), 0);
    assert.equal(edits.showCanvasEdits([{ kind: 'tag', path: '0.0', tag: 'script' }]), 0);
    assert.equal(edits.showCanvasEdits('nope'), 0);
    assert.equal(document.body.innerHTML, before);
  } finally {
    dom.window.close();
  }
});
