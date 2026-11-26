// Goal: a node chosen in the insert palette is on the canvas in the same task as the choice, in
// the place the page will put it, selectable by the path it will have; the rebuilt page replaces
// it without a second copy, a flash or a jump; a refused write takes it away; and none of it is
// ever written anywhere.
// Method: JSDOM pages with marker comments, tagged elements and source stamps, the real frame
// modules bundled for Node. A fake patch is the same two events the morph client dispatches
// (`avb:before-morph`, then `avb:after-patch`), with the rendering a Document carrying the stamps
// of the source it was rendered from. JSDOM has no constructable stylesheets, so a stand-in
// records the rule.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const pending = loadRenderer('electron/preload/framePendingInsert.ts');

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const MARK = 'data-avb-pending-insert';

const stamped = (checksum) => `<!--avb-d:${checksum}:src/pages/index.astro-->`;
function page(checksum = OLD) {
  const dom = new JSDOM(
    `<!doctype html><body>${stamped(checksum)}<main data-avb-p="0"><!--avb-s:0.0--><p data-avb-p="0.0">one</p><!--avb-e:0.0-->` +
      '<!--avb-s:0.1--><p data-avb-p="0.1">two</p><!--avb-e:0.1--></main><div data-avb-p="1"></div></body>',
  );
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  global.Document = dom.window.Document;
  global.document.adoptedStyleSheets = [];
  global.CSSStyleSheet = class {
    replaceSync(text) {
      this.text = text;
    }
  };
  global.NodeFilter = dom.window.NodeFilter;
  return dom;
}

const element = (tag, text) => ({ kind: 'element', tag, attributes: [['class', 'x']], text });
const insertAt = (index, node, anchor = { path: [0, 0], placement: 'before' }) => ({ scope: '', parent: [0], index, anchor, node });
const renderingOf = (dom, checksum) => new dom.window.DOMParser().parseFromString(`<!doctype html><body>${stamped(checksum)}</body>`, 'text/html');
const paths = () => [...document.querySelectorAll('[data-avb-p]')].map((node) => node.getAttribute('data-avb-p'));

function patchWith(rendering) {
  document.dispatchEvent(new CustomEvent('avb:before-morph', { detail: rendering }));
  // The patch itself would apply here; the page keeps what the old rendering showed.
  document.dispatchEvent(new CustomEvent('avb:after-patch', { detail: rendering }));
}

