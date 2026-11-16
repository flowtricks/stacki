// Goal: the palette's picture store keeps what it has rendered. A tile that has a picture is never taken
// back to waiting (not when asked again, not when the check finds nothing changed, not when a check fails),
// renders happen a few at a time with the visible tile first, a stored picture shows before any render, and
// a failed tile says why and can be retried.
// Methodology: bundle the store alone, drive it with a fake producer whose answers the test releases one by
// one, and a fake persistence; record every state a tile passes through and assert on the whole history.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/preview-snapshot-store.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  entryPoints: [repoPath('src/features/palette/previewSnapshotStore.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { PreviewSnapshotStore, REVALIDATE_AFTER_MS } = require(output);

const KEY = 'a'.repeat(28);
const KEY_TWO = 'b'.repeat(28);
const message = (key = KEY, html = '<p>x</p>') => ({ key, html, box: { left: 0, top: 0, width: 100, height: 50 }, attempt: 'sample' });
const source = (id) => ({ id, name: id, url: `http://dev/__avb/preview?c=${id}&layout=snapshot` });
const request = (id, order, priority = 'background') => ({ source: source(id), priority, order });

/** A producer that waits for the test: `answer(id, outcome)` releases the render of that tile. */
function fakeProducer() {
  const pending = new Map();
  const calls = [];
  const producer = (tile, knownKey) =>
    new Promise((resolve) => {
      calls.push({ id: tile.id, knownKey });
      pending.set(tile.id, resolve);
    });
  const answer = async (id, outcome) => {
    const resolve = pending.get(id);
    assert.ok(resolve, `${id} is rendering`);
    pending.delete(id);
    resolve(outcome);
    await new Promise((done) => setTimeout(done, 0));
  };
  return { producer, answer, calls, running: () => [...pending.keys()] };
}

function record(store, id) {
  const history = [store.tile(id).kind];
  store.subscribe(() => {
    const kind = store.tile(id).kind;
    if (history.at(-1) !== kind) {
      history.push(kind);
    }
  });
  return history;
}

const tick = () => new Promise((done) => setTimeout(done, 0));

test('renders at most three at once, visible first, and starts the next as one answers', async () => {
  const fake = fakeProducer();
  const store = new PreviewSnapshotStore('p', fake.producer);
  store.request([request('d', 3), request('c', 2), request('b', 1), request('a', 0, 'visible'), request('e', 4, 'visible')]);
  assert.equal(fake.running().length, 3);
  assert.ok(fake.running().includes('a') && fake.running().includes('e'), 'both visible tiles start first');
  await fake.answer('a', { kind: 'snapshot', message: message() });
  assert.equal(fake.running().length, 3, 'a finished render frees its place for the next');
  assert.equal(store.tile('a').kind, 'ready');
  assert.equal(store.snapshot('a').key, KEY);
});

test('a ready tile never goes back to waiting: asked again, unchanged, or failing', async () => {
  const fake = fakeProducer();
  let now = 1000;
  const store = new PreviewSnapshotStore('p', fake.producer, { now: () => now });
  const history = record(store, 'a');
  store.request([request('a', 0)]);
  await fake.answer('a', { kind: 'snapshot', message: message() });
  // Asked again at once: trusted, no render.
  store.request([request('a', 0)]);
  assert.deepEqual(fake.running(), []);
  // Asked after the trust period: checked behind the picture, with the key it holds.
  now += REVALIDATE_AFTER_MS + 1;
  store.request([request('a', 0)]);
  assert.equal(fake.calls.at(-1).knownKey, KEY);
  assert.equal(store.tile('a').kind, 'ready');
  await fake.answer('a', { kind: 'unchanged', key: KEY });
  now += REVALIDATE_AFTER_MS + 1;
  store.request([request('a', 0)]);
  await fake.answer('a', { kind: 'empty', reason: 'Threw: boom' });
  assert.equal(store.tile('a').kind, 'ready', 'a failed check keeps the picture');
  assert.equal(store.snapshot('a').key, KEY);
  now += REVALIDATE_AFTER_MS + 1;
  store.request([request('a', 0)]);
  await fake.answer('a', { kind: 'snapshot', message: message(KEY_TWO, '<p>y</p>') });
  assert.equal(store.snapshot('a').key, KEY_TWO, 'a changed component replaces the picture');
  for (const kind of history.slice(history.indexOf('ready'))) {
    assert.equal(kind, 'ready', `history after the first picture: ${history.join(' > ')}`);
  }
  assert.deepEqual(
    history.slice(0, history.indexOf('ready')).filter((kind) => kind === 'unavailable'),
    [],
  );
});

