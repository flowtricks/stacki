// Goal: the width rules behind "the style panel follows the canvas width" are exact. Which
// query holds at a width (every width form, rem and px, the boundary pixel itself), which of
// several holding queries wins (the cascade's most specific, mobile first and desktop first),
// and that anything that is not a measurable width is never auto-selected.
// Method: the pure models (queryWidthMatch, followedContextKey) over tables of
// cases, including the negative space (non-width queries, containers, em, `or`, oversize text,
// no query at all, a width exactly on a boundary). No DOM, no timing.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { queryWidthMatch } = loadRenderer('src/features/style/model/queryWidth.ts');
const { followedContextKey, FOLLOW_CONTEXTS_MAX } = loadRenderer('src/features/style/model/followWidth.ts');

const ROOT = 16;
const holds = (query, width) => queryWidthMatch(query, width, ROOT).kind === 'match';

test('every width form holds exactly where it should, boundary pixel included', () => {
  const table = [
    ['@media (width >= 30rem)', 480, true],
    ['@media (width >= 30rem)', 479, false],
    ['@media (width > 30rem)', 480, false],
    ['@media (width > 30rem)', 481, true],
    ['@media (min-width: 768px)', 768, true],
    ['@media (min-width: 768px)', 767, false],
    ['@media (width <= 767px)', 767, true],
    ['@media (width <= 767px)', 768, false],
    ['@media (width < 48rem)', 767, true],
    ['@media (width < 48rem)', 768, false],
    ['@media (max-width: 991px)', 991, true],
    ['@media (max-width: 991px)', 992, false],
    ['@media (30rem <= width < 48rem)', 480, true],
    ['@media (30rem <= width < 48rem)', 767, true],
    ['@media (30rem <= width < 48rem)', 768, false],
    ['@media (30rem <= width < 48rem)', 479, false],
    ['@media (48rem > width)', 700, true],
    ['@media (48rem < width)', 769, true],
    ['@media (min-width: 30rem) and (max-width: 47.9375rem)', 600, true],
    ['@media (min-width: 30rem) and (max-width: 47.9375rem)', 768, false],
    ['@media screen and (width >= 30rem)', 500, true],
    ['@media only screen and (min-width: 480px)', 480, true],
    ['@media (width >= 30.5rem)', 487, false],
    ['@media (width >= 30.5rem)', 488, true],
  ];
  for (const [query, width, expected] of table) {
    assert.equal(holds(query, width), expected, `${query} at ${width}px`);
  }
});

test('the interval of a match is reported by side', () => {
  assert.deepEqual(queryWidthMatch('@media (width >= 30rem)', 600, ROOT), { kind: 'match', lowerPx: 480, upperPx: Infinity });
  assert.deepEqual(queryWidthMatch('@media (max-width: 767px)', 600, ROOT), { kind: 'match', lowerPx: 0, upperPx: 767 });
  assert.deepEqual(queryWidthMatch('@media (30rem <= width < 48rem)', 600, ROOT), { kind: 'match', lowerPx: 480, upperPx: 768 });
});

test('what is not a measurable width is ignored, never a guess', () => {
  const ignored = [
    '@media (prefers-reduced-motion: reduce)',
    '@media print',
    '@media (hover: hover)',
    '@media (width >= 30rem) and (hover: hover)',
    '@container card (width > 20rem)',
    '@media (width >= 30rem) › @container card (width > 20rem)',
    '@supports (display: grid)',
    '@media (min-width: 30em)',
    '@media (width >= 30rem), print',
    '@media (width >= 30rem) or (width < 10rem)',
    `@media (width >= ${'9'.repeat(600)}rem)`,
    '',
  ];
  for (const query of ignored) {
    assert.equal(queryWidthMatch(query, 600, ROOT).kind, 'ignored', query.slice(0, 60));
  }
});

const rows = (...queries) => queries.map(([key, embedAtContext]) => ({ key, embedAtContext }));
const MOBILE_FIRST = rows(['a', '@media (width >= 30rem)'], ['b', '@media (width >= 48rem)'], ['c', '@media (width >= 64rem)']);
const DESKTOP_FIRST = rows(['x', '@media (max-width: 991px)'], ['y', '@media (max-width: 767px)'], ['z', '@media (max-width: 479px)']);

test('mobile first: the largest holding minimum wins, below the smallest it is Base', () => {
  const at = (width) => followedContextKey([{ key: '', embedAtContext: '' }, ...MOBILE_FIRST], width, ROOT);
  assert.equal(at(300), '');
  assert.equal(at(479), '');
  assert.equal(at(480), 'a');
  assert.equal(at(767), 'a');
  assert.equal(at(768), 'b');
  assert.equal(at(1023), 'b');
  assert.equal(at(1024), 'c');
  assert.equal(at(7000), 'c');
});

test('desktop first: the smallest holding maximum wins, above the largest it is Base', () => {
  const at = (width) => followedContextKey(DESKTOP_FIRST, width, ROOT);
  assert.equal(at(320), 'z');
  assert.equal(at(479), 'z');
  assert.equal(at(480), 'y');
  assert.equal(at(767), 'y');
  assert.equal(at(768), 'x');
  assert.equal(at(991), 'x');
  assert.equal(at(992), '');
});

test('ranges, nested ranges, ties and the order they are listed in', () => {
  const nested = rows(['wide', '@media (width >= 30rem)'], ['band', '@media (30rem <= width < 48rem)'], ['narrow', '@media (36rem <= width < 40rem)']);
  assert.equal(followedContextKey(nested, 600, ROOT), 'narrow', 'the tightest interval holds the cascade');
  assert.equal(followedContextKey(nested, 500, ROOT), 'band');
  assert.equal(followedContextKey(nested, 900, ROOT), 'wide');
  const twins = rows(['first', '@media (width >= 30rem)'], ['second', '@media (min-width: 480px)']);
  assert.equal(followedContextKey(twins, 600, ROOT), 'first', 'equal queries keep the first listed');
  assert.equal(followedContextKey([...twins].reverse(), 600, ROOT), 'second');
  const mixed = rows(['up', '@media (width >= 48rem)'], ['down', '@media (max-width: 991px)']);
  assert.equal(followedContextKey(mixed, 800, ROOT), 'down', 'a bounded query is more specific than an open one');
});

test('no queries, queries that hold nowhere, and non-width queries are Base', () => {
  assert.equal(followedContextKey([], 800, ROOT), '');
  assert.equal(followedContextKey(rows(['m', '@media (prefers-reduced-motion: reduce)'], ['c', '@container card (width > 20rem)']), 800, ROOT), '');
  assert.equal(followedContextKey(rows(['q', '@media (width >= 100rem)']), 800, ROOT), '');
  assert.equal(followedContextKey(rows(['m', '@media (prefers-reduced-motion: reduce)'], ['a', '@media (width >= 30rem)']), 800, ROOT), 'a');
  assert.equal(followedContextKey([{ key: 'bp:tablet' }], 800, ROOT), '', 'a row with no at-rule is not a width query');
});

test('a root font size other than 16 moves the rem boundaries', () => {
  const list = rows(['a', '@media (width >= 30rem)']);
  assert.equal(followedContextKey(list, 479, 16), '');
  assert.equal(followedContextKey(list, 479, 15), 'a');
});

test('the list is bounded', () => {
  const big = Array.from({ length: FOLLOW_CONTEXTS_MAX + 1 }, (_, index) => ({ key: `k${index}`, embedAtContext: '@media (width >= 1px)' }));
  assert.throws(() => followedContextKey(big, 800, ROOT), /bound/);
});
