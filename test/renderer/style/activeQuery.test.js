// Goal: moving the selection to another element keeps the style panel's query only where the new
// element offers it (model/activeQuery.ts). The regression: select an element inside a mobile-first
// component (`.grid` at `>= 64rem`), then one outside it with no queries, and the panel stayed on the
// stale `>= 64rem` instead of returning to Base.
//   - positive space: Base stays Base; a query the new element also lists stays (same component, a
//     shared query, a sourced key);
//   - negative space: an element with no queries, a query removed from the list, a stale or empty-string
//     alias key, a followed row the element does not list: all end on Base;
//   - following: a stale query gives way to the row that holds at the canvas when that row is listed.
// Multiple selection has no case: the panel edits one element, and the selection key is that element's.
// Method: the pure function over plain data, loaded through the app's bundler. No React, no timing.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { resolveActiveQuery, ACTIVE_QUERY_AVAILABLE_MAX } = loadRenderer('src/features/style/model/activeQuery.ts');

const GRID_QUERY = '@media (width >= 64rem)';
const resolve = (previous, available, followedKey) => resolveActiveQuery({ previous, available, followedKey });

test('Base stays Base whatever the element offers', () => {
  assert.equal(resolve('', [], undefined), '');
  assert.equal(resolve('', [GRID_QUERY], GRID_QUERY), '');
});

test('a query the new element also offers is kept', () => {
  assert.equal(resolve(GRID_QUERY, [GRID_QUERY, '@media (width < 48rem)'], undefined), GRID_QUERY);
  assert.equal(resolve('Grid.astro::q', ['Grid.astro::q'], undefined), 'Grid.astro::q');
});

test('the regression: an element outside the component has no queries, so the panel returns to Base', () => {
  assert.equal(resolve(GRID_QUERY, [], undefined), '');
  assert.equal(resolve(GRID_QUERY, [], GRID_QUERY), '');
});

test('a query that was removed from the list, or never listed, falls to Base', () => {
  assert.equal(resolve(GRID_QUERY, ['@media (width < 48rem)'], undefined), '');
  assert.equal(resolve('bp:deleted', ['bp:tablet'], undefined), '');
});

test('a different component with a different query set does not inherit the old query', () => {
  assert.equal(resolve(GRID_QUERY, ['@media (prefers-reduced-motion)'], undefined), '');
});

test('while following, a stale query gives way to the row that holds at the canvas when it is listed', () => {
  assert.equal(resolve(GRID_QUERY, ['@media (width >= 48rem)'], '@media (width >= 48rem)'), '@media (width >= 48rem)');
});

test('a followed row the element does not list, or Base, is Base', () => {
  assert.equal(resolve(GRID_QUERY, [], '@media (width >= 48rem)'), '');
  assert.equal(resolve(GRID_QUERY, ['@media (width >= 48rem)'], ''), '');
});

test('the available list is bounded', () => {
  const tooMany = Array.from({ length: ACTIVE_QUERY_AVAILABLE_MAX + 1 }, (_, index) => `q${index}`);
  assert.throws(() => resolve('q0', tooMany, undefined), /within its bound/);
});
