// Goal: Studio's authenticated API works with every Astro trailing-slash policy.
// Method: start real Astro servers against isolated sites and exercise reads, writes and origin checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dev } from 'astro';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import studio from '../src/server/integration';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function preparePackage(root: string): Promise<string> {
  const directory = path.join(root, 'node_modules/@example/kit/components');
  await mkdir(directory, { recursive: true });
  await symlink(path.resolve('node_modules/astro'), path.join(root, 'node_modules/astro'));
  await mkdir(path.join(root, '.stacki'), { recursive: true });
  await writeFile(path.join(directory, 'Button.astro'), '<button>Package preview</button>');
  await writeFile(
    path.join(root, '.stacki/component-sources.json'),
    JSON.stringify({
      version: 1,
      sources: [
        {
          kind: 'package',
          package: '@example/kit',
          directory: 'components',
          importPrefix: '@/components/',
        },
      ],
    }),
  );
  return directory;
}

async function prepareAssets(root: string): Promise<string> {
  const assets = path.join(root, '.studio-assets');
  // Fresh checkouts have no dist directory; build the real middleware this test exercises.
  await build({
    entryPoints: [
      'src/features/preview/previewMiddleware.ts',
      'src/features/preview/variantRuntime.ts',
    ],
    outdir: assets,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  return assets;
}

test(
  'Studio API bypasses site slash policy without changing page routing',
  { timeout: 90000 },
  async (context) => {
    for (const trailingSlash of ['always', 'never', 'ignore'] as const) {
      await context.test(trailingSlash, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'stacki-slashes-'));
        const port = await availablePort();
        await mkdir(path.join(root, 'src/pages'), { recursive: true });
        await mkdir(path.join(root, '.stacki/studio/state'), { recursive: true });
        await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
        await writeFile(path.join(root, 'src/pages/about.astro'), '<h1>About</h1>');
        const componentDirectory = await preparePackage(root);
        const assets = await prepareAssets(root);
        const server = await dev({
          root,
          configFile: false,
          logLevel: 'silent',
          trailingSlash,
          server: { port, host: '127.0.0.1' },
          vite: {
            server: { strictPort: true },
            resolve: { alias: { '@/components': componentDirectory } },
          },
          integrations: [studio({ root, assets, port })],
        });
        try {
          // Authentication uses this port; a silent Vite fallback would test the wrong server.
          assert.equal(server.address.port, port);
          const origin = `http://127.0.0.1:${port}`;
          const project = await fetch(origin + '/studio/api/project').catch((failure: unknown) => {
            const cause = failure instanceof Error ? String(failure.cause) : String(failure);
            assert.fail(`Studio API connection failed at ${origin}: ${cause}`);
          });
          assert.equal(project.status, 200);
          assert.match(project.headers.get('content-type') ?? '', /application\/json/);
          const denied = await fetch(origin + '/studio/api/project', {
            headers: { Origin: 'https://untrusted.example' },
          });
          assert.equal(denied.status, 403);
          const preview = await fetch(
            origin + '/__avb/preview?p=node_modules/@example/kit/components/Button.astro',
          );
          const previewHTML = await preview.text();
          assert.equal(preview.status, 200, previewHTML);
          assert.match(previewHTML, /Package preview/);
          const metadata = await fetch(origin + '/studio/api/metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind: 'componentSources',
              base: await readFile(path.join(root, '.stacki/component-sources.json'), 'utf8'),
              source: '{"version":1,"sources":[]}',
            }),
          });
          assert.equal(metadata.status, 200, await metadata.text());
          if (trailingSlash === 'always') {
            assert.equal((await fetch(origin + '/about', { redirect: 'manual' })).status, 404);
          }
          if (trailingSlash === 'never') {
            assert.equal((await fetch(origin + '/about/', { redirect: 'manual' })).status, 404);
          }
        } finally {
          await server.stop();
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  },
);
