// Goal: the tile state machine never takes a picture away, the queue renders the visible tile first within
// its concurrency, and the LRU stays inside its byte budget.
// Method: walk every state with every event (including the late and impossible ones), then drive the queue
// and the cache with small scripted sequences.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTileState, readPageReason, tileView, TILE_IDLE, type TileEvent, type TileState } from '#dist/shared/properties/previewTile.js';
import {
  cancel,
  cancelAll,
  EMPTY_PREVIEW_QUEUE,
  enqueue,
  finish,
  PREVIEW_QUEUE_LIMITS,
  reprioritize,
  startNext,
} from '#dist/shared/properties/previewQueue.js';
import { ByteLru, evictionOrder } from '#dist/shared/properties/previewLru.js';

const ready: TileState = { kind: 'ready', key: 'k', attempt: 'authored', refreshing: false };
const events: readonly TileEvent[] = [
  { kind: 'enqueue' },
  { kind: 'start' },
  { kind: 'rendered', key: 'n', attempt: 'sample' },
  { kind: 'unchanged' },
  { kind: 'failed', reason: { kind: 'timeout' } },
  { kind: 'retry' },
];

test('a ready tile is never idle, queued, rendering or unavailable, whatever happens', () => {
  for (const event of events) {
    const next = nextTileState(ready, event);
    assert.equal(next.kind, 'ready', event.kind);
    assert.equal(tileView(next), 'picture');
  }
  assert.deepEqual(nextTileState(ready, { kind: 'rendered', key: 'n', attempt: 'sample' }), { kind: 'ready', key: 'n', attempt: 'sample', refreshing: false });
  assert.equal(nextTileState(nextTileState(ready, { kind: 'enqueue' }), { kind: 'failed', reason: { kind: 'timeout' } }).kind, 'ready');
});

test('the happy path and the failure path', () => {
  let state = nextTileState(TILE_IDLE, { kind: 'enqueue' });
  assert.equal(tileView(state), 'skeleton');
  state = nextTileState(state, { kind: 'start' });
  assert.equal(state.kind, 'rendering');
  const failed = nextTileState(state, { kind: 'failed', reason: { kind: 'needs-props', names: ['a'] } });
  assert.equal(tileView(failed), 'unavailable');
  assert.equal(nextTileState(failed, { kind: 'enqueue' }), failed);
  assert.equal(nextTileState(failed, { kind: 'retry' }).kind, 'queued');
  assert.equal(nextTileState(TILE_IDLE, { kind: 'rendered', key: 'k', attempt: 'authored' }).kind, 'ready');
  assert.equal(nextTileState(TILE_IDLE, { kind: 'start' }), TILE_IDLE);
  assert.throws(() => nextTileState(TILE_IDLE, { kind: 'failed', reason: { kind: 'needs-props', names: [] } }), /names the props/);
  assert.throws(() => nextTileState(TILE_IDLE, { kind: 'failed', reason: { kind: 'threw', message: '' } }), /carries the message/);
});

test('the page reason becomes a typed reason', () => {
  assert.deepEqual(readPageReason('Preview needs data for: a, b. Open an instance.'), { kind: 'needs-props', names: ['a', 'b'] });
  assert.deepEqual(readPageReason('Threw: boom'), { kind: 'threw', message: 'boom' });
  assert.deepEqual(readPageReason('This is client-only'), { kind: 'client-only' });
  assert.deepEqual(readPageReason('The component rendered nothing.'), { kind: 'rendered-nothing' });
});

test('the queue renders visible first, within the concurrency, and cancels', () => {
  let queue = EMPTY_PREVIEW_QUEUE;
  queue = enqueue(queue, { id: 'c', priority: 'background', order: 0 });
  queue = enqueue(queue, { id: 'b', priority: 'visible', order: 2 });
  queue = enqueue(queue, { id: 'a', priority: 'visible', order: 1 });
  queue = enqueue(queue, { id: 'd', priority: 'near', order: 3 });
  const first = startNext(queue, 3);
  assert.deepEqual(
    first.started.map((entry) => entry.id),
    ['a', 'b', 'd'],
  );
  assert.deepEqual(startNext(first.queue, 3).started, []);
  const freed = startNext(finish(first.queue, 'a'), 3);
  assert.deepEqual(
    freed.started.map((entry) => entry.id),
    ['c'],
  );
  assert.equal(enqueue(first.queue, { id: 'a', priority: 'visible', order: 0 }), first.queue);
  assert.equal(cancel(queue, 'zzz'), queue);
  assert.equal(cancel(queue, 'c').waiting.length, 3);
  assert.equal(cancelAll(queue).waiting.length, 0);
  const moved = reprioritize(queue, new Map([['c', 'visible' as const]]));
  assert.equal(moved.waiting[0]?.id, 'c');
  assert.throws(() => startNext(queue, 0), /at least one/);
  assert.throws(() => startNext(queue, PREVIEW_QUEUE_LIMITS.concurrencyMax + 1), /concurrency bound/);
});

test('the queue is bounded', () => {
  let queue = EMPTY_PREVIEW_QUEUE;
  for (let index = 0; index < PREVIEW_QUEUE_LIMITS.queuedMax + 5; index += 1) {
    queue = enqueue(queue, { id: `t${index}`, priority: 'background', order: index });
  }
  assert.equal(queue.waiting.length, PREVIEW_QUEUE_LIMITS.queuedMax);
});

test('the cache evicts the least recently used and refuses an entry bigger than its budget', () => {
  const cache = new ByteLru<string>(10);
  assert.equal(cache.set('a', 'A', 4), true);
  assert.equal(cache.set('b', 'B', 4), true);
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.set('c', 'C', 4), true);
  assert.deepEqual(cache.keys(), ['a', 'c']);
  assert.equal(cache.bytes, 8);
  assert.equal(cache.set('big', 'X', 11), false);
  assert.equal(cache.peek('a'), 'A');
  cache.delete('a');
  assert.equal(cache.bytes, 4);
  assert.deepEqual(
    evictionOrder(
      [
        { id: 'x', bytes: 6, usedAtMs: 2 },
        { id: 'y', bytes: 6, usedAtMs: 1 },
        { id: 'z', bytes: 99, usedAtMs: 3 },
      ],
      10,
    ),
    ['z', 'y'],
  );
  assert.throws(() => new ByteLru(0), /positive/);
});
