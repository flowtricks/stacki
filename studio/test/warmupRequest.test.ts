// Goal: starting Studio wakes compute without rendering a hidden homepage.
// Method: forward the generated request through a real HTTP server and verify
// it reaches only the lightweight readiness route with its session intact.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { warmupRequest } from '../src/cloudflare/warmupRequest';

test('opening Studio wakes its status route without executing the homepage', async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    assert.equal(request.headers.cookie, 'fixture-session=present');
    response.end('ready');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const page of ['/studio', '/studio/']) {
      const request = warmupRequest(
        new Request('https://editor.test' + page, {
          headers: { Cookie: 'fixture-session=present' },
        }),
        origin,
      );
      assert.ok(request);
      assert.equal(await (await fetch(request)).text(), 'ready');
    }
    assert.deepEqual(paths, ['/studio/api/status', '/studio/api/status']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('assets and mutations never initiate additional workspace warmups', () => {
  for (const pathname of ['/studio/studio.js', '/studio/studio.css', '/studio/api/project', '/']) {
    assert.equal(warmupRequest(new Request('https://editor.test' + pathname), 'https://preview.test'), undefined);
  }
  assert.equal(warmupRequest(new Request('https://editor.test/studio', { method: 'POST' }), 'https://preview.test'), undefined);
});
