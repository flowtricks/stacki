// Goal: every Studio feature keeps working after the dev server restarts, as it does when a pull
// rewrites a file the server watches (issue #104: CMS requests failed for good afterwards).
// Method: serve the real integration from a real Vite server on a throwaway project and restart it,
// so the old HTTP server really closes and a new one listens. A stand-in plugin does the two things
// Astro does around Studio: it calls `astro:server:setup`, and it puts its route policy ahead of
// other middleware. `astro:server:start` is called once, as Astro calls it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Plugin } from 'vite';
import { WebSocket } from 'ws';
import studio, { studioRuntime } from '../src/server/integration';

const PAGE = 'src/pages/index.astro';
/** Whether the stand-in puts a route policy ahead of Studio, as Astro does. */
type Routing = 'open' | 'site-routes-first';

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-restart-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await mkdir(path.join(root, 'src/data'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, PAGE), '<h1>Home</h1>\n');
  await writeFile(path.join(root, 'src/data/items.json'), '[{"id":"a"}]');
  return root;
}

async function integrationPlugins(root: string, port: number, routing: Routing) {
  const integration = studio({ root, assets: root, port });
  const hook = (name: string, value: object) => {
    const run: unknown = Reflect.get(integration.hooks, name);
    assert.ok(typeof run === 'function', name);
    return Reflect.apply(run, integration.hooks, [value]) as unknown;
  };
  const plugins: unknown[] = [];
  await hook('astro:config:setup', {
    command: 'dev',
    config: { trailingSlash: 'ignore' },
    addMiddleware: () => {},
    injectRoute: () => {},
    updateConfig: (update: { readonly vite: { readonly plugins: readonly unknown[] } }) => plugins.push(...update.vite.plugins),
  });
  const astro: Plugin = {
    name: 'astro-stand-in',
    configureServer(server) {
      hook('astro:server:setup', { server });
      if (routing === 'open') {
        return undefined;
      }
      return () => {
        server.middlewares.stack.unshift({
          route: '',
          handle: function routePolicy(_request: unknown, response: { statusCode: number; end: (body: string) => void }) {
            response.statusCode = 404;
            response.end('The site has no such route');
          },
        });
      };
    },
  };
  return { plugins: [...(plugins as Plugin[]), astro], started: () => hook('astro:server:start', {}) };
}

async function startStudio(root: string, routing: Routing = 'open') {
  const port = await freePort();
  const { plugins, started } = await integrationPlugins(root, port, routing);
  const server = await createServer({
    configFile: false,
    root,
    plugins,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { port, strictPort: true, host: '127.0.0.1' },
  });
  await server.listen();
  started();
  const origin = `127.0.0.1:${port}`;
  const cms = async () => {
    const response = await fetch(`http://${origin}/studio/api/cms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ operation: 'cms:list', payload: '' }),
    });
    return { status: response.status, body: await response.text() };
  };
  /** Opens the page's collaboration socket and waits for its first document sync. */
  const connect = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://${origin}/studio/sync?file=${encodeURIComponent(PAGE)}`);
      const timer = setTimeout(() => reject(new Error('The document never synchronized')), 10_000);
      socket.once('error', reject);
      socket.on('message', (bytes) => {
        if (String(bytes).includes('"type":"sync"')) {
          clearTimeout(timer);
          resolve(socket);
        }
      });
    });
  return { server, cms, connect, origin };
}

test('collections and live editing survive repeated dev server restarts', async () => {
  const root = await project();
  const running = await startStudio(root);
  try {
    const before = await running.cms();
    assert.equal(before.status, 200, before.body);
    for (let restart = 1; restart <= 2; restart++) {
      const open = await running.connect();
      const closed = new Promise<void>((resolve) => open.once('close', () => resolve()));
      await running.server.restart();
      await closed;
      const after = await running.cms();
      assert.equal(after.status, 200, `restart ${restart}: ${after.body}`);
      assert.match(after.body, /items\.json/);
      const reopened = await running.connect();
      reopened.close();
    }
  } finally {
    await running.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Studio requests stay ahead of the site routes after a restart', async () => {
  const root = await project();
  const running = await startStudio(root, 'site-routes-first');
  try {
    assert.equal((await running.cms()).status, 200);
    await running.server.restart();
    const after = await running.cms();
    assert.equal(after.status, 200, after.body);
  } finally {
    await running.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a collection read after a restart sees files changed while the server was away', async () => {
  const root = await project();
  const running = await startStudio(root);
  try {
    assert.match((await running.cms()).body, /"id":"a"/);
    await writeFile(path.join(root, 'src/data/items.json'), '[{"id":"pulled"}]');
    await running.server.restart();
    const after = await running.cms();
    assert.equal(after.status, 200, after.body);
    assert.match(after.body, /pulled/);
  } finally {
    await running.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a second evaluation of the config runs the first copy and shares its workspace', () => {
  const root = path.join(tmpdir(), 'studio-restart-shared');
  assert.equal(studioRuntime(root), studioRuntime(root));
  assert.notEqual(studioRuntime(root), studioRuntime(root + '-other'));
  const first = globalThis.stackiStudioIntegration;
  assert.ok(first, 'The first copy registered itself');
  // A later copy finds the registered one and hands over, whatever its own code is.
  const sentinel = { name: 'first-copy', hooks: {} };
  globalThis.stackiStudioIntegration = () => sentinel;
  try {
    assert.equal(studio({ root, assets: root, port: 1 }), sentinel);
  } finally {
    globalThis.stackiStudioIntegration = first;
  }
});
