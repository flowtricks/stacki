// Goal: the failure that painted a black canvas is caught from a real HTTP exchange: a dev server that answers 200,
// starts the page, and then dies while rendering it. The same inspection also sees a 500, an empty page, the dev
// server's error screen, a healthy page, and a server that is not there.
// Method: a tiny generated node http server per case. One sends the headers and part of the page and destroys the
// socket; one ends a chunked body early; one answers 500; one answers 200 with an empty body; one is healthy; the last
// port is closed. The thrown error is taken from a log tail handed in, as the real handler does.
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { test } from 'node:test';
import { inspectPreviewPage } from '#dist/electron/preview/previewInspect.js';

const GOOD_PAGE = '<!doctype html><html><head><title>t</title></head><body><main>ok</main></body></html>';
const LOG = '12:00:01 [ERROR] ReferenceError: items is not defined\n    at /site/src/pages/index.astro:3:1';

async function withServer<T>(handler: http.RequestListener, run: (url: string) => Promise<T>): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object', 'the server listens on a port');
    const { port } = address;
    return await run(`http://127.0.0.1:${port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a 200 whose socket is destroyed mid-page is dropped, with the thrown error from the log', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<!doctype html><html><head><title>t</title></head><body><h1>Half');
      setTimeout(() => response.socket?.destroy(), 20);
    },
    async (url) => {
      const health = await inspectPreviewPage(url, LOG);
      assert.equal(health.kind, 'dropped');
      assert.equal(health.status, 200);
      assert.match(health.thrown ?? '', /ReferenceError: items is not defined/);
      assert.equal(health.logTail, LOG);
    },
  );
});

test('a 200 whose body ends before the closing html tag is truncated', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><head></head><body><h1>Cut here');
    },
    async (url) => {
      const health = await inspectPreviewPage(url, LOG);
      assert.equal(health.kind, 'truncated');
      assert.match(health.thrown ?? '', /items is not defined/);
    },
  );
});

test('a 500 is a server error', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(500, { 'content-type': 'text/html' });
      response.end('<html><body>Internal Server Error</body></html>');
    },
    async (url) => {
      const health = await inspectPreviewPage(url, LOG);
      assert.equal(health.kind, 'server-error');
      assert.equal(health.status, 500);
    },
  );
});

test('a 200 with an empty body is an empty page', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('');
    },
    async (url) => {
      assert.equal((await inspectPreviewPage(url, '')).kind, 'empty-page');
    },
  );
});

test('the dev server error screen is named, with its own message', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(500, { 'content-type': 'text/html' });
      response.end(
        '<html><body><script type="module">import { ErrorOverlay } from "/@vite/client"; document.body.appendChild(new ErrorOverlay({"message":"Unexpected token"}))</script></body></html>',
      );
    },
    async (url) => {
      const health = await inspectPreviewPage(url, '');
      assert.equal(health.kind, 'error-overlay');
      assert.equal(health.thrown, 'Unexpected token');
    },
  );
});

test('a healthy page is ok and carries no log', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(GOOD_PAGE);
    },
    async (url) => {
      const health = await inspectPreviewPage(url, LOG);
      assert.equal(health.kind, 'ok');
      assert.equal(health.logTail, '');
    },
  );
});

test('a chunked page that never finishes is cut by the time limit, not waited on forever', async (context) => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<!doctype html><html><body>started');
      // Never ends; the socket is closed by the server teardown.
    },
    async (url) => {
      const pending = inspectPreviewPage(url, '');
      const raced = await Promise.race([pending, new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), 12_000).unref())]);
      context.diagnostic('inspection answered within the limit');
      assert.notEqual(raced, 'late');
    },
  );
});

test('a closed port is unreachable', async () => {
  const closed = await withServer(
    (_request, response) => response.end(),
    async (url) => url,
  );
  const health = await inspectPreviewPage(closed, LOG);
  assert.equal(health.kind, 'unreachable');
  assert.equal(health.status, 0);
});
