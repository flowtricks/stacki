// Goal: the preview dev server's image responses say `no-store` however they send their headers, so an image replaced
// under the same name is asked for again, while every other response keeps the headers it chose. (What a stored,
// revalidated copy does in Chromium is previewImageShared.test.js.)
// Method: the plugin's own middleware runs on a real node:http server, and a handler behind it answers the way Astro
// does (writeHead with a year-long Cache-Control) and in each other way Node allows; the headers are read off the wire.
// The route matching is checked with a base path, a trailing slash and a configured endpoint, and with the addresses
// it must leave alone. Then the config for the servers without the canvas's own is written into a temporary project
// and loaded by Node, which proves it keeps the project's settings and plugins and loads the real plugin file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { forbidStoring, imageRoutesOf, isImageRequest, previewImageCachePlugin } from '#dist/electron/previewServer/previewImageCache.js';
import { imageCacheConfigArgs, renderImageCacheConfig } from '#dist/electron/preview/imageCacheConfig.js';

const YEAR = 'public, max-age=31536000';

// A null as it reaches the plugin: out of the project's own config.
const NULL_FROM_JSON: unknown = JSON.parse('null');

/** One property of a value a generated module exported. */
function child(value: unknown, key: string): unknown {
  assert.ok(typeof value === 'object' && value !== null, `an object holds ${key}`);
  return Reflect.get(value, key);
}

type Answer = (response: http.ServerResponse) => void;

/** The headers `answer` puts on the wire for `url`, behind the plugin's middleware. */
async function headersFor(url: string, answer: Answer, image?: unknown, destination?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  let middleware: ((request: http.IncomingMessage, response: http.ServerResponse, next: () => void) => void) | undefined;
  previewImageCachePlugin(image).configureServer({ middlewares: { use: (handler) => (middleware = handler) } });
  const server = http.createServer((request, response) => {
    assert.ok(middleware, 'the plugin registers its middleware');
    middleware(request, response, () => answer(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(typeof address === 'object' && address !== null);
    return await new Promise((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: address.port, path: url, agent: false, headers: destination === undefined ? {} : { 'sec-fetch-dest': destination } },
          (reply) => {
            reply.resume();
            reply.on('end', () => resolve({ status: reply.statusCode ?? 0, headers: reply.headers }));
          },
        )
        .on('error', reject);
    });
  } finally {
    server.close();
  }
}

const ANSWERS: ReadonlyArray<readonly [string, Answer]> = [
  [
    'writeHead with an object, as Astro does',
    (response) => response.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': YEAR, ETag: '"abc"' }).end('x'),
  ],
  [
    'writeHead with a status message',
    (response) => response.writeHead(200, 'Fine', { 'Content-Type': 'image/webp', 'cache-control': YEAR, ETag: '"abc"' }).end('x'),
  ],
  ['writeHead with a flat list', (response) => response.writeHead(200, ['Content-Type', 'image/webp', 'CACHE-CONTROL', YEAR, 'ETag', '"abc"']).end('x')],
  [
    'setHeader then end',
    (response) => {
      response.setHeader('Content-Type', 'image/webp');
      response.setHeader('Cache-Control', YEAR);
      response.setHeader('ETag', '"abc"');
      response.end('x');
    },
  ],
  [
    'no cache header at all',
    (response) => {
      response.setHeader('ETag', '"abc"');
      response.setHeader('Content-Type', 'image/webp');
      response.write('x');
      response.end();
    },
  ],
];

for (const [name, answer] of ANSWERS) {
  test(`an image answered by ${name} goes out with no-store and keeps its ETag`, async () => {
    const reply = await headersFor('/_image?href=%2Fa.png', answer);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['etag'], '"abc"');
    assert.equal(reply.headers['content-type'], 'image/webp');
  });
}