test('the stand-in is in the DOM when the call returns, built from the template, at its path', () => {
  const dom = page();
  try {
    assert.equal(pending.showCanvasInsert(insertAt(0, element('p', 'Paragraph'))), true);
    const node = document.querySelector(`[${MARK}]`);
    assert.equal(node.tagName, 'P');
    assert.equal(node.textContent, 'Paragraph');
    assert.equal(node.getAttribute('class'), 'x');
    assert.equal(node.getAttribute('data-avb-p'), '0.0', 'the path the new node will have');
    assert.equal(node.nextElementSibling.textContent, 'one', 'placed before its anchor');
    assert.deepEqual(paths(), ['0', '0.0', '0.1', '0.2', '1'], 'later siblings are renumbered');
    assert.equal(document.querySelectorAll('[data-avb-p="0.0"]').length, 1, 'no two nodes share the path');
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

test('marker comments travel with the stand-in so the regions find it', () => {
  const dom = page();
  try {
    pending.showCanvasInsert(insertAt(1, element('div'), { path: [0, 0], placement: 'after' }));
    const markers = [...document.querySelector('main').childNodes].filter((node) => node.nodeType === 8).map((node) => node.data);
    assert.deepEqual(markers, ['avb-s:0.0', 'avb-e:0.0', 'avb-s:0.1', 'avb-e:0.1', 'avb-s:0.2', 'avb-e:0.2']);
    const order = [...document.querySelector('main').children].map((node) => node.textContent || node.tagName);
    assert.deepEqual(order, ['one', 'DIV', 'two']);
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

const section = () => insertAt(2, { kind: 'component', name: 'Section' }, { path: [0, 1], placement: 'after' });

test('a component draws nothing: a node with no box and no words holds its path while the server renders', () => {
  const dom = page();
  try {
    assert.equal(pending.showCanvasInsert(section()), true);
    const node = document.querySelector(`[${MARK}="component"]`);
    assert.equal(node.tagName, 'TEMPLATE');
    assert.equal(node.getAttribute('data-avb-p'), '0.2', 'the selection finds the new node, not a neighbour');
    assert.equal(document.querySelector('main').textContent, 'onetwo', 'no name and no made-up content');
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

test('a slow render gets a bar with a background, no border and no label, which the render then replaces', (context) => {
  const dom = page();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    pending.listenForCanvasInserts();
    pending.showCanvasInsert(section());
    context.mock.timers.tick(599);
    assert.equal(document.querySelector(`[${MARK}]`).tagName, 'TEMPLATE', 'still quiet');
    context.mock.timers.tick(1);
    const bar = document.querySelector(`[${MARK}="component"]`);
    assert.equal(bar.tagName, 'DIV');
    assert.equal(bar.textContent, '');
    assert.deepEqual(paths(), ['0', '0.0', '0.1', '0.2', '1']);
    const rule = document.adoptedStyleSheets.at(-1).text;
    assert.match(rule, /background:/);
    assert.match(rule, /align-self: stretch/);
    assert.doesNotMatch(rule, /border:|content:/);
    patchWith(renderingOf(dom, OLD));
    assert.equal(document.querySelector(`[${MARK}]`).tagName, 'DIV', 'a render of the old file keeps the bar, not a new quiet wait');
    patchWith(renderingOf(dom, NEW));
    assert.equal(document.querySelectorAll(`[${MARK}]`).length, 0);
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

const twin = { kind: 'clone', from: [0, 1], twinOf: 'Card' };

test('a twin is copied from the page at once, numbered from where the original now is', () => {
  const dom = page();
  try {
    assert.equal(pending.showCanvasInsert(insertAt(0, twin)), true);
    const copy = document.querySelector('[data-avb-p="0.0"]');
    assert.equal(copy.textContent, 'two', 'the original after the new node, found under its new number');
    assert.equal(copy.tagName, 'P');
    assert.deepEqual(paths(), ['0', '0.0', '0.1', '0.2', '1']);
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

for (const [why, change] of [
  ['one opened since it was rendered', (original) => original.setAttribute('aria-expanded', 'true')],
  ['one the page does not render', (original) => original.replaceWith(document.createComment('nothing'))],
]) {
  test(`a twin that is ${why} is not copied: the render is waited for`, () => {
    const dom = page();
    try {
      change(document.querySelector('[data-avb-p="0.1"]'));
      assert.equal(pending.showCanvasInsert(insertAt(0, twin)), true);
      assert.equal(document.querySelector(`[${MARK}]`).tagName, 'TEMPLATE');
    } finally {
      pending.revertCanvasInserts();
      dom.window.close();
    }
  });
}

test('an element with nothing rendered inside takes its first child inside', () => {
  const dom = page();
  try {
    assert.equal(pending.showCanvasInsert({ scope: '', parent: [1], index: 0, anchor: { path: [1], placement: 'inside' }, node: element('p', 'x') }), true);
    assert.equal(document.querySelector('div[data-avb-p="1"]').firstElementChild.getAttribute('data-avb-p'), '1.0');
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

test('a patch from the new source replaces it exactly: nothing is left over, paths are the page’s own', () => {
  const dom = page();
  try {
    pending.listenForCanvasInserts();
    pending.showCanvasInsert(insertAt(0, element('p', 'Paragraph')));
    patchWith(renderingOf(dom, NEW));
    assert.equal(document.querySelectorAll(`[${MARK}]`).length, 0);
    assert.deepEqual(paths(), ['0', '0.0', '0.1', '1'], 'the numbering the old page had; the patch writes the new');
    assert.equal(pending.canvasInsertsPending(), false);
  } finally {
    dom.window.close();
  }
});

test('a render of the old source keeps the stand-in: it is drawn again right after the patch', () => {
  const dom = page();
  try {
    pending.listenForCanvasInserts();
    pending.showCanvasInsert(insertAt(0, element('p', 'Paragraph')));
    patchWith(renderingOf(dom, OLD));
    assert.equal(document.querySelectorAll(`[${MARK}]`).length, 1, 'never off the page for a paint');
    assert.deepEqual(paths(), ['0', '0.0', '0.1', '0.2', '1']);
    patchWith(renderingOf(dom, NEW));
    assert.equal(document.querySelectorAll(`[${MARK}]`).length, 0);
    assert.equal(pending.canvasInsertsPending(), false);
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

test('a refused write takes the stand-in away and puts every path back', () => {
  const dom = page();
  try {
    const before = document.body.innerHTML;
    pending.showCanvasInsert(insertAt(0, element('p', 'Paragraph')));
    assert.notEqual(document.body.innerHTML, before);
    pending.revertCanvasInserts();
    assert.equal(document.body.innerHTML, before, 'byte for byte the page it was');
  } finally {
    dom.window.close();
  }
});

test('the frame announces a shown and a reverted stand-in like a patch, so outlines re-measure', () => {
  const dom = page();
  try {
    let heard = 0;
    document.addEventListener('avb:morphed', () => (heard += 1));
    pending.showCanvasInsert(insertAt(0, element('p', 'Paragraph')));
    pending.revertCanvasInserts();
    assert.equal(heard, 2);
  } finally {
    dom.window.close();
  }
});

test('an anchor that is not on the page draws nothing and leaves the page untouched', () => {
  const dom = page();
  try {
    const before = document.body.innerHTML;
    assert.equal(pending.showCanvasInsert(insertAt(0, element('p', 'x'), { path: [9, 9], placement: 'before' })), false);
    assert.equal(document.body.innerHTML, before);
  } finally {
    dom.window.close();
  }
});

test('the number shown at once is bounded', () => {
  const dom = page();
  try {
    let drawn = 0;
    for (let count = 0; count < 20; count += 1) {
      if (pending.showCanvasInsert(insertAt(0, element('p', String(count))))) {
        drawn += 1;
      }
    }
    assert.equal(drawn, 16);
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

test('the stand-in is in the DOM within one frame of the call, and nothing is fetched or stored', () => {
  const dom = page();
  const requests = [];
  global.fetch = (...input) => requests.push(input);
  try {
    const started = performance.now();
    pending.showCanvasInsert(insertAt(0, element('p', 'Paragraph')));
    assert.equal(document.querySelectorAll(`[${MARK}]`).length, 1);
    assert.ok(performance.now() - started < 16, 'drawn synchronously, inside a frame');
    assert.deepEqual(requests, [], 'a stand-in asks nobody for anything');
  } finally {
    delete global.fetch;
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

test('a duplicate is a deep copy of what the original rendered, its paths renamed, right after it', () => {
  const dom = page();
  try {
    document.querySelector('main').insertAdjacentHTML('beforeend', '');
    const original = document.querySelector('[data-avb-p="0.0"]');
    original.innerHTML = '<span data-avb-p="0.0.0">inner</span>';
    const plan = { scope: '', parent: [0], index: 1, anchor: { path: [0, 0], placement: 'after' }, node: { kind: 'clone', from: [0, 0] } };
    assert.equal(pending.showCanvasInsert(plan), true);
    const copy = document.querySelector('[data-avb-p="0.1"]');
    assert.equal(copy.textContent, 'inner');
    assert.equal(copy.querySelector('span').getAttribute('data-avb-p'), '0.1.0', 'descendant paths follow the copy');
    assert.equal(original.nextElementSibling, copy);
    assert.deepEqual(paths(), ['0', '0.0', '0.0.0', '0.1', '0.1.0', '0.2', '1'], 'the old second child is now the third');
    pending.revertCanvasInserts();
    assert.deepEqual(paths(), ['0', '0.0', '0.0.0', '0.1', '1']);
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});

test('a wrap puts an element where the node stood, the node inside it, and every path under it gains a step', () => {
  const dom = page();
  try {
    const original = document.querySelector('[data-avb-p="0.0"]');
    const plan = { scope: '', parent: [0], index: 0, anchor: { path: [0, 0], placement: 'before' }, node: { kind: 'wrap', tag: 'div', from: [0, 0] } };
    assert.equal(pending.showCanvasInsert(plan), true);
    const wrapper = document.querySelector('[data-avb-p="0.0"]');
    assert.equal(wrapper.tagName, 'DIV');
    assert.equal(wrapper.firstElementChild, original);
    assert.equal(original.getAttribute('data-avb-p'), '0.0.0');
    assert.equal(document.querySelector('[data-avb-p="0.1"]').textContent, 'two', 'siblings keep their numbers');
    const before = document.body.innerHTML;
    pending.revertCanvasInserts();
    assert.notEqual(document.body.innerHTML, before);
    assert.equal(original.getAttribute('data-avb-p'), '0.0');
    assert.equal(original.parentElement.tagName, 'MAIN', 'the node is back where it stood');
    assert.equal(original.nextElementSibling.textContent, 'two');
  } finally {
    pending.revertCanvasInserts();
    dom.window.close();
  }
});
