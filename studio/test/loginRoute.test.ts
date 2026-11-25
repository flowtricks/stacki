// Goal: forwarding authentication preserves browser-owned redirects and request credentials.
// Method: use real HTTP redirects with fetch's default follow behavior, then verify routing
// returns the original redirect without requesting its destination or consuming its cookies.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { routeLogin } from '../src/features/auth/loginRoute';

test('authentication redirects return to the browser without a server-side follow', async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === '/studio/auth/login') {
      response.writeHead(302, {
        Location: '/provider',
        'Set-Cookie': 'test-state=browser-only; HttpOnly',
      });
    } else {
      response.writeHead(403);
    }
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const request = new Request(`http://127.0.0.1:${address.port}/studio/auth/login`);
    assert.equal(request.redirect, 'follow');
    const response = await routeLogin(request, (forwarded) => fetch(forwarded));
    assert.equal(response?.status, 302);
    assert.equal(response.headers.get('Location'), '/provider');
    assert.equal(response.headers.get('Set-Cookie'), 'test-state=browser-only; HttpOnly');
    await response.body?.cancel();
    assert.equal(requests, 1, 'The OAuth destination is visited by the browser only');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('callback and logout retain their method, headers and body when forwarded', async () => {
  for (const pathname of ['/studio/auth/callback', '/studio/auth/logout']) {
    const request = new Request('https://studio.test' + pathname, {
      method: 'POST',
      headers: { Origin: 'https://studio.test', Cookie: 'test-session=local' },
      body: 'test-body',
    });
    await routeLogin(request, async (forwarded) => {
      assert.equal(forwarded.redirect, 'manual');
      assert.equal(forwarded.method, 'POST');
      assert.equal(forwarded.headers.get('Origin'), 'https://studio.test');
      assert.equal(forwarded.headers.get('Cookie'), 'test-session=local');
      assert.equal(await forwarded.text(), 'test-body');
      return new Response(null, { status: 204 });
    });
  }
  assert.equal(
    routeLogin(new Request('https://studio.test/studio'), async () => {
      assert.fail('Normal editor requests do not enter authentication');
    }),
    undefined,
  );
});
