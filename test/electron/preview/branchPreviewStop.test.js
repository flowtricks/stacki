// Goal: Git cannot rewrite watched files while an owned preview is still stopping.
// Method: exercise DevServers.pause with a real delayed-exit child and a temporary
// daemon CLI; the external-server case proves that unowned processes are untouched.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DevServers } = require('#dist/electron/handlers/devServers.js');
const { setToolPathHome } = require('#dist/electron/lib/nodeTools.js');
setToolPathHome(os.homedir());

test('pause waits for an owned process to exit', async (context) => {
  const servers = new DevServers({ send() {} });
  const child = spawn(
    process.execPath,
    ['-e', ['process.on("SIGTERM", () => setTimeout(() => process.exit(0), 75));', 'setInterval(() => {}, 1000); process.stdout.write("ready");'].join('\n')],
    { detached: process.platform !== 'win32' },
  );
  context.after(() => child.kill());
  await once(child.stdout, 'data');
  servers.server = { proc: child, url: 'http://127.0.0.1:4321', projectPath: os.tmpdir() };
  const stopped = once(child, 'exit');
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  await servers.pause();
  assert.equal(exited, true, 'The caller may switch files only after the watcher exits');
  assert.equal(servers.current(), undefined);
  await stopped;
  await servers.pause();
});

test('pause awaits daemon stop and leaves external servers alone', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-pause-preview-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'astro.mjs');
  await fs.writeFile(
    bin,
    ['import {writeFileSync} from "node:fs";', 'setTimeout(() => writeFileSync("stopped.txt", process.argv.slice(2).join(" ")), 75);'].join('\n'),
  );
  const servers = new DevServers({ send() {} });
  servers.server = {
    proc: undefined,
    url: 'http://127.0.0.1:4321',
    projectPath: directory,
    daemon: true,
    bin,
  };
  await servers.pause();
  assert.equal(await fs.readFile(path.join(directory, 'stopped.txt'), 'utf8'), 'dev stop');
  assert.equal(servers.current(), undefined);
  servers.server = {
    proc: undefined,
    url: 'http://127.0.0.1:4321',
    projectPath: directory,
    external: true,
  };
  await servers.pause();
  assert.equal(servers.current(), undefined);
});

test('a daemon stop error prevents checkout from proceeding', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-pause-refusal-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'astro.mjs');
  await fs.writeFile(bin, 'process.exit(1);');
  const servers = new DevServers({ send() {} });
  servers.server = {
    proc: undefined,
    url: 'http://127.0.0.1:4321',
    projectPath: directory,
    daemon: true,
    bin,
  };
  await assert.rejects(servers.pause());
  assert.ok(servers.current(), 'The existing server remains recorded after a stop refusal');
});
