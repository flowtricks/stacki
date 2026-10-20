// Goal: save batching and idle controls bound hosting use without dropping pending work.
// Method: exercise persistence failures, operation completion, and idle-time boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatchedWriter } from '../src/features/storage/batchedWriter';
import {
  beginOperation,
  hasPendingOperations,
  mayPause,
  onOperationsSettled,
} from '../src/features/session/activity';

test('many edits share one durable snapshot and acknowledge only after storage succeeds', async () => {
  const writes: Uint8Array[] = [];
  let finish: (() => void) | undefined;
  const writer = new BatchedWriter(async (bytes) => {
    writes.push(bytes);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  let saved = 0;
  const first = writer.save(new Uint8Array([1])).then(() => saved++);
  const second = writer.save(new Uint8Array([2])).then(() => saved++);
  const flushing = writer.flush();
  assert.equal(saved, 0);
  assert.deepEqual(writes, [new Uint8Array([2])]);
  assert.ok(finish);
  finish();
  await Promise.all([first, second, flushing]);
  assert.equal(saved, 2);
});

test('a failed batch rejects all saves and a later edit can retry', async () => {
  let fail = true;
  const writer = new BatchedWriter(async () => {
    if (fail) {
      throw new Error('Storage unavailable');
    }
  });
  const first = assert.rejects(writer.save(new Uint8Array([1])), /Storage unavailable/);
  const second = assert.rejects(writer.save(new Uint8Array([2])), /Storage unavailable/);
  await writer.flush();
  await Promise.all([first, second]);
  fail = false;
  await writer.save(new Uint8Array([3]), true);
});

test('an edit arriving during storage is saved separately without an early acknowledgment', async () => {
  let finish: (() => void) | undefined;
  let count = 0;
  const writer = new BatchedWriter(async () => {
    if (++count === 1) {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
  });
  const first = writer.save(new Uint8Array([1]), true);
  let saved = false;
  const second = writer.save(new Uint8Array([2])).then(() => {
    saved = true;
  });
  assert.ok(finish);
  finish();
  await first;
  assert.equal(saved, false);
  await writer.flush();
  await second;
  assert.equal(count, 2);
});

test('idle sessions pause after five minutes, but pending work prevents pause', () => {
  assert.equal(mayPause(0, 299_999, false), false);
  assert.equal(mayPause(0, 300_000, false), true);
  const finish = beginOperation();
  assert.equal(mayPause(0, 600_000, hasPendingOperations()), false);
  finish();
  assert.equal(hasPendingOperations(), false);
});

test('hidden sessions can pause after the last operation without waiting for a browser timer', () => {
  let calls = 0;
  const stop = onOperationsSettled(() => {
    assert.equal(hasPendingOperations(), false);
    calls++;
  });
  const first = beginOperation();
  const second = beginOperation();
  try {
    first();
    assert.equal(calls, 0, 'the remaining save still prevents pause');
    second();
    assert.equal(calls, 1, 'settling the final operation wakes the idle check');
    second();
    assert.equal(calls, 1, 'repeated cleanup does not emit another completion');
    stop();
    beginOperation()();
    assert.equal(calls, 1, 'unmounted sessions no longer receive completions');
  } finally {
    first();
    second();
    stop();
  }
});

test('asset totals reject uploads before durable storage grows past the allowance', async () => {
  const { mkdtemp, mkdir, writeFile, truncate, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveAsset } = await import('../src/features/storage/assetStorage');
  const root = await mkdtemp(join(tmpdir(), 'studio-assets-'));
  try {
    await mkdir(join(root, 'public'));
    await writeFile(join(root, 'public/existing.bin'), '');
    await truncate(join(root, 'public/existing.bin'), 100_000_000);
    await assert.rejects(
      saveAsset(root, 'public/new.png', new Uint8Array([1])),
      /Asset allowance reached/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
