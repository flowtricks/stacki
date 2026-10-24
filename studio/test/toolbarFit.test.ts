// Goal: keep important controls reachable without wasting available toolbar space.
// Method: exercise exact-fit, overflow reservation, priority, and invalid measurements.
import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarOverflow } from '../vendor/stacki/src/features/preview/toolbarFit';

const items = [
  { id: 'sizing', width: 160, priority: 20 },
  { id: 'guide', width: 32, priority: 30 },
  { id: 'device', width: 36, priority: 90 },
  { id: 'settings', width: 64, priority: 100 },
  { id: 'style', width: 48, priority: 100 },
] as const;

test('all controls remain visible when they fit, including the exact boundary', () => {
  assert.deepEqual(toolbarOverflow(items, 356, 36, 4), []);
  assert.deepEqual(toolbarOverflow(items, 900, 36, 4), []);
  assert.deepEqual(toolbarOverflow([], 0, 36, 4), []);
});

test('overflow reserves its own button and prioritizes inspector and selected device', () => {
  assert.deepEqual(toolbarOverflow(items, 200, 36, 4), ['sizing', 'guide']);
  assert.deepEqual(toolbarOverflow(items, 160, 36, 4), ['sizing', 'guide', 'device']);
  assert.deepEqual(
    toolbarOverflow(items, 32, 36, 4),
    items.map((item) => item.id),
  );
});

test('smaller secondary actions fill remaining space instead of leaving a gap', () => {
  assert.deepEqual(toolbarOverflow(items, 235, 36, 4), ['sizing']);
  assert.deepEqual(toolbarOverflow(items, 355, 36, 4), ['sizing']);
});

test('invalid and unbounded measurements fail loudly', () => {
  assert.throws(() => toolbarOverflow(items, NaN, 36, 4), /width must be finite/);
  assert.throws(() => toolbarOverflow(items, 300, Infinity, 4), /overflow button width/);
  assert.throws(() => toolbarOverflow(items, 300, 36, -1), /toolbar gap/);
  assert.throws(() => toolbarOverflow([...items, items[0]], 300, 36, 4), /Duplicate/);
  assert.throws(
    () => toolbarOverflow([{ id: 'bad', width: NaN, priority: 1 }], 300, 36, 4),
    /action width/,
  );
  assert.throws(
    () => toolbarOverflow([{ id: 'bad', width: 40, priority: NaN }], 300, 36, 4),
    /action priority/,
  );
  assert.throws(
    () =>
      toolbarOverflow(
        Array.from({ length: 17 }, (_, index) => ({
          id: String(index),
          width: 1,
          priority: 1,
        })),
        300,
        36,
        4,
      ),
    /action limit/,
  );
});
