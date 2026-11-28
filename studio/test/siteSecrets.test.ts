// Goal: the Worker's container token and the viewer's session never reach the site's own routes. The Worker adds both
// to every request it forwards, preview pages included, and a site endpoint that read the token could ask the Worker's
// internal routes for the repository connection. Studio's own routes still receive them.
// Method: serve the real integration from a real Vite server, with a stand-in site route behind it that records the
// headers it is given, and send a request as the Worker forwards one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createNetServer } from 'node:net';
import { get, type IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Plugin } from 'vite';
import studio from '../src/server/integration';

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

const status = (port: number, route: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    get({ host: '127.0.0.1', port, path: route, headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    }).on('error', reject);
  });

test('site routes never see the container token or the session; Studio routes still require the token', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-site-secrets-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const port = await freePort();
  const integration = studio({ root, assets: root, port });
  const plugins: unknown[] = [];
  const setup: unknown = Reflect.get(integration.hooks, 'astro:config:setup');
  assert.ok(typeof setup === 'function');
  await Reflect.apply(setup, integration.hooks, [
    {
      command: 'dev',
      config: { trailingSlash: 'ignore' },
      addMiddleware: () => {},
      injectRoute: () => {},
      updateConfig: (update: { readonly vite: { readonly plugins: readonly unknown[] } }) => plugins.push(...update.vite.plugins),
    },
  ]);
  const seen: { headers: IncomingHttpHeaders; raw: readonly string[] }[] = [];
  const site: Plugin = {
    name: 'site-stand-in',
    configureServer(server) {
      return () =>
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/api/echo')) {
            next();
            return;
          }
          seen.push({ headers: { ...request.headers }, raw: [...request.rawHeaders] });
          response.end('{}');
        });
    },
  };
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { host: '127.0.0.1', port, strictPort: true },
    plugins: [...(plugins as Plugin[]), site],
  });
  process.env['STUDIO_CONTAINER_TOKEN'] = 'the-container-token';
  context.after(async () => {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await server.listen();
  const forwarded = {
    'x-studio-token': 'the-container-token',
    'x-studio-session': 'the-viewer-session',
    'X-Studio-User': 'acme',
    'x-site-header': 'kept',
  };
  assert.equal(await status(port, '/api/echo', forwarded), 200);
  const [request] = seen;
  assert.ok(request, 'The site route ran');
  assert.equal(request.headers['x-site-header'], 'kept');
  const everything = JSON.stringify(request);
  assert.ok(!everything.includes('the-container-token'), everything);
  assert.ok(!everything.includes('the-viewer-session'), everything);
  assert.equal(await status(port, '/studio/api/session', forwarded), 200);
  assert.equal(await status(port, '/studio/api/session', { 'x-studio-token': 'wrong' }), 403);
});
