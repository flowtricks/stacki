// Which loop item the data picker reads for the selected canvas copy.
//
//   node test/renderer/editor/loopSelection.test.js
//
// A node in `cards.map((card) => …)` is drawn once per card; selecting the
// copy in the second card must show the second card's values, not the first.
// Checked here: the copy -> item index arithmetic (one loop, nested loops,
// and every case where the counts cannot account for the copy, which must
// answer nothing), and that dataTree follows the selected copy, lets the
// pager's own choice win, and keeps the first item when nothing is known.
// Fixtures are generated in this file; no project is read.

const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { loopIndexesOfCopy, steppedLoopIndex } = load('src/editor/loopSelection.ts');
const { dataTree } = load('src/editor/dataSuggest.ts');

// One loop.
assert.deepEqual(loopIndexesOfCopy({ occurrence: 1, copies: 3 }, [3]), [1]);
assert.deepEqual(loopIndexesOfCopy({ occurrence: 0, copies: undefined }, [3]), [0]);
// No loop: only the one copy exists.
assert.deepEqual(loopIndexesOfCopy({ occurrence: 0, copies: 1 }, []), []);
// Nested: the outer item changes slowest.
assert.deepEqual(loopIndexesOfCopy({ occurrence: 4, copies: 6 }, [2, 3]), [1, 1]);
assert.deepEqual(loopIndexesOfCopy({ occurrence: 5, copies: 6 }, [2, 3]), [1, 2]);
assert.deepEqual(loopIndexesOfCopy({ occurrence: 2, copies: 6 }, [2, 3]), [0, 2]);

// Negative space: nothing is answered rather than a wrong item.
assert.equal(loopIndexesOfCopy({ occurrence: 3, copies: 3 }, [3]), undefined, 'past the last copy');
assert.equal(loopIndexesOfCopy({ occurrence: -1, copies: 3 }, [3]), undefined, 'negative');
assert.equal(loopIndexesOfCopy({ occurrence: 0.5, copies: 3 }, [3]), undefined, 'not an integer');
assert.equal(loopIndexesOfCopy({ occurrence: 1, copies: 2 }, [3]), undefined, 'the canvas drew another number of copies');
assert.equal(loopIndexesOfCopy({ occurrence: 1, copies: 3 }, [undefined]), undefined, 'a loop of unknown size');
assert.equal(loopIndexesOfCopy({ occurrence: 1, copies: 6 }, [2, undefined]), undefined, 'one unknown loop spoils the rest');
assert.equal(loopIndexesOfCopy({ occurrence: 0, copies: 0 }, [0]), undefined, 'an empty list has no copy');
assert.equal(loopIndexesOfCopy({ occurrence: 0, copies: undefined }, [30000]), undefined, 'more copies than a page holds');

// The pager steps from the item shown, wrapping.
assert.equal(steppedLoopIndex(1, 1, 3), 2);
assert.equal(steppedLoopIndex(2, 1, 3), 0);
assert.equal(steppedLoopIndex(0, -1, 3), 2);
assert.throws(() => steppedLoopIndex(0, 1, 0), /a loop has an item/);

// The tree follows the selected copy.
const frontmatter = 'const { platformIntro, groups } = Astro.props;';
const propsSample = {
  platformIntro: { cards: [{ title: 'Build together' }, { title: 'Publish at scale' }, { title: 'Ship' }] },
  groups: [{ links: [{ n: 'a' }, { n: 'b' }] }, { links: [{ n: 'c' }, { n: 'd' }] }],
};
const heads = ['platformIntro.cards.map((card) => ('];
const itemOf = (extra) => dataTree({ frontmatter, imports: [], propsSample, ancestorHeads: heads, ...extra }).find((node) => node.path === 'card');

