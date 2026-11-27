// Goal: what the canvas shows of its own (words just typed, a hovered style) never outlives the
// render that follows. The cases that broke: typed words were left in the page's own text node,
// and the patch writes only a text node that still says what was last rendered, so words the
// render did not repeat (a refused save, a component that reshapes them) stayed until a refresh,
// through every later edit; and ending a hover preview put the style from before it back over
// one the render had written meanwhile.
// Method: a JSDOM page, the real preload modules and morph patcher, in the morph client's order:
// avb:before-morph, the patch from the previous rendering to the next, avb:after-patch.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const loadMorphModules = require('../../helpers/morphModules.js');
const edits = loadRenderer('electron/preload/framePendingEdit.ts');
const text = loadRenderer('electron/preload/frameTextNative.ts');
const liveRules = loadRenderer('electron/preload/frameLiveRules.ts');

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

function pageShowing(markup) {
  const dom = new JSDOM(`<!doctype html><body><!--avb-d:${OLD}:src/pages/index.astro-->${markup}</body>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  global.Document = dom.window.Document;
  global.HTMLElement = dom.window.HTMLElement;
  global.SVGElement = dom.window.SVGElement;
  global.NodeFilter = dom.window.NodeFilter;
  global.AbortController = dom.window.AbortController;
  const parse = (checksum, next) =>
    new dom.window.DOMParser().parseFromString(`<!doctype html><body><!--avb-d:${checksum}:src/pages/index.astro-->${next}</body>`, 'text/html');
  let previous = parse(OLD, markup);
  const morph = loadMorphModules();
  const render = (checksum, next) => {
    const rendering = parse(checksum, next);
    document.dispatchEvent(new CustomEvent('avb:before-morph', { detail: rendering }));
    morph.patchChildren(document.body, previous.body, rendering.body);
    previous = rendering;
    document.dispatchEvent(new CustomEvent('avb:after-patch', { detail: rendering }));
  };
  edits.listenForCanvasEdits();
  const words = () => document.querySelector('p').textContent;
  return { dom, render, words };
}

function close(dom) {
  refuse(dom);
  edits.revertCanvasEdits();
  dom.window.close();
}

function typed(value) {
  const node = document.querySelector('p').firstChild;
  text.showTypedWords([node], () => {
    node.data = value;
  });
}

// What the app says when a write is refused (appLifecycle.ts onRefusedGesture).
function refuse(dom) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'avb:insert-revert' } }));
}

const paragraph = (words) => `<p data-avb-p="0">${words}</p>`;

test('typed words stay through a render of the old file and give way to the new one', () => {
  const page = pageShowing(paragraph('Hello'));
  try {
    typed('hello there');
    page.render(OLD, paragraph('Hello'));
    assert.equal(page.words(), 'hello there');
    page.render(NEW, paragraph('HELLO THERE'));
    assert.equal(page.words(), 'HELLO THERE', 'the render says the words, not the typing');
    page.render('c'.repeat(64), paragraph('Later'));
    assert.equal(page.words(), 'Later');
  } finally {
    close(page.dom);
  }
});

test('typed words the render repeats exactly do not move', () => {
  const page = pageShowing(paragraph('Hello'));
  try {
    typed('Hello there');
    page.render(NEW, paragraph('Hello there'));
    assert.equal(page.words(), 'Hello there');
    refuse(page.dom);
    assert.equal(page.words(), 'Hello there', 'a render that answered the save leaves nothing to take back');
  } finally {
    close(page.dom);
  }
});

test('a render that did not change the words, and a refused save, show the page’s own', () => {
  const page = pageShowing(paragraph('Hello'));
  try {
    typed('Refused');
    refuse(page.dom);
    assert.equal(page.words(), 'Hello');
    typed('Unrendered');
    page.render(NEW, paragraph('Hello'));
    assert.equal(page.words(), 'Hello');
  } finally {
    close(page.dom);
  }
});

test('words shown over typed ones are taken back first', () => {
  const page = pageShowing(paragraph('Hello'));
  try {
    typed('Typed');
    edits.showCanvasEdits([{ kind: 'text', path: '0', text: 'Typed' }]);
    page.render(NEW, paragraph('Typed, as rendered'));
    assert.equal(page.words(), 'Typed, as rendered');
  } finally {
    close(page.dom);
  }
});

test('ending a hover preview keeps a style the render wrote under it', () => {
  const page = pageShowing('<p data-avb-p="0" style="opacity: 0.9">Hello</p>');
  const element = document.querySelector('p');
  const hover = (message) => assert.equal(liveRules.receiveLiveRules({ type: 'avb:hover-style', ...message }), true);
  try {
    hover({ op: 'show', path: '0', declarations: [{ property: 'color', value: 'red', important: false }] });
    element.style.color = 'blue'; // What a render wrote meanwhile.
    hover({ op: 'clear' });
    assert.equal(element.style.color, 'blue');
    assert.equal(element.style.opacity, '0.9');
    hover({ op: 'show', path: '0', declarations: [{ property: 'color', value: 'red', important: false }] });
    hover({ op: 'clear' });
    assert.equal(element.style.color, 'blue', 'and an untouched preview still goes back');
  } finally {
    close(page.dom);
  }
});
