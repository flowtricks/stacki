// Goal: repeated settings opens reuse bounded, sanitized discovery without hiding failures.
// Method: defer IPC replies and control time to test sharing, refresh, expiry, and eviction races.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const request = { provider: 'github', account: '' };
const ready = { kind: 'ready', accounts: [{ id: 'owner', name: 'owner' }], projects: [] };

function fixture() {
  const calls = [];
  global.window = {
    avb: {
      discoverPublishing: (input) => new Promise((resolve, reject) => calls.push({ input, resolve, reject })),
    },
  };
  const { cachedPublishingDiscovery, invalidatePublishingAccounts } = loadRenderer('src/features/publishing/publishDiscoveryCache.ts');
  return { read: cachedPublishingDiscovery, invalidate: invalidatePublishingAccounts, calls };
}

test('sign-in invalidates an older pending account inventory', async () => {
  const { read, invalidate, calls } = fixture();
  const old = read('/project', request, 'reuse');
  invalidate('/project');
  const fresh = read('/project', request, 'refresh');
  assert.equal(calls.length, 2);
  calls[0].resolve(ready);
  await old;
  assert.equal(read('/project', request, 'reuse'), fresh);
  const connected = { ...ready, accounts: [{ id: 'new', name: 'new' }] };
  calls[1].resolve(connected);
  assert.deepEqual(await fresh, connected);
  assert.deepEqual(await read('/project', request, 'reuse'), connected);
});

test('discovery shares requests and reuses results until refresh or expiry', async (context) => {
  const { read, calls } = fixture();
  let now = 0;
  context.mock.method(Date, 'now', () => now);
  const first = read('/project', request, 'reuse');
  assert.equal(read('/project', request, 'reuse'), first);
  assert.equal(calls.length, 1);
  calls[0].resolve(ready);
  assert.deepEqual(await first, ready);
  assert.deepEqual(await read('/project', request, 'reuse'), ready);
  assert.equal(calls.length, 1);
  const refreshed = read('/project', request, 'refresh');
  assert.equal(calls.length, 2);
  assert.equal(read('/project', request, 'reuse'), refreshed);
  calls[1].resolve(ready);
  await refreshed;
  now = 60_000;
  const expired = read('/project', request, 'reuse');
  assert.equal(calls.length, 3);
  calls[2].resolve(ready);
  await expired;
});

test('discovery does not cache failed, partial, or malformed replies', async () => {
  const { read, calls } = fixture();
  const responses = [
    { kind: 'failed', reason: 'expired', message: 'Sign in again.' },
    { ...ready, notice: { reason: 'unknown', message: 'Some accounts could not be loaded.' } },
    {},
  ];
  for (let index = 0; index < responses.length; index++) {
    const pending = read('/project', request, 'reuse');
    assert.equal(calls.length, index + 1);
    calls[index].resolve(responses[index]);
    if (index === 2) {
      await assert.rejects(pending);
    } else {
      await pending;
    }
  }
  const rejected = read('/project', request, 'reuse');
  calls[3].reject(new Error('Disconnected'));
  await assert.rejects(rejected, /Disconnected/);
  const recovered = read('/project', request, 'reuse');
  assert.equal(calls.length, 5);
  calls[4].resolve(ready);
  assert.deepEqual(await recovered, ready);
});

test('discovery isolates project, provider, and account keys', async () => {
  const { read, calls } = fixture();
  const reads = [
    read('/first', request, 'reuse'),
    read('/second', request, 'reuse'),
    read('/first', { provider: 'cloudflare', account: '' }, 'reuse'),
    read('/first', { provider: 'cloudflare', account: 'account' }, 'reuse'),
  ];
  assert.equal(calls.length, 4);
  for (const call of calls) {
    call.resolve(ready);
  }
  await Promise.all(reads);
});

test('bounded eviction prevents an old completion from replacing a new request', async () => {
  const { read, calls } = fixture();
  const oldest = read('/oldest', request, 'reuse');
  const reads = [];
  for (let index = 0; index < 32; index++) {
    reads.push(read(`/project-${index}`, request, 'reuse'));
  }
  const replacement = read('/oldest', request, 'reuse');
  assert.equal(calls.length, 34);
  calls[0].resolve(ready);
  await oldest;
  assert.equal(read('/oldest', request, 'reuse'), replacement);
  for (const call of calls.slice(1)) {
    call.resolve(ready);
  }
  await Promise.all([...reads, replacement]);
  const evicted = read('/project-0', request, 'reuse');
  assert.equal(calls.length, 35);
  calls[34].resolve(ready);
  await evicted;
});
