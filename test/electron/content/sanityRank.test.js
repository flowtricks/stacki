// Goal: a dragged item's new order rank sorts, as a plain string, exactly between its new
// neighbours — the way Sanity's orderable-document-list plugin sorts them — and nothing else
// needs renumbering. Method: real ranks in the plugin's format (`0|i00007:`), the ends of a list,
// a run of repeated inserts into one gap, and malformed input.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankBetween, isRank } = require('#dist/electron/content/sanityRank.js');

const between = (after, before) => {
  const rank = rankBetween(after, before);
  assert.ok(isRank(rank), rank);
  if (after !== undefined) {
    assert.ok(after < rank, `${after} < ${rank}`);
  }
  if (before !== undefined) {
    assert.ok(rank < before, `${rank} < ${before}`);
  }
  return rank;
};

test('a rank between two of the plugin’s sorts between them as a string', () => {
  between('0|i00007:', '0|i0000f:');
  between('0|i00007:', '0|i00008:');
  between('0|i00007:', '0|i00007:i');
  assert.match(between('0|i00007:', '0|i0000f:'), /^0\|i0000[89a-e]:$/);
});

test('either end of the list, and an empty list', () => {
  between(undefined, '0|i00007:');
  between('0|i00007:', undefined);
  assert.ok(isRank(rankBetween(undefined, undefined)));
});

test('repeated inserts into one gap stay ordered', () => {
  let high = '0|i00008:';
  const low = '0|i00007:';
  for (let count = 0; count < 40; count++) {
    high = between(low, high);
  }
});

test('ranks keep their bucket; malformed or reversed neighbours are refused', () => {
  assert.match(rankBetween('1|i00007:', '1|i00009:'), /^1\|/);
  assert.throws(() => rankBetween('not a rank', undefined), /Not an order rank/);
  assert.throws(() => rankBetween('0|i00009:', '0|i00007:'), /after the earlier neighbour/);
  assert.equal(isRank('0|i00007:'), true);
  assert.equal(isRank('0|I00007:'), false);
});
