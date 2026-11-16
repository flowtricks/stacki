// Goal: an insert and a reorder shown ahead of their write change the document's structure, so the
// structural selectors on the neighbours (:last-child, :first-child, the margin-trim rule) match
// the page as it will be in the same turn; no stand-in or ghost counts as a sibling by sitting in
// the page with a style, and a refusal restores the first and last child exactly.
// Method: JSDOM pages with tagged elements, the real frame modules bundled for Node; selectors are
// read with element.matches and the margin with getComputedStyle over a margin-trim rule.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const inserts = loadRenderer('electron/preload/framePendingInsert.ts');
const moves = loadRenderer('electron/preload/frameMove.ts');

function page() {
  const dom = new JSDOM(
    '<!doctype html><head><style>.card > :last-child { margin-bottom: 0; } p { margin-bottom: 16px; }</style></head><body>' +
      '<div class="card" data-avb-p="0"><p data-avb-p="0.0">first</p><p data-avb-p="0.1">last</p></div></body>',
  );
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  global.Document = dom.window.Document;
  global.NodeFilter = dom.window.NodeFilter;
  global.CSSStyleSheet = class {
    replaceSync() {}
  };
  document.adoptedStyleSheets = [];
  return dom;
}

test('an insert after the last child ends its :last-child match and its margin trim in the same turn', () => {
  const dom = page();
  try {
    const last = document.querySelector('[data-avb-p="0.1"]');
    assert.equal(last.matches(':last-child'), true);
    assert.equal(dom.window.getComputedStyle(last).marginBottom, '0px');
    const plan = {
      scope: '',
      parent: [0],
      index: 2,
      anchor: { path: [0, 1], placement: 'after' },
      node: { kind: 'element', tag: 'p', attributes: [], text: 'new' },
    };
    assert.equal(inserts.showCanvasInsert(plan), true);
    assert.equal(last.matches(':last-child'), false);
    assert.equal(dom.window.getComputedStyle(last).marginBottom, '16px');
    const added = document.querySelector('[data-avb-pending-insert]');
    assert.equal(added.matches(':last-child'), true, 'the stand-in is the last child, a real sibling');
    inserts.revertCanvasInserts();
    assert.equal(last.matches(':last-child'), true, 'a refusal restores the last child');
  } finally {
    inserts.revertCanvasInserts();
    dom.window.close();
  }
});

test('an insert before the first child takes :first-child from it at once', () => {
  const dom = page();
  try {
    const first = document.querySelector('[data-avb-p="0.0"]');
    const plan = {
      scope: '',
      parent: [0],
      index: 0,
      anchor: { path: [0, 0], placement: 'before' },
      node: { kind: 'element', tag: 'p', attributes: [], text: 'new' },
    };
    inserts.showCanvasInsert(plan);
    assert.equal(first.matches(':first-child'), false);
  } finally {
    inserts.revertCanvasInserts();
    dom.window.close();
  }
});

test('a reorder swaps first and last child in the same turn, and a revert swaps them back', () => {
  const dom = page();
  try {
    const first = document.querySelector('[data-avb-p="0.0"]');
    const last = document.querySelector('[data-avb-p="0.1"]');
    const move = { scope: '', from: [0, 0], count: 1, parent: [0], index: 2, anchor: { path: [0, 1], placement: 'after' } };
    assert.equal(moves.showCanvasMove(move), true);
    assert.equal(first.matches(':last-child'), true);
    assert.equal(last.matches(':first-child'), true);
    assert.equal(dom.window.getComputedStyle(first).marginBottom, '0px');
    assert.equal(dom.window.getComputedStyle(last).marginBottom, '16px');
    moves.revertCanvasMoves();
    assert.equal(first.matches(':first-child'), true);
    assert.equal(last.matches(':last-child'), true);
  } finally {
    moves.revertCanvasMoves();
    dom.window.close();
  }
});
