// Goal: the connected-CMS panel shows what it last read at once and refreshes behind it — a
// failed refresh never blanks a view that has something to show, reads of one subject share a
// request, and each cache keeps no more than its bound.
// Method: a cache is driven with reads whose answers the test controls, counting the requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { createRemoteCache } = loadRenderer('src/features/cms/remoteCmsCache.ts');

const ok = (value) => ({ ok: true, value });

test('a kept value is shown while a refresh replaces it', async () => {
  const cache = createRemoteCache(4);
  assert.equal(cache.get('a'), undefined, 'nothing to show before the first read');
  await cache.load('a', async () => ok(1));
  assert.deepEqual(cache.get('a'), ok(1));
  const refresh = cache.load('a', async () => ok(2));
  assert.deepEqual(cache.get('a'), ok(1), 'the old value shows until the answer comes');
  assert.deepEqual(await refresh, ok(2));
  assert.deepEqual(cache.get('a'), ok(2));
});

test('a failed refresh keeps the last good value; a first failure is shown', async () => {
  const cache = createRemoteCache(4);
  await cache.load('a', async () => ok('kept'));
  assert.deepEqual(
    await cache.load('a', async () => ({ ok: false, message: 'offline' })),
    ok('kept'),
  );
  const first = await cache.load('b', async () => {
    throw new Error('offline');
  });
  assert.equal(first.ok, false);
  assert.match(first.message, /offline/);
});

test('reads of one key share a request; prefetch reads only what is not kept', async () => {
  const cache = createRemoteCache(4);
  let requests = 0;
  const read = async () => ok((requests += 1));
  await Promise.all([cache.load('a', read), cache.load('a', read)]);
  assert.equal(requests, 1);
  cache.prefetch('a', read);
  cache.prefetch('b', read);
  await cache.load('b', read);
  assert.equal(requests, 2, 'a was kept, and b was already in flight');
});

test('the cache keeps its most recently used entries, up to its bound', () => {
  const cache = createRemoteCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 3);
  cache.set('c', 4);
  assert.equal(cache.get('b'), undefined, 'the least recently set entry goes');
  assert.deepEqual([cache.get('a'), cache.get('c')], [ok(3), ok(4)]);
  assert.throws(() => createRemoteCache(0), /at least one entry/);
});

test('offline, no request is made: a kept value stays, nothing kept says offline', async () => {
  const cache = createRemoteCache(4);
  await cache.load('a', async () => ok('kept'));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  try {
    let requests = 0;
    const read = async () => ok((requests += 1));
    assert.deepEqual(await cache.load('a', read), ok('kept'));
    const missing = await cache.load('b', read);
    assert.equal(missing.ok, false);
    assert.match(missing.message, /offline/);
    cache.prefetch('c', read);
    assert.equal(requests, 0, 'nothing touches the network while offline');
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, 'navigator', previous);
    } else {
      delete globalThis.navigator;
    }
  }
});