test('a repeated header in a flat list keeps every value', async () => {
  const reply = await headersFor('/_image', (response) => response.writeHead(200, ['Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'Cache-Control', YEAR]).end());
  assert.deepEqual(reply.headers['set-cookie'], ['a=1', 'b=2']);
  assert.equal(reply.headers['cache-control'], 'no-store');
});

test('every other response keeps the cache header it chose', async () => {
  for (const url of ['/', '/node_modules/.vite/deps/react.js?v=1a2b', '/images/photo.png', '/_images', '/_image/photo', '/a?next=/_image']) {
    const reply = await headersFor(url, (response) => response.writeHead(200, { 'Cache-Control': 'max-age=31536000,immutable' }).end());
    assert.equal(reply.headers['cache-control'], 'max-age=31536000,immutable', url);
  }
});

test('whatever the browser asks for as an image is not stored, public and source files too', async () => {
  for (const url of ['/images/photo.png', '/src/assets/photo.svg', '/@fs/site/photo.png?v=1']) {
    const image = await headersFor(url, (response) => response.writeHead(200, { 'Cache-Control': 'no-cache' }).end(), undefined, 'image');
    assert.equal(image.headers['cache-control'], 'no-store', url);
    const script = await headersFor(url, (response) => response.writeHead(200, { 'Cache-Control': 'no-cache' }).end(), undefined, 'script');
    assert.equal(script.headers['cache-control'], 'no-cache', url);
  }
});

test('the endpoint is found under a base path, with a trailing slash and at a configured route', async () => {
  for (const url of ['/_image', '/_image/', '/_image?href=a', '/docs/_image?href=a', '/a/b/_image/?w=1']) {
    assert.equal(isImageRequest(url, '/_image'), true, url);
  }
  for (const url of ['/', undefined, '/_imageset', '/x_image', '/_image.png']) {
    assert.equal(isImageRequest(url, '/_image'), false, String(url));
  }
  const reply = await headersFor('/docs/_pictures?href=a', (response) => response.writeHead(200, { 'Cache-Control': YEAR }).end(), {
    endpoint: { route: '/_pictures' },
  });
  assert.equal(reply.headers['cache-control'], 'no-store');
});

test('the routes are read from the project config without trusting its shape', () => {
  for (const image of [
    undefined,
    3,
    'x',
    {},
    { endpoint: NULL_FROM_JSON },
    { endpoint: { route: 4 } },
    { endpoint: { route: '/' } },
    { endpoint: { route: '' } },
  ]) {
    assert.deepEqual(imageRoutesOf(image), ['/_image'], JSON.stringify(image));
  }
  assert.deepEqual(imageRoutesOf({ endpoint: { route: 'pictures/' } }), ['/_image', '/pictures']);
  assert.deepEqual(imageRoutesOf({ endpoint: { route: '/_image' } }), ['/_image']);
});

test('the plugin runs in the dev server only, ahead of what serves the request', () => {
  const plugin = previewImageCachePlugin(undefined);
  assert.equal(plugin.apply, 'serve');
  assert.equal(plugin.enforce, 'pre');
});

test('replacing writeHead keeps it returning the response', () => {
  const response = new http.ServerResponse(new http.IncomingMessage(new net.Socket()));
  forbidStoring(response);
  assert.equal(response.writeHead(204), response);
  assert.equal(response.getHeader('cache-control'), 'no-store');
});

test('a server without the canvas config gets the project config plus the image plugin', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-image-cache-config-'));
  try {
    const own = "export default { base: '/docs', vite: { server: { fs: {} }, plugins: [{ name: 'own' }] } };\n";
    fs.writeFileSync(path.join(project, 'astro.config.mjs'), own);
    const args = imageCacheConfigArgs(project);
    assert.equal(args[0], '--config');
    const relative = args[1];
    assert.ok(relative !== undefined && relative.startsWith('node_modules/.avb/'), 'the config is relative and out of the way');
    const loaded: unknown = await import(pathToFileURL(path.join(project, relative)).href);
    const config = child(loaded, 'default');
    assert.equal(child(config, 'base'), '/docs');
    assert.deepEqual(child(child(config, 'vite'), 'server'), { fs: {} });
    const plugins = child(child(config, 'vite'), 'plugins');
    assert.ok(Array.isArray(plugins), 'the config lists its plugins');
    assert.deepEqual(
      plugins.map((plugin: unknown) => child(plugin, 'name')),
      ['stacki-preview-image-cache', 'own'],
    );
    assert.equal(fs.readFileSync(path.join(project, 'astro.config.mjs'), 'utf8'), own, 'the project config is not written');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a project with no config file gets one with the plugin alone', () => {
  const source = renderImageCacheConfig(undefined, '/app/previewImageCache.js');
  assert.match(source, /const userConfig = \{\};/);
  assert.match(source, /previewImageCachePlugin\(base\.image\)/);
});

test('a project whose folder cannot take the config runs on its own', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-image-cache-none-'));
  try {
    fs.writeFileSync(path.join(folder, 'node_modules'), 'a file, so no folder can be made under it');
    assert.deepEqual(imageCacheConfigArgs(folder), []);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
