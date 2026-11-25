// Goal: parallel catalog reads have bounded concurrency and deterministic ordering.
// Method: vary completion order, count live operations and inject a failure before
// the next batch; no disk timings or production-sized fixtures are needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { batchedRead } from '../src/shared/batchedRead';

test('catalog reads retain order while limiting concurrent filesystem work', async () => {
  let active = 0;
  let peak = 0;
  const values = Array.from({ length: 25 }, (_, index) => index);
  const results = await batchedRead(values, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await setTimeout(value % 3);
    active--;
    return value * 2;
  });
  assert.deepEqual(
    results,
    values.map((value) => value * 2),
  );
  assert.equal(active, 0);
  assert.ok(peak > 1, 'Independent file waits overlap');
  assert.ok(peak <= 8, 'The filesystem never receives more than eight simultaneous reads');
});

test('a failed read prevents later batches and preserves the failure', async () => {
  const started: number[] = [];
  await assert.rejects(
    batchedRead(
      Array.from({ length: 20 }, (_, index) => index),
      async (value) => {
        started.push(value);
        if (value === 0) {
          throw new Error('Disk unavailable');
        }
        return value;
      },
    ),
    /Disk unavailable/,
  );
  assert.ok(started.every((value) => value < 8));
  assert.deepEqual(await batchedRead([], async () => 1), []);
});
