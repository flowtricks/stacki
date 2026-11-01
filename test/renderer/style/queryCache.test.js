// Goal: the style panel's query cache batches a render's requests per element,
// deduplicates outstanding work, and discards replies from before a clear.
// Method: the module is bundled with esbuild and driven against a query whose
// replies the test resolves by hand, so batching and ordering are observable.

const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

(async () => {
  const outfile = repoPath('node_modules/.stacki-test/query-cache.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/model/queryCache.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const { createQueryCache } = require(outfile);
  const calls = [];
  const cache = createQueryCache((element, keys) => new Promise((resolve) => calls.push({ element, keys, resolve })));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  let notifications = 0;
  const off = cache.subscribe(() => notifications++);

  const first = cache.request('a', 'display');
  assert.equal(cache.request('a', 'display'), first, 'deduplicate before the batch runs');
  const otherProp = cache.request('a', 'color');
  const otherPath = cache.request('b', 'opacity');
  await tick();
  assert.deepEqual(
    calls.map(({ element, keys }) => [element, keys]),
    [
      ['a', ['display', 'color']],
      ['b', ['opacity']],
    ],
    'each element gets its own batch',
  );
  assert.equal(cache.request('a', 'display'), first, 'deduplicate while the reply is outstanding');
  calls[1].resolve({ opacity: '0.5' });
  calls[0].resolve({ display: 'grid', color: '' });
  assert.deepEqual(await Promise.all([first, otherProp, otherPath]), ['grid', '', '0.5']);
  assert.deepEqual(cache.read('a', 'color'), { kind: 'settled', answer: '' }, 'empty values are settled answers');
  assert.equal(notifications, 2, 'one notification per completed batch');

  const obsolete = cache.request('a', 'width');
  await tick();
  cache.clear();
  assert.equal(await obsolete, undefined, 'invalidation settles outstanding callers');
  const fresh = cache.request('a', 'width');
  await tick();
  calls[2].resolve({ width: '10px' });
  await tick();
  assert.deepEqual(cache.read('a', 'width'), { kind: 'pending' }, 'old replies cannot refill the new cache');
  assert.equal(cache.request('a', 'width'), fresh, 'an old completion cannot erase fresh in-flight work');
  calls[3].resolve({ width: '20px' });
  assert.equal(await fresh, '20px');

  cache.setScope(['project', 'page', 'desktop']);
  assert.deepEqual(cache.read('a', 'width'), { kind: 'pending' }, 'documents and breakpoints have separate answers');
  const missing = cache.request('a', 'missing');
  await tick();
  calls[4].resolve(undefined);
  assert.equal(await missing, undefined);
  assert.deepEqual(cache.read('a', 'missing'), { kind: 'settled', answer: undefined }, 'a failed query settles, rather than waiting forever');
  cache.setScope(['project', 'page', 'desktop']);
  assert.deepEqual(cache.read('a', 'missing'), { kind: 'settled', answer: undefined }, 'unchanged scope preserves settled answers');
  const queued = cache.request('a', 'cancelled');
  cache.clear();
  assert.equal(await queued, undefined);
  await tick();
  assert.equal(calls.length, 5, 'clearing cancels a batch that has not started');

  const rejects = createQueryCache(() => Promise.reject(new Error('frame closed')));
  assert.equal(await rejects.request('', 'var(--color)'), undefined, 'bridge rejection is a settled miss');
  const throws = createQueryCache(() => {
    throw new Error('bridge missing');
  });
  assert.equal(await throws.request('', 'var(--color)'), undefined, 'synchronous bridge failure is contained');
  off();
  cache.clear();
  console.log('query-cache: passed [batching, deduplication, stale replies, scope, cancellation, failure]');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
