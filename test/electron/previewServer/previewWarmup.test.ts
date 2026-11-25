// Goal: first-page rendering keeps priority while a bounded set of reusable page
// modules compiles afterward, followed by one render of the component preview route.
// Drive HTTP completion and timers without rendering pages; record warmup requests.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { previewWarmupAfterPage, previewWarmupFiles, previewWarmupURL } from '#dist/electron/previewServer/previewWarmup.js';

type WarmupServer = Parameters<typeof previewWarmupAfterPage>[0];
type Middleware = Parameters<WarmupServer['middlewares']['use']>[0];

function harness() {
  let middleware: Middleware | undefined;
  const events = new EventEmitter();
  const loaded: string[] = [];
  const requested: string[] = [];
  const errors: unknown[] = [];
  const server: WarmupServer = {
    middlewares: {
      use: (handler) => {
        middleware = handler;
      },
    },
    httpServer: events,
    ssrLoadModule: async (file) => {
      loaded.push(file);
    },
  };
  const plan = (files: readonly string[], previewURL: string | undefined) => ({
    files: () => files,
    previewURL: () => previewURL,
    request: async (url: string) => {
      requested.push(url);
    },
  });
  return {
    server,
    loaded,
    requested,
    errors,
    plan,
    close: () => events.emit('close'),
    request(contentType: string, statusCode = 200): void {
      assert.ok(middleware);
      const request = new IncomingMessage(new Socket());
      request.method = 'GET';
      const response = new ServerResponse(request);
      response.statusCode = statusCode;
      response.setHeader('content-type', contentType);
      let nextCount = 0;
      middleware(request, response, () => {
        nextCount += 1;
      });
      assert.equal(nextCount, 1, 'The page request is never held up by warmup');
      response.emit('finish');
    },
  };
}

test('warmup chooses two reusable templates, excluding endpoints and the homepage', () => {
  const files = ['index.astro', '404.astro', 'about.astro', 'api.ts', '[...slug].astro', 'blog/[slug].astro', '[...slug].astro'];
  const routes = files.map((file) => ({ origin: 'project', entrypoint: `src/pages/${file}` }));
  assert.deepEqual(previewWarmupFiles(routes), ['src/pages/[...slug].astro', 'src/pages/blog/[slug].astro']);
  assert.deepEqual(previewWarmupFiles([{ origin: 'external', entrypoint: 'external.astro' }]), []);
  assert.deepEqual(previewWarmupFiles([{ origin: 'project' }]), []);
  const redirects = Array.from({ length: 2100 }, () => ({ origin: 'project', entrypoint: '/go' }));
  assert.equal(previewWarmupFiles([...redirects, ...routes]).length, 2);
  const limit = Array.from({ length: 10000 }, () => ({ origin: 'project', entrypoint: '/go' }));
  assert.deepEqual(previewWarmupFiles([...limit, ...routes]), []);
});

test('warmup waits for HTML and compiles at most two modules once', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const host = harness();
  previewWarmupAfterPage(host.server, host.plan(['a.astro', 'b.astro', 'c.astro'], 'http://127.0.0.1:4321/__avb/preview'), (error) => host.errors.push(error));
  host.request('application/javascript');
  host.request('text/html', 500);
  context.mock.timers.tick(1000);
  assert.deepEqual(host.loaded, []);
  host.request('text/html; charset=utf-8');
  host.request('text/html');
  context.mock.timers.tick(499);
  assert.deepEqual(host.loaded, []);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(host.loaded, ['a.astro', 'b.astro']);
  assert.deepEqual(host.requested, ['http://127.0.0.1:4321/__avb/preview'], 'the preview route renders once, after the templates');
  assert.deepEqual(host.errors, []);
  host.close();
});

test('the preview route URL follows the address, base and slash policy', () => {
  const address = { address: '127.0.0.1', family: 'IPv4', port: 4321 };
  assert.equal(previewWarmupURL(address, {}), 'http://127.0.0.1:4321/__avb/preview');
  assert.equal(previewWarmupURL(address, { base: '/docs/', trailingSlash: 'always' }), 'http://127.0.0.1:4321/docs/__avb/preview/');
  assert.equal(previewWarmupURL({ address: '::1', family: 'IPv6', port: 4321 }, {}), 'http://[::1]:4321/__avb/preview');
  assert.equal(previewWarmupURL({ address: '0.0.0.0', family: 'IPv4', port: 4321 }, {}), 'http://localhost:4321/__avb/preview');
  assert.equal(previewWarmupURL('/tmp/astro.sock', {}), undefined, 'a pipe has no URL to request');
  const platformNull: unknown = JSON.parse('null');
  assert.equal(previewWarmupURL(platformNull, {}), undefined, 'Node reports null before the server listens');
  assert.equal(previewWarmupURL({ port: 4321 }, {}), undefined, 'a partial address is not requested');
  assert.equal(previewWarmupURL(undefined, {}), undefined);
  assert.throws(() => previewWarmupURL({ address: '127.0.0.1', family: 'IPv4', port: 1.5 }, {}), /integer port/);
});

test('an unknown address skips the route render and a failed render is reported', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const host = harness();
  previewWarmupAfterPage(host.server, host.plan([], undefined), (error) => host.errors.push(error));
  host.request('text/html');
  context.mock.timers.tick(500);
  await setImmediate();
  assert.deepEqual(host.requested, []);
  host.close();

  const failing = harness();
  const failure = new Error('preview route failed');
  previewWarmupAfterPage(
    failing.server,
    {
      files: () => [],
      previewURL: () => 'http://127.0.0.1:4321/__avb/preview',
      request: async () => {
        throw failure;
      },
    },
    (error) => failing.errors.push(error),
  );
  failing.request('text/html');
  context.mock.timers.tick(500);
  await setImmediate();
  assert.deepEqual(failing.errors, [failure]);
  failing.close();
});

test('closing a preview cancels scheduled compilation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const host = harness();
  previewWarmupAfterPage(host.server, host.plan(['a.astro'], 'http://127.0.0.1:4321/__avb/preview'), (error) => host.errors.push(error));
  host.request('text/html');
  host.close();
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.deepEqual(host.loaded, []);
  assert.deepEqual(host.requested, []);
  assert.deepEqual(host.errors, []);
});

test('modern Astro uses its rendering environment and reports warmup failures', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const host = harness();
  const failure = new Error('template compilation failed');
  const server: WarmupServer = {
    ...host.server,
    environments: {
      ssr: {
        runner: {
          import: async () => {
            throw failure;
          },
        },
      },
    },
  };
  previewWarmupAfterPage(server, host.plan(['a.astro'], 'http://127.0.0.1:4321/__avb/preview'), (error) => host.errors.push(error));
  host.request('text/html');
  context.mock.timers.tick(500);
  await setImmediate();
  assert.deepEqual(host.loaded, []);
  assert.deepEqual(host.errors, [failure]);
  assert.deepEqual(host.requested, [], 'a failed template compile stops warmup before the route render');
  host.close();
});
