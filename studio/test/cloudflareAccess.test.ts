// Goal: no request without a verified Studio session reaches the container or any route the
// Worker answers itself, whatever headers it forges (issue #80: the container resolves a
// request with no x-studio-user to the default role, admin when no roles file exists, so the
// Worker is the boundary that must never forward one, except the GET-only app file links).
// Method: the real Worker in workerd (workerRuntime.ts) with a stub container that marks every
// response it produced. Each role-gated route (serverAccess.ts gatedRoutePaths), each route the
// Worker answers, and the collaboration socket is requested on both hosts without a cookie,
// with an expired one, and with forged identity headers, including the real container token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerRuntime, studioCookie, WORKER_TEST, WORKER_RUNTIME_LIMITS } from './workerRuntime';
import { gatedRoutePaths } from '../src/features/roles/serverAccess';

const WORKER_ANSWERED = [
  '/studio/api/updates',
  '/studio/api/session',
  '/studio/api/preview-url',
  '/studio/api/startup',
  '/studio/api/cms-connections',
  '/studio/api/media-connections',
];
const CONTAINER_READS = ['/studio/api/project', '/studio/api/assets', '/studio/api/apps/files/notes/index.html', '/studio/sync', '/', '/studio/preview.js'];

test('without a verified session nothing reaches the container or a Worker-answered route', { timeout: WORKER_RUNTIME_LIMITS.testFileMs }, async (context) => {
  const runtime = await startWorkerRuntime();
  context.after(() => runtime.dispose());
  const expired = await studioCookie(-1000);
  const forged = {
    'x-studio-user': 'owner',
    'x-studio-user-id': String(WORKER_TEST.editorId),
    'x-studio-token': WORKER_TEST.containerToken,
    'x-studio-session': 'forged',
  };
  const attempts: readonly Record<string, string>[] = [{}, { cookie: expired }, { cookie: '__Host-studio=a.b' }, forged, { ...forged, cookie: expired }];
  // Control: the same request with a valid session does reach the stub, so the check below can fail.
  const control = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/project', { headers: { cookie: await studioCookie(60_000) } });
  assert.equal(control.headers.get('x-stub-preview'), 'reached');
  const paths = [...gatedRoutePaths(), ...WORKER_ANSWERED, ...CONTAINER_READS];
  assert.ok(paths.length > 40);
  for (const origin of [WORKER_TEST.studioOrigin, WORKER_TEST.previewOrigin]) {
    for (const pathname of paths) {
      for (const headers of attempts) {
        for (const method of ['GET', 'POST']) {
          const response = await runtime.fetch(origin + pathname, {
            method,
            headers: { ...headers, Origin: origin },
            ...(method === 'POST' ? { body: '{}' } : {}),
            redirect: 'manual',
          });
          const label = `${method} ${origin}${pathname} with ${Object.keys(headers).join(', ') || 'nothing'}`;
          assert.equal(response.headers.get('x-stub-preview'), null, label + ' reached the container');
          // 401 for the API and preview host; the editor's own pages answer the sign-in page instead.
          assert.ok(response.status === 401 || (!pathname.startsWith('/studio/api/') && origin === WORKER_TEST.studioOrigin), `${label}: ${response.status}`);
        }
      }
    }
  }
  assert.deepEqual(runtime.unexpectedLogs([]), [], 'The runtime logged no unexpected warning or error');
});

test('the internal routes the container calls need the container token', { timeout: WORKER_RUNTIME_LIMITS.testFileMs }, async (context) => {
  const runtime = await startWorkerRuntime();
  context.after(() => runtime.dispose());
  for (const pathname of [
    '/studio/internal/git-bundle?digest=' + 'a'.repeat(64),
    '/studio/internal/bootstrap',
    '/studio/internal/files',
    '/studio/internal/state?file=src/a.astro',
  ]) {
    for (const headers of [{}, { 'x-studio-token': 'wrong' }, { cookie: await studioCookie(60_000) }]) {
      const response = await runtime.fetch(WORKER_TEST.studioOrigin + pathname, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 403, pathname);
    }
  }
  assert.deepEqual(runtime.unexpectedLogs([]), [], 'The runtime logged no unexpected warning or error');
});