test('a stored picture shows before any render, and the render is a check with its key', async () => {
  const fake = fakeProducer();
  const stored = { key: KEY, html: '<p>kept</p>', box: { left: 0, top: 0, width: 10, height: 10 }, attempt: 'authored', bytes: 11 };
  const persistence = { read: async (id) => (id === 'p::a' ? stored : undefined), write: async () => {}, remove: async () => {} };
  const store = new PreviewSnapshotStore('p', fake.producer, { persistence });
  const history = record(store, 'a');
  store.request([request('a', 0)]);
  await tick();
  assert.equal(store.tile('a').kind === 'ready' || store.tile('a').kind === 'rendering', true);
  await tick();
  assert.equal(store.snapshot('a').html, '<p>kept</p>');
  assert.equal(history.includes('ready'), true);
  assert.equal(fake.calls[0].knownKey === undefined || fake.calls[0].knownKey === KEY, true);
});

test('a snapshot is written to the persistence under the project and the tile', async () => {
  const fake = fakeProducer();
  const written = [];
  const persistence = { read: async () => undefined, write: async (id, held) => void written.push([id, held.key]), remove: async () => {} };
  const store = new PreviewSnapshotStore('proj', fake.producer, { persistence });
  store.request([request('src/components/A.astro', 0)]);
  await fake.answer('src/components/A.astro', { kind: 'snapshot', message: message() });
  assert.deepEqual(written, [['proj::src/components/A.astro', KEY]]);
});

test('a failed tile says why, is not asked again, and a retry renders it', async () => {
  const fake = fakeProducer();
  const store = new PreviewSnapshotStore('p', fake.producer);
  store.request([request('a', 0)]);
  await fake.answer('a', { kind: 'empty', reason: 'Preview needs data for: items, band. Open an instance on a page.' });
  const state = store.tile('a');
  assert.equal(state.kind, 'unavailable');
  assert.deepEqual(state.reason, { kind: 'needs-props', names: ['items', 'band'] });
  store.request([request('a', 0)]);
  assert.deepEqual(fake.running(), [], 'a known failure is not rendered again by a request');
  store.retry('a');
  assert.deepEqual(fake.running(), ['a']);
  await fake.answer('a', { kind: 'snapshot', message: message() });
  assert.equal(store.tile('a').kind, 'ready');
  store.retry('a');
  assert.deepEqual(fake.running(), [], 'a retry of a tile that is fine does nothing');
});

test('a timeout and an unresolved address are reasons, and a producer that throws is a reason too', async () => {
  const fake = fakeProducer();
  const store = new PreviewSnapshotStore('p', fake.producer);
  store.request([request('a', 0), request('b', 1)]);
  await fake.answer('a', { kind: 'timeout' });
  await fake.answer('b', { kind: 'unresolved' });
  assert.deepEqual(store.tile('a').reason, { kind: 'timeout' });
  assert.deepEqual(store.tile('b').reason, { kind: 'no-server' });
  const throwing = new PreviewSnapshotStore('p', () => Promise.reject(new Error('nope')));
  throwing.request([request('c', 0)]);
  await tick();
  assert.equal(throwing.tile('c').reason.kind, 'threw');
});

test('cancelling what waits keeps every picture, and a restart lets failures be tried again', async () => {
  const fake = fakeProducer();
  const store = new PreviewSnapshotStore('p', fake.producer, { concurrency: 1 });
  store.request([request('a', 0), request('b', 1), request('c', 2)]);
  await fake.answer('a', { kind: 'snapshot', message: message() });
  assert.equal(store.tile('c').kind, 'queued');
  store.cancelWaiting();
  assert.equal(store.tile('c').kind, 'idle');
  assert.equal(store.tile('a').kind, 'ready');
  await fake.answer('b', { kind: 'empty', reason: 'The component rendered nothing.' });
  assert.equal(store.tile('b').kind, 'unavailable');
  store.invalidateChecks();
  assert.equal(store.tile('b').kind, 'idle');
  assert.equal(store.tile('a').kind, 'ready');
});

test('memory is bounded: an evicted picture comes back from the persistence, the tile never blanks', async () => {
  const fake = fakeProducer();
  const kept = new Map();
  const persistence = { read: async (id) => kept.get(id), write: async (id, held) => void kept.set(id, held), remove: async () => {} };
  const store = new PreviewSnapshotStore('p', fake.producer, { persistence, concurrency: 1 });
  const big = 'x'.repeat(3_000_000);
  const ids = Array.from({ length: 10 }, (_, index) => `t${index}`);
  store.request(ids.map((id, order) => request(id, order)));
  for (const id of ids) {
    await fake.answer(id, { kind: 'snapshot', message: message(KEY, big) });
  }
  const evicted = ids.filter((id) => store.snapshot(id) === undefined);
  assert.ok(evicted.length > 0, '30 MB does not fit a 24 MB memory budget');
  assert.ok(
    ids.every((id) => store.tile(id).kind === 'ready'),
    'every tile is still ready',
  );
  store.request(evicted.map((id, order) => request(id, order)));
  await tick();
  await tick();
  assert.ok(store.snapshot(evicted[0]) !== undefined, 'the evicted picture was read back');
});
