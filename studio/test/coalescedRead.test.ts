// Goal: collaborators share catalog work without receiving a scan older than
// their request. Method: hold the read boundary, change its source revision,
// and exercise queued reads, failures and later uncached reads deterministically.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoalescedRead } from '../src/shared/coalescedRead';

function deferred<T>() {
  let resolve: (value: T) => void = () => assert.fail('Promise has not initialized');
  let reject: (error: Error) => void = () => assert.fail('Promise has not initialized');
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

test('overlapping editors share one read; changes queue one fresh revision', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const reads = [first, second];
  let calls = 0;
  const catalog = new CoalescedRead(() => {
    const read = reads[calls++];
    assert.ok(read, 'The workload needs at most two reads');
    return read.promise;
  });
  const original = catalog.read();
  for (let index = 0; index < 30; index++) {
    assert.equal(catalog.read(), original);
  }
  await Promise.resolve();
  assert.equal(calls, 1);
  catalog.invalidate();
  const fresh = catalog.read();
  assert.notEqual(fresh, original);
  for (let index = 0; index < 30; index++) {
    catalog.invalidate();
    assert.equal(catalog.read(), fresh);
  }
  assert.equal(calls, 1, 'Invalidation does not run concurrent filesystem scans');
  first.resolve('before');
  assert.equal(await original, 'before');
  second.resolve('after');
  assert.equal(await fresh, 'after');
  assert.equal(calls, 2, 'The queued scan includes all intervening changes');
});

test('finished values are not cached across later requests', async () => {
  let source = 'before';
  let calls = 0;
  const catalog = new CoalescedRead(async () => {
    calls++;
    return source;
  });
  assert.equal(await catalog.read(), 'before');
  source = 'outside edit';
  assert.equal(await catalog.read(), source);
  assert.equal(calls, 2, 'A missed watcher notification cannot create a persistent stale cache');
});

test('failed reads release their slot without rejecting a queued fresh read', async () => {
  const failure = deferred<string>();
  let calls = 0;
  const catalog = new CoalescedRead(() => {
    calls++;
    return calls === 1 ? failure.promise : Promise.resolve('recovered');
  });
  const original = catalog.read();
  const rejected = assert.rejects(original, /Disk unavailable/);
  catalog.invalidate();
  const fresh = catalog.read();
  failure.reject(new Error('Disk unavailable'));
  await rejected;
  assert.equal(await fresh, 'recovered');
  assert.equal(await catalog.read(), 'recovered');
  assert.equal(calls, 3);
});

test('synchronous read failures use the same cleanup and retry boundary', async () => {
  let calls = 0;
  const catalog = new CoalescedRead(() => {
    if (calls++ === 0) {
      throw new Error('Cannot start read');
    }
    return Promise.resolve('recovered');
  });
  await assert.rejects(catalog.read(), /Cannot start read/);
  assert.equal(await catalog.read(), 'recovered');
});
