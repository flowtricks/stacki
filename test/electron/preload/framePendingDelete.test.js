// Goal: a deleted node disappears from the canvas at once, stays gone through a render of the old
// source, and comes back only if the rebuilt page still has it — never because a later patch
// reused its path for the next sibling.
// Method: JSDOM pages with tagged elements and source stamps. JSDOM has no constructable
// stylesheets, so a minimal stand-in records the rule; hiding is read from the mark itself.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const pending = loadRenderer('electron/preload/framePendingDelete.ts');

const MARK = 'data-avb-pending-delete';

function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  global.document = dom.window.document;
  global.document.adoptedStyleSheets = [];
  global.CSSStyleSheet = class {
    replaceSync(text) {
      this.text = text;
    }
  };
  pending.clearPendingDeletes();
  return dom;
}
const STAMPED = (checksum) =>
  `<main data-avb-d="avb-d:${checksum}:src/pages/index.astro">` +
  '<p data-avb-p="0.0">keep</p><p data-avb-p="0.1">gone</p><p data-avb-p="0.2">next</p></main>';

test('the deleted node is hidden at once, and its stylesheet is installed', () => {
  const dom = page(STAMPED('a'.repeat(64)));
  try {
    pending.hidePendingDelete('0.1');
    assert.equal(document.querySelector('[data-avb-p="0.1"]').hasAttribute(MARK), true);
    assert.equal(document.querySelector('[data-avb-p="0.0"]').hasAttribute(MARK), false);
    assert.match(document.adoptedStyleSheets.at(-1).text, /display: none !important/);
  } finally {
    pending.clearPendingDeletes();
    dom.window.close();
  }
});

test('an old-source render keeps it hidden; a new-source render clears the mark', () => {
  const dom = page(STAMPED('a'.repeat(64)));
  try {
    pending.hidePendingDelete('0.1');
    pending.settlePendingDeletes();
    assert.equal(document.querySelector('[data-avb-p="0.1"]').hasAttribute(MARK), true, 'stale');
    // The rebuilt page: the stamp moved on, and the next sibling now holds path 0.1.
    document.querySelector('main').setAttribute('data-avb-d', `avb-d:${'b'.repeat(64)}:x`);
    pending.settlePendingDeletes();
    assert.equal(document.querySelectorAll(`[${MARK}]`).length, 0, 'nothing stays hidden');
  } finally {
    dom.window.close();
  }
});

test('a node that is not on the page hides nothing', () => {
  const dom = page(STAMPED('a'.repeat(64)));
  try {
    pending.hidePendingDelete('9.9');
    assert.equal(document.querySelectorAll(`[${MARK}]`).length, 0);
  } finally {
    dom.window.close();
  }
});

test('the backstop clears a delete the page never confirmed', () => {
  const dom = page(STAMPED('a'.repeat(64)));
  try {
    pending.hidePendingDelete('0.1');
    pending.clearPendingDeletes();
    assert.equal(document.querySelectorAll(`[${MARK}]`).length, 0);
  } finally {
    dom.window.close();
  }
});
