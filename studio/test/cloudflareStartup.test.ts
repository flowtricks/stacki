// Goal: the start readout is reachable only with a verified Studio session, the container's start
// report only with the container token, and neither can be used on the wrong method or host.
// Method: the real Worker in workerd (workerRuntime.ts) with the stub Durable Object, which echoes the
// URL and method that reached it: the echo proves the request got past the Worker and what it carried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerRuntime, studioCookie, WORKER_TEST, WORKER_RUNTIME_LIMITS } from './workerRuntime';

test('the start readout and the start report are guarded', { timeout: WORKER_RUNTIME_LIMITS.testFileMs }, async (context) => {
  const runtime = await startWorkerRuntime();
  context.after(() => runtime.dispose());
  const session = await studioCookie(60_000);

  // A signed-in editor's readout reaches the Durable Object, which answers without the container.
  const readout = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/startup', { headers: { cookie: session } });
  assert.equal(readout.status, 200);
  assert.equal(readout.headers.get('x-stub-preview'), 'reached');
  const echoed: unknown = await readout.json();
  assert.ok(typeof echoed === 'object' && echoed !== null && 'url' in echoed && echoed.url === WORKER_TEST.studioOrigin + '/studio/api/startup');

  // Without a session, with an expired one, and on the preview host, it is refused before the Durable Object.
  for (const [origin, headers] of [
    [WORKER_TEST.studioOrigin, {}],
    [WORKER_TEST.studioOrigin, { cookie: await studioCookie(-1000) }],
    [WORKER_TEST.previewOrigin, { cookie: session }],
  ] as const) {
    const refused = await runtime.fetch(origin + '/studio/api/startup', { headers });
    assert.equal(refused.headers.get('x-stub-preview'), null, `${origin} ${Object.keys(headers).join(',')}`);
    assert.ok(refused.status >= 400);
    await refused.arrayBuffer();
  }

  // Only the readout is a GET: a POST to it is not answered by the Worker route.
  const report = JSON.stringify({ stage: 'drafts', sinceStartMs: 1200 });
  const withToken = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/internal/startup', {
    method: 'POST',
    headers: { 'x-studio-token': WORKER_TEST.containerToken, 'Content-Type': 'application/json' },
    body: report,
  });
  assert.equal(withToken.headers.get('x-stub-preview'), 'reached');
  await withToken.arrayBuffer();

  for (const headers of [{}, { 'x-studio-token': 'wrong-token' }, { cookie: session }]) {
    const refused = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/internal/startup', { method: 'POST', headers, body: report });
    assert.equal(refused.status, 403, Object.keys(headers).join(','));
    assert.equal(refused.headers.get('x-stub-preview'), null);
    await refused.arrayBuffer();
  }

  const wrongMethod = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/internal/startup', { headers: { 'x-studio-token': WORKER_TEST.containerToken } });
  assert.equal(wrongMethod.status, 405);
  await wrongMethod.arrayBuffer();
  assert.deepEqual(runtime.unexpectedLogs([]), []);
});
