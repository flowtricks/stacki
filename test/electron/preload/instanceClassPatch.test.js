// Goal: a class shown on the canvas ahead of its render ends up as the rendering says, never as the
// guess said. The case that broke: a component instance passes a class the component also writes
// itself. Taking it off the instance dropped it from the live element at once; both renderings still
// carry the name, so the patch, which writes only what two renderings disagree about, never put it
// back, and the canvas stayed wrong until a refresh. The same went for a class added to an instance
// whose component never passes it on.
// Method: a JSDOM page, the real preload ledger and the real morph patcher, driven in the morph
// client's order: avb:before-morph, patchAttrs from the previous rendering to the next, avb:after-patch.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const loadMorphModules = require('../../helpers/morphModules.js');
const edits = loadRenderer('electron/preload/framePendingEdit.ts');

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
// An instance's root carries two tokens: its place in the component and in the page. The app names it by one.
const PATH = '0.0';
const heading = (classes) => `<h2 class="${classes}" data-avb-p="src/components/Heading.astro|0 ${PATH}">Title</h2>`;

function pageShowing(classes) {
  const dom = new JSDOM(`<!doctype html><body><!--avb-d:${OLD}:src/pages/index.astro-->${heading(classes)}</body>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  global.Document = dom.window.Document;
  global.HTMLElement = dom.window.HTMLElement;
  global.NodeFilter = dom.window.NodeFilter;
  const parse = (checksum, next) =>
    new dom.window.DOMParser().parseFromString(`<!doctype html><body><!--avb-d:${checksum}:src/pages/index.astro-->${heading(next)}</body>`, 'text/html');
  let previous = parse(OLD, classes);
  const { patchAttrs } = loadMorphModules();
  const live = () => dom.window.document.querySelector('h2');
  const render = (checksum, next) => {
    const rendering = parse(checksum, next);
    document.dispatchEvent(new CustomEvent('avb:before-morph', { detail: rendering }));
    patchAttrs(live(), previous.querySelector('h2'), rendering.querySelector('h2'));
    previous = rendering;
    document.dispatchEvent(new CustomEvent('avb:after-patch', { detail: rendering }));
  };
  edits.listenForCanvasEdits();
  return { dom, live, render, classes: () => [...live().classList].sort() };
}

const show = (add, remove) => edits.showCanvasEdits([{ kind: 'classes', path: PATH, add, remove }]);

function close(dom) {
  edits.revertCanvasEdits();
  dom.window.close();
}

test('a class taken off an instance comes back when the component writes it too', () => {
  const page = pageShowing('heading accent wrap accent');
  try {
    assert.equal(show([], ['accent']), 1);
    assert.deepEqual(page.classes(), ['heading', 'wrap'], 'the removal shows at once');
    page.render(OLD, 'heading accent wrap accent');
    assert.deepEqual(page.classes(), ['heading', 'wrap'], 'a render of the old file keeps the guess');
    page.render(NEW, 'heading wrap accent');
    assert.deepEqual(page.classes(), ['accent', 'heading', 'wrap']);
    assert.equal(edits.canvasEditsPending(), false);
  } finally {
    close(page.dom);
  }
});

test('a class that only the instance passed stays off, and classes page scripts added stay on', () => {
  const page = pageShowing('heading accent');
  try {
    page.live().classList.add('in-view');
    show([], ['accent']);
    page.render(NEW, 'heading');
    assert.deepEqual(page.classes(), ['heading', 'in-view']);
  } finally {
    close(page.dom);
  }
});

test('a class added to an instance whose component never passes it on does not stay', () => {
  const page = pageShowing('heading');
  try {
    show(['ignored'], []);
    assert.deepEqual(page.classes(), ['heading', 'ignored']);
    page.render(NEW, 'heading');
    assert.deepEqual(page.classes(), ['heading']);
  } finally {
    close(page.dom);
  }
});

test('only what the edit changed is taken back: a refusal leaves the classes that were there', () => {
  const page = pageShowing('heading accent');
  try {
    assert.equal(show(['accent'], ['absent']), 0, 'nothing to change is nothing to take back');
    show(['accent', 'wrap'], ['heading', 'absent']);
    edits.revertCanvasEdits();
    assert.deepEqual(page.classes(), ['accent', 'heading']);
  } finally {
    close(page.dom);
  }
});

test('class names from a message are bounded and single', () => {
  const page = pageShowing('heading');
  try {
    for (const bad of [[''], ['two words'], ['x'.repeat(257)], [7], Array.from({ length: 65 }, (_, at) => `c${at}`), 'wrap']) {
      assert.equal(show(bad, []), 0);
      assert.equal(show([], bad), 0);
    }
    assert.deepEqual(page.classes(), ['heading']);
  } finally {
    close(page.dom);
  }
});
