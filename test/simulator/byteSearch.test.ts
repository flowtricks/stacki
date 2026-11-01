// Goal: shared/engine/byteSearch.ts counts the occurrences of a byte string exactly,
// overlapping ones included, stops at its bound, and asserts its preconditions
// — the planner's uniqueness rule (plan §4) is only as sound as this count.
// Method: (1) hand-built cases: absent, once, overlapping, needle longer than
// the haystack, the bound reached and not; (2) seeded random byte strings over
// a two-letter alphabet, where borders and overlaps are the norm and a wrong
// failure table shows at once, checked against a naive quadratic count;
// (3) the preconditions assert with pinned messages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countOccurrences } from '#dist/shared/engine/byteSearch.js';
import { encodeUtf8, toByteString, type ByteString } from '#dist/shared/core/span.js';
import { Prng } from './prng.ts';

const count = (haystack: string, needle: string, countMax = 1_000) => countOccurrences(encodeUtf8(haystack), encodeUtf8(needle), countMax);

function naiveCount(haystack: ByteString, needle: ByteString): number {
  let found = 0;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let offset = 0;
    while (offset < needle.length && haystack[start + offset] === needle[offset]) {
      offset++;
    }
    found += offset === needle.length ? 1 : 0;
  }
  return found;
}

function randomBytes(prng: Prng, length: number): ByteString {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = 0x61 + (prng.nextUint32() % 2); // `a` or `b`
  }
  return toByteString(bytes);
}

test('hand-built counts: absent, once, overlapping, too long', () => {
  assert.equal(count('<Card title="Old" />', 'Footer'), 0);
  assert.equal(count('<Card title="Old" />', 'Card title="Old"'), 1);
  assert.equal(count('<Card title="Old" />\n<Card title="Old" />', 'Card title="Old"'), 2);
  assert.equal(count('aaaaa', 'aa'), 4, 'overlapping occurrences all count');
  assert.equal(count('abababa', 'aba'), 3, 'a border longer than one byte');
  assert.equal(count('ab', 'abc'), 0, 'a needle longer than the haystack');
  assert.equal(count('', 'a'), 0, 'an empty haystack');
  assert.equal(count('é é', 'é'), 2, 'multi-byte characters are byte strings too');
});

test('the count stops at its bound', () => {
  assert.equal(count('aaaaa', 'a', 2), 2);
  assert.equal(count('aaaaa', 'a', 5), 5);
  assert.equal(count('aaaaa', 'a', 6), 5, 'a bound not reached returns the true count');
  assert.equal(count('xyz', 'y', 1), 1);
});

test('seeded random strings: the linear count equals the naive one', () => {
  const prng = new Prng(20260928);
  for (let round = 0; round < 2_000; round++) {
    const haystack = randomBytes(prng, prng.nextUint32() % 64);
    const needle = randomBytes(prng, 1 + (prng.nextUint32() % 6));
    const expected = naiveCount(haystack, needle);
    assert.equal(countOccurrences(haystack, needle, 1_000), expected, `round ${round}`);
    assert.equal(countOccurrences(haystack, needle, 2), Math.min(expected, 2), `round ${round}`);
  }
});

test('preconditions assert with pinned messages', () => {
  assert.throws(() => count('abc', ''), {
    message: 'Assertion failed: Only a non-empty needle is searched for',
  });
  assert.throws(() => count('abc', 'a', 0), {
    message: 'Assertion failed: The count bound is positive',
  });
  assert.throws(() => count('abc', 'a', 1.5), {
    message: 'Assertion failed: The count bound is an integer',
  });
});
