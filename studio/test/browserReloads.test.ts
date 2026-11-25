// Goal: canvas patches must preserve Vite's server-side module invalidation.
// Method: run a real Vite module runner, change a virtual module, and deliver a
// server reload. Browser reloads still request a patch instead of navigation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer, isRunnableDevEnvironment } from 'vite';
import { interceptBrowserReloads } from '../src/features/preview/browserReloads';

test('browser patches leave server module reloads intact', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-module-reload-'));
  let version = 1;
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, watch: null, hmr: { port: 0 } },
    plugins: [
      {
        name: 'reload-fixture',
        resolveId: (id) => (id === 'virtual:reload' ? '\0virtual:reload' : undefined),
        load: (id) =>
          id === '\0virtual:reload'
            ? `
        export const version = ${version};
        export const reloads = { count: 0 };
        import.meta.hot.on('vite:beforeFullReload', () => { reloads.count++; });
      `
            : undefined,
      },
    ],
  });
  try {
    let patches = 0;
    interceptBrowserReloads(server, () => {
      patches++;
    });
    const environment = server.environments['ssr'];
    assert.ok(environment && isRunnableDevEnvironment(environment));
    const initial: unknown = await environment.runner.import('virtual:reload');
    assert.ok(typeof initial === 'object' && initial !== null && 'version' in initial);
    assert.equal(initial.version, 1);
    assert.ok('reloads' in initial);
    const reloads = initial.reloads;
    assert.ok(typeof reloads === 'object' && reloads !== null && 'count' in reloads);
    version = 2;
    environment.moduleGraph.invalidateAll();
    environment.hot.send({ type: 'full-reload', path: '*' });
    let current: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      current = await environment.runner.import('virtual:reload');
      if (typeof current === 'object' && current !== null && 'version' in current) {
        if (current.version === 2) {
          break;
        }
      }
      await setTimeout(10);
    }
    assert.ok(typeof current === 'object' && current !== null && 'version' in current);
    assert.equal(current.version, 2);
    assert.equal(reloads.count, 1, 'The module runner receives its reload lifecycle event');
    assert.equal(patches, 0, 'Internal reloads do not trigger competing canvas renders');
    server.ws.send({ type: 'full-reload', path: '*' });
    assert.equal(patches, 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
