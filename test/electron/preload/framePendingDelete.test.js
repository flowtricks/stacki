// Goal: a deleted node is out of the document in the same turn as the delete, so every structural
// selector (:last-child, :first-child, :only-child, :nth-*, sibling combinators, :empty) matches the
// page as it will be, not as it was; the rebuilt page replaces the removal without the node
// flashing back, a render of the old source keeps it out, and a refused delete puts every node back
// exactly where it stood. Nothing is hidden with a style: a hidden sibling still counts.
// Method: JSDOM pages with tagged elements and source stamps, the real frame modules bundled for
// Node. A patch is the two events the morph client dispatches (`avb:before-morph`, `avb:after-patch`)
// around a rendering Document carrying the stamps of the source it was rendered from. The margin
// check reads getComputedStyle over a stylesheet holding a margin-trim rule.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const pending = loadRenderer('electron/preload/framePendingDelete.ts');

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

const stamped = (checksum) => `<!--avb-d:${checksum}:src/pages/index.astro-->`;
function page(checksum = OLD) {
  const dom = new JSDOM(
    `<!doctype html><head><style>.card > :last-child { margin-bottom: 0; } h2 { margin-bottom: 24px; }</style></head>` +
      `<body>${stamped(checksum)}<div class="card" data-avb-p="0"><h2 data-avb-p="0.0">heading</h2>` +
      '<p data-avb-p="0.1">gone</p><p data-avb-p="0.2">next</p></div></body>',
  );
  global.document = dom.window.document;
  global.CustomEvent = dom.window.CustomEvent;
  global.Document = dom.window.Document;
  global.NodeFilter = dom.window.NodeFilter;
  pending.clearPendingDeletes();
  return dom;
}
const renderingOf = (dom, checksum) => new dom.window.DOMParser().parseFromString(`<!doctype html><body>${stamped(checksum)}</body>`, 'text/html');
const patchWith = (rendering) => {
  document.dispatchEvent(new CustomEvent('avb:before-morph', { detail: rendering }));
  document.dispatchEvent(new CustomEvent('avb:after-patch', { detail: rendering }));
};
const texts = () => [...document.querySelector('.card').children].map((node) => node.textContent);

test('the deleted node leaves the document at once; nothing is hidden by a style or a mark', () => {
  const dom = page();
  try {
    pending.hidePendingDelete('0.1');
    assert.deepEqual(texts(), ['heading', 'next']);
    assert.equal(document.querySelector('[data-avb-pending-delete]') ?? undefined, undefined);
    assert.equal(document.adoptedStyleSheets?.length ?? 0, 0, 'no stylesheet hides anything');
  } finally {
    pending.clearPendingDeletes();
    dom.window.close();
  }
});

test('deleting the last sibling makes the one before it :last-child in the same turn, and its margin follows the rule', () => {
  const dom = page();
  try {
    const heading = document.querySelector('h2');
    const last = document.querySelector('[data-avb-p="0.2"]');
    assert.equal(heading.matches(':last-child'), false);
    assert.equal(dom.window.getComputedStyle(heading).marginBottom, '24px');
    pending.hidePendingDelete('0.2');
    pending.hidePendingDelete('0.1');
    assert.equal(heading.matches(':last-child'), true, 'the browser re-evaluates structural selectors at once');
    assert.equal(heading.matches(':only-child'), true);
    assert.equal(dom.window.getComputedStyle(heading).marginBottom, '0px', 'the margin-trim rule applies in the same turn');
    assert.equal(last.isConnected, false);
  } finally {
    pending.clearPendingDeletes();
    dom.window.close();
  }
});

test('deleting the first sibling makes the next one :first-child; sibling combinators follow', () => {
  const dom = page();
  try {
    pending.hidePendingDelete('0.0');
    assert.equal(document.querySelector('[data-avb-p="0.1"]').matches(':first-child'), true);
    assert.equal(document.querySelector('[data-avb-p="0.1"] + p').textContent, 'next');
    assert.equal(document.querySelector('h2') ?? undefined, undefined);
  } finally {
    pending.clearPendingDeletes();
    dom.window.close();
  }
});

test('a patch from the new source: put back first, so the patch deletes it itself; nothing is left over', () => {
  const dom = page();
  try {
    pending.listenForPendingDeletes();
    pending.hidePendingDelete('0.1');
    let atPatch;
    document.addEventListener('avb:before-morph', () => (atPatch = texts()), { once: true });
    patchWith(renderingOf(dom, NEW));
    assert.deepEqual(atPatch, ['heading', 'gone', 'next'], 'the patch starts from the page it was computed against');
    assert.equal(pending.pendingDeletesCount(), 0);
  } finally {
    dom.window.close();
  }
});

test('a render of the old source takes the node out again right after the patch', () => {
  const dom = page();
  try {
    pending.listenForPendingDeletes();
    pending.hidePendingDelete('0.1');
    patchWith(renderingOf(dom, OLD));
    assert.deepEqual(texts(), ['heading', 'next']);
    assert.equal(pending.pendingDeletesCount(), 1);
    patchWith(renderingOf(dom, NEW));
    assert.equal(pending.pendingDeletesCount(), 0);
  } finally {
    pending.clearPendingDeletes();
    dom.window.close();
  }
});

test('a refused delete puts every node back in its place, byte for byte, with no trace on the neighbours', () => {
  const dom = page();
  try {
    const before = document.body.innerHTML;
    pending.hidePendingDelete('0.1');
    pending.hidePendingDelete('0.1');
    pending.clearPendingDeletes();
    assert.equal(document.body.innerHTML, before);
    assert.equal(document.querySelector('h2').getAttribute('style') ?? undefined, undefined, 'no inline style left on a neighbour');
  } finally {
    dom.window.close();
  }
});

test('a node that is not on the page removes nothing', () => {
  const dom = page();
  try {
    const before = document.body.innerHTML;
    pending.hidePendingDelete('9.9');
    assert.equal(document.body.innerHTML, before);
  } finally {
    dom.window.close();
  }
});
