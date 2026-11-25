// Goal: publishing survives transient failures and browser suspension without resubmission.
// Method: inject HTTP responses and clock jumps through the real publish client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublishState, publishProject, watchPublish } from '../src/features/publishing/publishClient';
import { hasPendingOperations } from '../src/features/session/activity';

test('publish status recovers from an upstream interruption without resubmitting the publish', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    assert.equal(url, '/studio/api/status');
    assert.equal(options?.method, undefined);
    calls++;
    return calls === 1
      ? new Response('<html>Restarting</html>', { status: 502 })
      : Response.json({
          publishing: {
            kind: 'committed',
            id: 'job',
            sha: 'a'.repeat(40),
            url: 'https://example.test/commit',
          },
        });
  });
  assert.equal((await watchPublish('job', new AbortController().signal)).kind, 'committed');
  assert.equal(calls, 2);
});
test('publish status stops for authentication loss or a restarted job', async (t) => {
  for (const [response, message] of [
    [Response.json({ error: 'Session expired' }, { status: 401 }), /Session expired/],
    [Response.json({ publishing: { kind: 'idle' } }), /Studio restarted/],
  ] as const) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return response;
    });
    await assert.rejects(watchPublish('job', new AbortController().signal), message);
    assert.equal(calls, 1);
    t.mock.restoreAll();
  }
});
test('an interrupted publish POST is never automatically retried', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('Connection lost');
  });
  await assert.rejects(publishProject(new AbortController().signal), /interrupted/);
  assert.equal(calls, 1);
  assert.equal(hasPendingOperations(), false);
});

test('publish progress follows validated server stages and finishes only after the commit', async (t) => {
  let calls = 0;
  const seen: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    const state =
      calls++ === 0
        ? { kind: 'building', id: 'progress-job', stage: 'preparing' }
        : {
            kind: 'committed',
            id: 'progress-job',
            sha: 'a'.repeat(40),
            url: 'https://example.test/commit',
          };
    return Response.json(options?.method === 'POST' ? state : { publishing: state });
  });
  await publishProject(new AbortController().signal, 'all', (state) => seen.push(state));
  assert.deepEqual(
    seen.map(parsePublishState).map((state) => state.kind),
    ['building', 'committed'],
  );
  assert.deepEqual(parsePublishState({ kind: 'building', id: 'old-worker' }), {
    kind: 'building',
    id: 'old-worker',
  });
  assert.throws(() => parsePublishState({ kind: 'building', id: 'job', stage: 'imaginary' }), /Invalid publish stage/);
});

test('resuming a suspended tab reads the completed publish before applying a deadline', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => {
    now += 3_600_000;
    return now;
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      publishing: {
        kind: 'committed',
        id: 'job',
        sha: 'a'.repeat(40),
        url: 'https://example.test/commit',
      },
    }),
  );
  assert.equal((await watchPublish('job', new AbortController().signal)).kind, 'committed');
});
