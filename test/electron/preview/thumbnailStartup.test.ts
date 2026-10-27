// Goal: opening a project cancels its competing thumbnail startup, including
// work waiting for a port. Mock project discovery and run a disposable child
// process so cancellation proves that a real process group is stopped.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { Thumbnails } from '#dist/electron/handlers/thumbnails.js';
import nodeTools from '#dist/electron/lib/nodeTools.js';
import projectFiles from '#dist/electron/project/projectFiles.js';
import serverChecks from '#dist/electron/preview/devServerChecks.js';

test('opening a project cancels active and queued thumbnail startups', async (context) => {
  context.mock.method(projectFiles, 'hasDependencies', () => true);
  context.mock.method(nodeTools, 'findFreePort', async () => 54321);
  context.mock.method(serverChecks, 'serverAlive', async () => false);
  const children: ReturnType<typeof spawn>[] = [];
  const launches: (readonly string[])[] = [];
  let announce: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  context.mock.method(
    nodeTools,
    'spawnAstroServer',
    (_project: string, _binary: string, argumentsList: readonly string[]) => {
      launches.push(argumentsList);
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      announce();
      return child;
    },
  );
  context.after(() => {
    for (const child of children) {
      nodeTools.stopProcessTree(child);
    }
  });
  const thumbnails = new Thumbnails({
    devServers: { current: () => undefined },
    userDataPath: () => '/unused',
  });
  const active = thumbnails.capture('/project');
  const queued = thumbnails.capture('/another');
  await started;
  const child = children[0];
  assert.ok(child);
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  thumbnails.noteProjectOpened();
  await exited;
  assert.deepEqual(await active, { ok: false, error: 'skipped' });
  assert.deepEqual(await queued, { ok: false, error: 'skipped' });
  assert.equal(launches.length, 1);
  assert.ok(launches[0]?.includes('--ignore-lock'));
});

test('closing during thumbnail port lookup prevents server startup', async (context) => {
  context.mock.method(projectFiles, 'hasDependencies', () => true);
  let release: (port: number) => void = () => {};
  let announce: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const port = new Promise<number>((resolve) => {
    release = resolve;
  });
  context.mock.method(nodeTools, 'findFreePort', () => {
    announce();
    return port;
  });
  const spawned = context.mock.method(nodeTools, 'spawnAstroServer', () => {
    throw new Error('A cancelled thumbnail must not start a server');
  });
  const thumbnails = new Thumbnails({
    devServers: { current: () => undefined },
    userDataPath: () => '/unused',
  });
  const active = thumbnails.capture('/project');
  await started;
  thumbnails.stop();
  release(54321);
  assert.deepEqual(await active, { ok: false, error: 'skipped' });
  assert.equal(spawned.mock.callCount(), 0);
});
