// Goal: a read started while the palette highlights a component is the read the insert uses, a read
// never outlives its age or a metadata write, a failed read is not kept, and the number kept is bounded.
// Method: the real WarmReads class with a counting reader and an injected clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { WarmReads, WARM_READ_LIMITS } = loadRenderer('src/app/model/componentWarm.ts');

test('a fresh read is shared, an old one is read again', async () => {
  const reads = new WarmReads();
  let started = 0;
  const start = () => Promise.resolve(++started);
  assert.equal(await reads.read('a', 0, start), 1);
  assert.equal(await reads.read('a', WARM_READ_LIMITS.ageMsMax, start), 1, 'still trusted at the age limit');
  assert.equal(await reads.read('a', WARM_READ_LIMITS.ageMsMax + 1, start), 2, 'past it, a new read');
});

test('a failed read is not kept, and forgetting empties it', async () => {
  const reads = new WarmReads();
  await assert.rejects(reads.read('a', 0, () => Promise.reject(new Error('disk'))));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await reads.read('a', 1, () => Promise.resolve('ok')), 'ok');
  reads.forget();
  assert.equal(await reads.read('a', 2, () => Promise.resolve('again')), 'again');
});

test('the reads kept are bounded', async () => {
  const reads = new WarmReads();
  for (let index = 0; index < WARM_READ_LIMITS.entriesMax + 10; index += 1) {
    await reads.read(`k${index}`, 0, () => Promise.resolve(index));
  }
  let restarted = 0;
  await reads.read('k0', 0, () => Promise.resolve(++restarted));
  assert.equal(restarted, 1, 'the oldest was dropped');
});