assert.equal(itemOf({}).nav.index, 0, 'no selection: the first item');
const second = itemOf({ selectedCopy: { occurrence: 1, copies: 3 } });
assert.equal(second.nav.index, 1, 'the second card is selected');
assert.equal(second.children.find((node) => node.key === 'title').preview, '"Publish at scale"');
assert.equal(itemOf({ selectedCopy: { occurrence: 1, copies: 2 } }).nav.index, 0, 'copies disagree: the first item');
assert.equal(itemOf({ selectedCopy: { occurrence: 5, copies: undefined } }).nav.index, 0, 'past the list: the first item');
assert.equal(itemOf({ selectedCopy: { occurrence: 1, copies: 3 }, itemIndex: { card: 2 } }).nav.index, 2, 'the pager wins');

// Nested loops: the inner list is a field of the outer item.
const inner = dataTree({
  frontmatter,
  imports: [],
  propsSample,
  ancestorHeads: ['groups.map((group) => (', 'group.links.map((link) => ('],
  selectedCopy: { occurrence: 3, copies: 4 },
});
assert.equal(inner.find((node) => node.path === 'group').nav.index, 1);
assert.equal(inner.find((node) => node.path === 'link').nav.index, 1);
const unreadable = dataTree({
  frontmatter,
  imports: [],
  propsSample,
  ancestorHeads: ['getGroups().map((group) => (', 'group.links.map((link) => ('],
  selectedCopy: { occurrence: 3, copies: 4 },
});
assert.equal(unreadable.find((node) => node.path === 'link')?.nav?.index ?? 0, 0, 'an unreadable outer loop: nothing guessed');

// The passes the preview marks outrank the copy's place, and the pager outranks both.
const marked = (extra) => itemOf({ selectedCopy: { occurrence: 0, copies: 1 }, ...extra });
assert.equal(marked({ selectedItems: [2] }).nav.index, 2, 'the marked pass beats the copy place: one copy of three is not item 1');
assert.equal(marked({ selectedItems: [2], itemIndex: { card: 0 } }).nav.index, 0, 'the pager wins');
assert.equal(marked({ selectedItems: [undefined] }).nav.index, 0, 'a pass the render could not place is item 1');
assert.equal(marked({ selectedItems: [9] }).nav.index, 2, 'a place past the list reads as the last item');
assert.equal(marked({ selectedItems: [1, 1] }).nav.index, 0, 'passes that do not match the loops are ignored');
const nestedMarked = dataTree({
  frontmatter,
  imports: [],
  propsSample,
  ancestorHeads: ['groups.map((group) => (', 'group.links.map((link) => ('],
  selectedItems: [1, 0],
});
assert.deepEqual([nestedMarked.find((node) => node.path === 'group').nav.index, nestedMarked.find((node) => node.path === 'link').nav.index], [1, 0]);
const { loopSelectionOf } = load('src/editor/loopSelection.ts');
const ids = ['m1', 'm2'];
const pathFor = (id) => ({ m1: '0.0', m2: '0.0.1' })[id];
const clicked = {
  nodeId: 'n',
  occurrence: 0,
  copies: 1,
  iterations: [
    { path: '0.0', index: 2 },
    { path: '0.0.1', index: -1 },
  ],
};
assert.deepEqual(loopSelectionOf({ selectedId: 'n', clicked, loopIds: ids, pathFor }).items, [2, undefined], 'by the loop path; -1 is unknown');
assert.equal(loopSelectionOf({ selectedId: 'other', clicked, loopIds: ids, pathFor }).items, undefined, 'a click about another node names nothing');
assert.equal(
  loopSelectionOf({ selectedId: 'n', clicked: { ...clicked, iterations: undefined }, loopIds: ids, pathFor }).items,
  undefined,
  'a page that marks none',
);
assert.notEqual(
  loopSelectionOf({ selectedId: 'n', clicked, loopIds: ids, pathFor }).key,
  loopSelectionOf({ selectedId: 'n', clicked: { ...clicked, iterations: [{ path: '0.0', index: 1 }] }, loopIds: ids, pathFor }).key,
  'another pass is a new selection',
);

console.log('loopSelection ok');
