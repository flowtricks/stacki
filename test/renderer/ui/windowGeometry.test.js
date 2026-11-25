// Goal: floating tools stay reachable at every edge and after viewport changes.
// Method: exercise all eight resize handles, opposite-edge anchoring, tiny viewports
// and invalid geometry inputs against the shared pure geometry functions.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('../../helpers/rendererModule');
const { WINDOW_EDGES, initialWindowRectangle, fitWindowRectangle, resizeWindowRectangle } = load('src/ui/windowGeometry.ts');

const viewport = { width: 1440, height: 900 };
const minimum = { width: 340, height: 220 };
const start = { x: 300, y: 180, width: 600, height: 420 };
function inside(rectangle, size, min = minimum) {
  assert.ok(rectangle.x >= 0);
  assert.ok(rectangle.y >= 0);
  assert.ok(rectangle.x + rectangle.width <= size.width);
  assert.ok(rectangle.y + rectangle.height <= size.height);
  assert.ok(rectangle.width >= Math.min(min.width, size.width - 16));
  assert.ok(rectangle.height > 0);
}

test('every handle enforces bounds and keeps its opposite edge fixed', () => {
  for (const edge of WINDOW_EDGES) {
    for (const delta of [-10000, -100, 0, 100, 10000]) {
      const result = resizeWindowRectangle(start, edge, { x: delta, y: delta }, viewport, minimum);
      inside(result, viewport);
      if (edge.includes('w')) {
        assert.equal(result.x + result.width, start.x + start.width);
      } else {
        assert.equal(result.x, start.x);
      }
      if (edge.includes('n')) {
        assert.equal(result.y + result.height, start.y + start.height);
      } else {
        assert.equal(result.y, start.y);
      }
    }
  }
});

test('initial placement and viewport shrink keep the complete window reachable', () => {
  const centered = initialWindowRectangle(viewport, minimum);
  assert.ok(Math.abs(centered.x * 2 + centered.width - viewport.width) <= 1);
  assert.ok(Math.abs(centered.y * 2 + centered.height - viewport.height) <= 1);
  for (const size of [viewport, { width: 620, height: 400 }, { width: 220, height: 160 }]) {
    inside(initialWindowRectangle(size, minimum), size);
    inside(fitWindowRectangle({ ...start, x: 3000, y: -1000 }, size, minimum), size);
  }
  assert.throws(() => fitWindowRectangle(start, { width: 0, height: 900 }, minimum), /positive/);
  assert.throws(() => fitWindowRectangle(start, { width: Infinity, height: 900 }, minimum), /finite/);
  assert.throws(() => resizeWindowRectangle(start, 'se', { x: NaN, y: 0 }, viewport, minimum), /finite/);
});
