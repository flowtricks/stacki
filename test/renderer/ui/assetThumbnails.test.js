// Goal: large pictures are shrunk once each, a few at a time, kept within a bound, and a picture that
// cannot be shrunk is drawn as it is rather than left blank. Methodology: drive the real cache
// (src/ui/assetThumbnails.ts) with a scripted maker whose answers the test releases, and count what it
// was asked: one make per key however often it is requested, at most THUMBNAIL_READS_MAX at once, the
// newest request first, the queue bounded, a failure answered "direct", and the oldest copy's object
// URL revoked when the cache passes its entry bound.
const test = require('node:test');
const assert = require('node:assert/strict');
const thumbnails = require('../../helpers/rendererModule')('src/ui/assetThumbnails.ts');

function scriptedMaker() {
  const calls = [];
  const make = (source, widthPx) =>
    new Promise((resolve, reject) => {
      calls.push({ source, widthPx, resolve, reject });
    });
  return { calls, make };
}

function fakeUrls() {
  const revoked = [];
  let next = 0;
  return {
    revoked,
    urls: {
      create: () => {
        next += 1;
        return `blob:thumb-${next}`;
      },
      revoke: (url) => revoked.push(url),
    },
  };
}

// Lets the cache's promise chain and its queued drain run, without a timer.
async function settle() {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

test('a picture is shrunk once, to the thumbnail width, and failures draw the file itself', async () => {
  const maker = scriptedMaker();
  const { urls } = fakeUrls();
  const cache = thumbnails.createThumbnailCache(maker.make, urls);
  assert.equal(cache.get('a'), undefined);
  cache.request('a', 'stacki-asset://local/a.webp');
  cache.request('a', 'stacki-asset://local/a.webp');
  assert.equal(maker.calls.length, 1, 'a repeated request is one make');
  assert.equal(maker.calls[0].widthPx, thumbnails.THUMBNAIL_WIDTH_PX);
  maker.calls[0].resolve(new Blob(['x']));
  await settle();
  assert.deepEqual(cache.get('a'), { kind: 'ready', url: 'blob:thumb-1' });
  cache.request('a', 'stacki-asset://local/a.webp');
  assert.equal(maker.calls.length, 1, 'a made copy is never made again');
  cache.request('b', 'stacki-asset://local/b.png');
  maker.calls[1].reject(new Error('decode failed'));
  await settle();
  assert.deepEqual(cache.get('b'), { kind: 'direct' });
});

test('makes run a few at a time, newest first, and the queue stays bounded', async () => {
  const maker = scriptedMaker();
  const { urls } = fakeUrls();
  const cache = thumbnails.createThumbnailCache(maker.make, urls);
  const total = thumbnails.THUMBNAIL_READS_MAX + thumbnails.THUMBNAIL_QUEUE_MAX + 5;
  for (let index = 0; index < total; index += 1) {
    cache.request(`key-${index}`, `source-${index}`);
  }
  assert.equal(maker.calls.length, thumbnails.THUMBNAIL_READS_MAX);
  assert.equal(cache.stats().waiting, thumbnails.THUMBNAIL_QUEUE_MAX);
  maker.calls[0].resolve(new Blob(['x']));
  await settle();
  assert.equal(maker.calls.length, thumbnails.THUMBNAIL_READS_MAX + 1);
  assert.equal(maker.calls.at(-1).source, `source-${total - 1}`, 'the newest request goes first');
});

test('past its bound the cache releases the oldest copy and revokes its URL', async () => {
  const maker = scriptedMaker();
  const fake = fakeUrls();
  const cache = thumbnails.createThumbnailCache(maker.make, fake.urls);
  for (let index = 0; index <= thumbnails.THUMBNAIL_ENTRIES_MAX; index += 1) {
    cache.request(`key-${index}`, `source-${index}`);
    maker.calls[index].resolve(new Blob(['x']));
    await settle();
  }
  assert.equal(cache.stats().entries, thumbnails.THUMBNAIL_ENTRIES_MAX);
  assert.equal(cache.get('key-0'), undefined);
  assert.deepEqual(fake.revoked, ['blob:thumb-1']);
});

test('only large raster formats are shrunk', () => {
  for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.avif', 'f.tiff']) {
    assert.equal(thumbnails.THUMBNAIL_EXT.test(name), true, name);
  }
  for (const name of ['a.svg', 'b.gif', 'c.ico', 'd.mp4', 'e.pdf']) {
    assert.equal(thumbnails.THUMBNAIL_EXT.test(name), false, name);
  }
});
