// Goal: the canvas patch has no size at which it gives up. Owner requirement: no
// size limit, so a child list of a hundred thousand nodes is lined up and
// patched correctly, and the page never reloads past a work budget (the old
// previewMorphWorkMax) or a marker count (previewMarkersMax).
// Method: build the live page, the server's previous rendering and its next one
// as real DOM (jsdom) with STACKI_SCALE_MB-scaled child lists (100 000 children
// at the default 24 MB, in proportion otherwise), run the shipped patchChildren
// over them, and compare the live list with the next rendering node for node.
// The cases are the three regimes of the diff: a few scattered edits in a huge
// list (Myers), a list replaced wholesale (nothing in common), and thousands of
// edits (the greedy pass). Every case must also leave the untouched live nodes
// in place. Wall time is printed, never asserted, in the gate: jsdom's own
// remove and insert cost grows with the list (symbol-tree index is O(n) per
// write; a browser's is not), so a patch of thousands of removals in jsdom
// measures jsdom. The many-edits regime is therefore proven twice: the pure
// diff (diffChildren, no DOM) over the full-size key lists, checked by applying
// its edit script, and the real patch over a list sized for jsdom. Absolute
// wall bounds, which a quadratic matrix (10^10 cells at this size) could not
// meet, apply only under STACKI_SOAK. The patch is synchronous by design
// (nothing may paint between a patch's first and last write).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadMorphModules = require('../../helpers/morphModules.js');
const { measureOperation, scaleMegabytes } = require('../../helpers/scaleFixtures.ts');

// Absolute wall time is machine-dependent: it is held only on a soak run, never in CI.
const WALL_MS_MAX = process.env.STACKI_SOAK === undefined ? Number.POSITIVE_INFINITY : 60_000;
// The largest list the real patch is run over where every edit is a removal or insert: jsdom's per-write cost is linear in the list.
const DOM_EDIT_CHILDREN_MAX = 3_000;
const dom = new JSDOM('<!doctype html><body></body>');
global.document = dom.window.document;
const morph = loadMorphModules();

const childCount = () => Math.max(2_000, Math.floor((scaleMegabytes() / 24) * 100_000));

function listOf(ids) {
  const parent = dom.window.document.createElement('div');
  for (const id of ids) {
    const item = dom.window.document.createElement('i');
    item.id = id;
    item.textContent = id;
    parent.append(item);
  }
  return parent;
}

// By sibling links, never `.children`: jsdom keeps every live HTMLCollection up to date on each
// mutation, which turns a patch of n writes into n² work in the test's own DOM (a browser does not).
function elementsOf(parent) {
  const elements = [];
  for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
    elements.push(node);
  }
  return elements;
}
const idsOf = (parent) => elementsOf(parent).map((child) => child.id);

async function patched(label, from, to) {
  const live = listOf(from);
  const kept = new Map(elementsOf(live).map((child) => [child.id, child]));
  const previous = listOf(from);
  const next = listOf(to);
  const measured = await measureOperation(`morph-${label}`, `before=${from.length} after=${to.length}`, async () => {
    morph.patchChildren(live, previous, next);
  });
  assert.ok(measured.wallMs < WALL_MS_MAX, `${label}: the patch finishes (${Math.round(measured.wallMs)} ms)`);
  assert.deepEqual(idsOf(live), to, `${label}: the live list is the next rendering, complete and in order`);
  return { live, kept };
}

test('a huge list with a few scattered edits patches in place', async () => {
  const count = childCount();
  const from = Array.from({ length: count }, (_, index) => `n${index}`);
  const to = from.slice();
  to.splice(Math.floor(count / 2), 1, 'edited-middle');
  to.splice(10, 0, 'inserted-near-start');
  to.splice(to.length - 5, 1);
  const { live, kept } = await patched('few-edits', from, to);
  assert.equal(live.firstElementChild, kept.get('n0'), 'the first live node is the same element');
  assert.equal(live.lastElementChild, kept.get(`n${count - 1}`), 'and so is the last');
});

test('a huge list replaced wholesale patches, it does not reload', async () => {
  const count = childCount();
  await patched(
    'replaced',
    Array.from({ length: count }, (_, index) => `old${index}`),
    Array.from({ length: count }, (_, index) => `new${index}`),
  );
});

// The edit script applied to `before` must give `after`, and a keep must pair equal keys.
function applied(before, after, ops) {
  const result = [];
  for (const [kind, i, j] of ops) {
    if (kind === 0) {
      assert.equal(before[i], after[j], 'a keep pairs equal keys');
      result.push(before[i]);
    } else if (kind === 1) {
      result.push(after[j]);
    }
  }
  return result;
}

test('the diff of a huge list with thousands of edits is a valid edit script', async () => {
  const count = childCount();
  const from = Array.from({ length: count }, (_, index) => `n${index}`);
  const to = from.map((id, index) => (index % 9 === 0 ? `changed${index}` : id));
  to.reverse();
  const measured = await measureOperation('morph-diff-many-edits', `before=${from.length} after=${to.length}`, async () => morph.diffChildren(from, to));
  assert.ok(measured.wallMs < WALL_MS_MAX, `the diff finishes (${Math.round(measured.wallMs)} ms)`);
  assert.deepEqual(applied(from, to, measured.value), to, 'the edit script turns the old list into the new one');
});

test('a list with thousands of edits patches', async () => {
  const count = Math.min(childCount(), DOM_EDIT_CHILDREN_MAX);
  const from = Array.from({ length: count }, (_, index) => `n${index}`);
  const to = from.map((id, index) => (index % 9 === 0 ? `changed${index}` : id));
  to.reverse();
  const { live } = await patched('many-edits', from, to);
  assert.equal(idsOf(live).length, to.length);
});

test('a huge list that only grows at the end appends', async () => {
  const count = childCount();
  const from = Array.from({ length: count }, (_, index) => `n${index}`);
  const to = from.concat(Array.from({ length: 1000 }, (_, index) => `tail${index}`));
  const { live, kept } = await patched('append', from, to);
  assert.equal(elementsOf(live)[count - 1], kept.get(`n${count - 1}`), 'the list that was there stays');
});
