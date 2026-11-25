// Goal: normal batching is allowed, but missing acknowledgments cannot leave Saving forever.
// Method: advance a deterministic clock through multiple edits, acknowledgments and disconnects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaveWatch } from '../src/features/collaboration/saveWatch';
import { parseSaveSequence } from '../src/features/collaboration/saveProtocol';

test('new edits do not extend the oldest save deadline', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let expired = 0;
  const watch = new SaveWatch(() => expired++);
  assert.equal(watch.sent(), 1);
  context.mock.timers.tick(2000);
  assert.equal(expired, 0, 'Normal durable batching is not a stuck save');
  context.mock.timers.tick(18_000);
  watch.sent();
  context.mock.timers.tick(5000);
  assert.equal(expired, 1, 'Typing cannot postpone the first missing acknowledgment');
  watch.reset();
});

test('acknowledgments advance the deadline and disconnects cancel it', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let expired = 0;
  const watch = new SaveWatch(() => expired++);
  watch.sent();
  context.mock.timers.tick(10_000);
  watch.sent();
  watch.saved(undefined);
  context.mock.timers.tick(15_000);
  assert.equal(watch.pending, 1);
  assert.equal(expired, 0);
  watch.reset();
  context.mock.timers.tick(25_000);
  assert.equal(watch.pending, 0);
  assert.equal(expired, 0);
  watch.sent();
  watch.saved(undefined);
  context.mock.timers.tick(25_000);
  assert.equal(expired, 0, 'Successful saves leave no reconnect timer');
});

test('pending acknowledgment storage has the same bound as the room queue', () => {
  const watch = new SaveWatch(() => {});
  try {
    for (let index = 0; index < 200; index++) {
      assert.equal(watch.sent(), index + 1);
    }
    assert.equal(watch.sent(), undefined);
    assert.equal(watch.pending, 200);
  } finally {
    watch.reset();
  }
});

test('later acknowledgments cannot disguise an older missing save or acknowledge a new socket', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let expired = 0;
  const watch = new SaveWatch(() => expired++);
  const first = watch.sent();
  context.mock.timers.tick(20_000);
  const second = watch.sent();
  assert.equal(watch.saved(second), true);
  assert.equal(watch.saved(second), false, 'Duplicate acknowledgments do not settle another edit');
  context.mock.timers.tick(5000);
  assert.equal(expired, 1);
  watch.reset();
  const replay = watch.sent();
  assert.equal(watch.saved(first), false, 'A late acknowledgment cannot settle a replay');
  assert.equal(watch.pending, 1);
  assert.equal(watch.saved(replay), true);
  context.mock.timers.tick(25_000);
  assert.equal(expired, 1);
});

test('save sequences accept legacy omission and reject malformed or unbounded network values', () => {
  assert.equal(parseSaveSequence(undefined), undefined);
  assert.equal(parseSaveSequence(1), 1);
  assert.equal(parseSaveSequence(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  for (const input of [null, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}]) {
    assert.throws(() => parseSaveSequence(input), /Invalid save acknowledgment sequence/);
  }
});
