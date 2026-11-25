// Goal: the List view's pixel sizes are read lazily, a few at a time, once per file version, and a
// failing read never breaks the panel. Methodology: drive the real cache (assetDimensionCache.ts)
// with a scripted reader whose answers the test releases one by one, and count what it was asked:
// nothing before a request, at most DIMENSION_READS_MAX at once, nothing again for a known file,
// a new read when the modified time or size changes, the queue bounded with its oldest request
// dropped, an error or a throw recorded as "none", and a size learned from a video kept as known.
const test = require('node:test');
const assert = require('node:assert/strict');
const cacheModule = require('../../helpers/rendererModule')('src/features/assets/assetDimensionCache.ts');

function scriptedReader() {
  const calls = [];
  const read = (rel) =>
    new Promise((resolve, reject) => {
      calls.push({ rel, resolve, reject });
    });
  return { calls, read };
}

// Lets the cache's promise chain and its queued drain run, without a timer.
async function settle() {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

test('nothing is read until a row asks, and an answer is kept per file version', async () => {
  const reader = scriptedReader();
  const cache = cacheModule.createDimensionCache(reader.read);
  const hero = { rel: 'public/hero.png', size: 7500, modifiedMs: 100 };
  assert.equal(reader.calls.length, 0);
  assert.equal(cache.get(hero), undefined);
  cache.request(hero);
  cache.request(hero);
  assert.equal(reader.calls.length, 1, 'a repeated request is one read');
  reader.calls[0].resolve({ ok: true, value: { widthPx: 1920, heightPx: 1080 } });
  await settle();
  assert.deepEqual(cache.get(hero), { kind: 'known', size: { widthPx: 1920, heightPx: 1080 } });
  cache.request(hero);
  assert.equal(reader.calls.length, 1, 'a known file is never read again');
  cache.request({ ...hero, modifiedMs: 200 });
  assert.equal(reader.calls.length, 2, 'an edited file is read again');
  cache.request({ ...hero, modifiedMs: 200, size: 9000 });
  assert.equal(reader.calls.length, 3, 'a resized file is read again');
});

test('reads run a few at a time, newest request first, and the queue stays bounded', async () => {
  const reader = scriptedReader();
  const cache = cacheModule.createDimensionCache(reader.read);
  const total = cacheModule.DIMENSION_READS_MAX + cacheModule.DIMENSION_QUEUE_MAX + 10;
  for (let index = 0; index < total; index += 1) {
    cache.request({ rel: `public/${index}.png`, size: 1 });
  }
  assert.equal(reader.calls.length, cacheModule.DIMENSION_READS_MAX, 'only the bound is in flight');
  assert.equal(cache.stats().waiting, cacheModule.DIMENSION_QUEUE_MAX, 'the queue keeps its bound');
  reader.calls[0].resolve({ ok: true, value: undefined });
  await settle();
  assert.equal(reader.calls.length, cacheModule.DIMENSION_READS_MAX + 1, 'a finished read starts the next');
  assert.equal(reader.calls.at(-1).rel, `public/${total - 1}.png`, 'the newest request goes first');
  assert.equal(cache.get({ rel: 'public/4.png', size: 1 }), undefined, 'the oldest waiting request was dropped, leaving no state');
});

test('an error, a throw or no size is "none", and the panel keeps going', async () => {
  const reader = scriptedReader();
  const cache = cacheModule.createDimensionCache(reader.read);
  const subjects = ['public/a.png', 'public/b.png', 'public/c.png'].map((rel) => ({ rel, size: 1, modifiedMs: 1 }));
  for (const subject of subjects) {
    cache.request(subject);
  }
  reader.calls[0].resolve({ ok: false, error: 'gone' });
  reader.calls[1].reject(new Error('unreadable'));
  reader.calls[2].resolve({ ok: true, value: undefined });
  await settle();
  for (const subject of subjects) {
    assert.deepEqual(cache.get(subject), { kind: 'none' });
  }
});

test('a size learned elsewhere is kept, and listeners hear every change', async () => {
  const reader = scriptedReader();
  const cache = cacheModule.createDimensionCache(reader.read);
  let heard = 0;
  const stop = cache.subscribe(() => {
    heard += 1;
  });
  const clip = { rel: 'public/clip.mp4', size: 5 };
  cache.put(clip, { widthPx: 640, heightPx: 360 });
  assert.deepEqual(cache.get(clip), { kind: 'known', size: { widthPx: 640, heightPx: 360 } });
  assert.equal(heard, 1);
  cache.request(clip);
  assert.equal(reader.calls.length, 0, 'a known video is not read');
  stop();
  cache.put(clip, { widthPx: 1280, heightPx: 720 });
  assert.equal(heard, 1, 'an unsubscribed listener hears nothing');
  assert.throws(() => cache.put(clip, { widthPx: 0, heightPx: 720 }), /A learned width is positive/);
  assert.equal(cacheModule.dimensionKey({ rel: 'a', size: 1 }) === cacheModule.dimensionKey({ rel: 'a', size: 1, modifiedMs: 0 }), false);
});
