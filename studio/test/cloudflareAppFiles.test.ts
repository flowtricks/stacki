// Goal: hosted app frames load their own files through signed links, and the links open
// nothing else (issue #80). A signed-in load redirects into the link prefix; a load under a
// valid link reaches the container with the container token only; every other request
// under the prefix, and every unauthenticated or expired-session request, is refused
// before the container sees it.
// Method: the real Worker in workerd (workerRuntime.ts) with a stub container that echoes
// what reached it. Redirects are not followed, so each hop is inspected; `x-stub-preview`
// on a response proves the request reached the container.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerRuntime, studioCookie, WORKER_TEST, type WorkerResponse, WORKER_RUNTIME_LIMITS } from './workerRuntime';
import { record } from '../src/shared/validation';

const HOUR_MS = 3_600_000;
const FILES = WORKER_TEST.studioOrigin + '/studio/api/apps/files/';

function reached(response: WorkerResponse): boolean {
  return response.headers.get('x-stub-preview') === 'reached';
}

test('app frames load their files through signed links that open nothing else', { timeout: WORKER_RUNTIME_LIMITS.testFileMs }, async (context) => {
  const runtime = await startWorkerRuntime();
  context.after(() => runtime.dispose());
  const cookie = await studioCookie(HOUR_MS);

  async function mint(id: string, file: string): Promise<string> {
    const response = await runtime.fetch(FILES + id + '/' + file, { headers: { cookie }, redirect: 'manual' });
    assert.equal(response.status, 302, await response.text());
    assert.equal(reached(response), false);
    const location = response.headers.get('location') ?? '';
    assert.ok(location.startsWith('/studio/api/apps/files/' + id + '/~'), 'The redirect stays in the app folder: ' + location);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return WORKER_TEST.studioOrigin + location;
  }

  await context.test('a signed-in load redirects to a link, and the link loads without a cookie', async () => {
    const link = await mint('notes', 'index.html');
    assert.ok(link.endsWith('/index.html'));
    const response = await runtime.fetch(link, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.ok(reached(response));
    const echo = record(await response.json());
    assert.equal(echo['url'], WORKER_TEST.studioOrigin + '/studio/api/apps/files/notes/index.html', 'The container sees the plain path');
    assert.equal(echo['method'], 'GET');
    assert.equal(echo['token'], WORKER_TEST.containerToken);
    assert.equal(echo['user'], null, 'No user reaches the container');
    assert.equal(echo['userId'], null);
    assert.equal(echo['session'], null);
    assert.equal(echo['cookie'], null);
    assert.equal(echo['forwardedProto'], 'https');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-security-policy'), `sandbox allow-scripts; default-src 'none'; frame-ancestors ${WORKER_TEST.studioOrigin}`);
  });

  await context.test('relative loads under the link reach sibling files; HEAD works', async () => {
    const link = await mint('notes', 'index.html');
    const sibling = link.replace(/index\.html$/, '__stacki/ui.js');
    const response = await runtime.fetch(sibling, { method: 'HEAD', redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.ok(reached(response));
  });

  await context.test('writes under a link are refused before the container', async () => {
    const link = await mint('notes', 'index.html');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await runtime.fetch(link, { method, headers: { Origin: WORKER_TEST.studioOrigin }, redirect: 'manual' });
      assert.equal(response.status, 404, method);
      assert.equal(reached(response), false, method);
    }
  });

  await context.test('a link for one app does not open another, and tampering is refused', async () => {
    const link = await mint('notes', 'app.css');
    const signature = /~[0-9]+\.([A-Za-z0-9_-]{43})\//.exec(link)?.[1] ?? '';
    const expiry = /~([0-9]+)\./.exec(link)?.[1] ?? '';
    assert.equal(signature.length, 43);
    const tampered = [
      link.replace('/files/notes/', '/files/other/'),
      link.replace(signature, (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)),
      link.replace('~' + expiry, '~' + String(Number(expiry) + 1)),
    ];
    for (const attempt of tampered) {
      const response = await runtime.fetch(attempt, { headers: { cookie }, redirect: 'manual' });
      assert.equal(response.status, 404, attempt);
      assert.equal(reached(response), false, attempt);
      assert.equal(await response.text(), 'Not found', 'Every refusal is the same');
    }
  });

  await context.test('traversal out of the link is refused or lands on a cookie-gated path', async () => {
    const link = await mint('notes', 'app.css');
    const prefix = link.slice(0, link.length - 'app.css'.length);
    for (const attempt of [
      '%2e%2e%2f%2e%2e%2fsession',
      '..%2f..%2f..%2fsession',
      '%252e%252e/%252e%252e/session',
      '..%5c..%5csession',
      'a%00.css',
      '.env',
      '..\\..\\..\\session',
    ]) {
      const response = await runtime.fetch(prefix + attempt, { redirect: 'manual' });
      assert.ok([401, 404].includes(response.status), `${attempt}: ${response.status}`);
      assert.equal(reached(response), false, attempt);
    }
    // Literal dot segments are resolved by URL parsing; whatever remains has no link and needs a session.
    for (const attempt of ['../../../session', '../../other/~1.' + 'A'.repeat(43) + '/x.css']) {
      const response = await runtime.fetch(prefix + attempt, { redirect: 'manual' });
      assert.ok([401, 404].includes(response.status), `${attempt}: ${response.status}`);
      assert.equal(reached(response), false, attempt);
    }
  });

  await context.test('a link is not honoured on the preview host', async () => {
    const link = await mint('notes', 'app.css');
    const response = await runtime.fetch(link.replace(WORKER_TEST.studioOrigin, WORKER_TEST.previewOrigin), { redirect: 'manual' });
    assert.equal(response.status, 401);
    assert.equal(reached(response), false);
  });

  await context.test('without a session, or with an expired one, nothing is minted or served', async () => {
    const expired = await studioCookie(-1000);
    for (const headers of [{}, { cookie: expired }, { cookie: '__Host-studio=forged.value' }]) {
      const response = await runtime.fetch(FILES + 'notes/index.html', { headers, redirect: 'manual' });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('location'), null);
      assert.equal(reached(response), false);
    }
  });
  assert.deepEqual(runtime.unexpectedLogs([]), [], 'The runtime logged no unexpected warning or error');
});
