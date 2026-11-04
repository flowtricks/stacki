// Goal: the Loop element is found by what a builder calls it. Someone coming
// from Webflow searches "collection list" or "cms" and found nothing. Method:
// the palette's own Loop entry ranked by the palette's own ranking, for those
// words and for its name, and the List element still leading a search for "list".
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { OTHER_ITEMS } = load('src/features/palette/InsertSearch.tsx');
const { rankInsertItems } = load('src/features/palette/insertRank.ts');

const loop = OTHER_ITEMS.find((item) => item.type === 'map');
assert.ok(loop, 'the palette offers a Loop');
const list = { type: 'tag', tag: 'ul', label: 'List', cat: 'elements' };
for (const query of ['cms', 'collection list', 'collection', 'loop', 'repeat']) {
  assert.deepEqual(
    rankInsertItems([loop, list], query).map((item) => item.label),
    ['Loop'],
    query,
  );
}
assert.equal(rankInsertItems([loop, list], 'list')[0]?.label, 'List', 'the List element still leads "list"');
console.log('loop search: ok');
