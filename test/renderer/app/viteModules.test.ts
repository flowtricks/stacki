// Goal: renderer startup dependencies must be browser ES modules in development.
// Production bundling and CommonJS test bundles can hide invalid named imports.
// Methodology: transform the real entry modules with Vite, then link and evaluate
// their complete shared dependency graph with the native ES module loader.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SourceTextModule } from 'node:vm';
import { createServer, type ViteDevServer } from 'vite';

// Includes publishing, project metadata, defaults-canvas, history and Feedback payload
// parsers. The complete current renderer contract graph contains 44 modules.
const MODULES_MAX = 44;
// Repository paths; the dev server serves each at `/<path>`.
const ENTRY_MODULES: ReadonlyArray<{ readonly file: string; readonly exportName: string }> = [
  { file: 'src/lib/cleanError.ts', exportName: 'cleanError' },
  { file: 'src/ipc/bridge.ts', exportName: 'scanProject' },
  { file: 'src/editor/dataSuggest.ts', exportName: 'dataTree' },
  { file: 'src/editor/loopBindings.ts', exportName: 'renamedLoopVar' },
  { file: 'src/editor/pagePersistence.ts', exportName: 'createPageSaver' },
];

test('Vite development modules link the renderer contract dependencies', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'stacki-vite-modules-'));
  const server = await createServer({
    cacheDir: cacheDirectory,
    // Vite's own API: `watch: null` turns the file watcher off, where undefined would
    // start the default one.
    // eslint-disable-next-line stacki/no-null -- Vite's documented value for "no watcher".
    server: { middlewareMode: true, hmr: false, watch: null },
    logLevel: 'silent',
  });
  try {
    const loadModule = createModuleLoader(server);
    for (const entry of ENTRY_MODULES) {
      const module = await loadModule(`/${entry.file}`);
      await module.link(loadModule);
      await module.evaluate({ timeout: 1_000, breakOnSigint: false });
      assert.equal(module.status, 'evaluated', `${entry.file} must run before React mounts`);
      const namespace: unknown = module.namespace;
      assert.ok(typeof namespace === 'object');
      assert.ok(namespace);
      const exported: unknown = Reflect.get(namespace, entry.exportName);
      assert.equal(typeof exported, 'function', `${entry.file} keeps its public API`);
    }
  } finally {
    await server.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

function createModuleLoader(server: ViteDevServer): (url: string) => Promise<SourceTextModule> {
  // One bounded cache preserves module identity when contract imports overlap.
  const modules = new Map<string, Promise<SourceTextModule>>();
  return (url) => {
    assert.match(url, /^\/(?:src|shared)\//, 'Only local renderer contracts belong to this graph');
    const existing = modules.get(url);
    if (existing) {
      return existing;
    }
    assert.ok(modules.size < MODULES_MAX, `Contract graph exceeds ${MODULES_MAX} modules`);
    const pending = createModuleLoaderTransform(server, url);
    modules.set(url, pending);
    return pending;
  };
}

async function createModuleLoaderTransform(
  server: ViteDevServer,
  url: string,
): Promise<SourceTextModule> {
  const transformed = await server.transformRequest(url);
  assert.ok(transformed, `Vite must serve ${url}`);
  assert.ok(transformed.code.length > 0, `${url} must contain executable JavaScript`);
  return new SourceTextModule(transformed.code, { identifier: url });
}
