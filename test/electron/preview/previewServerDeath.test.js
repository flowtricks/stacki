// Goal: a dev server that dies or hangs is noticed and replaced, and stopping ours never stops someone else's.
// The blank canvas that no refresh could bring back came from this: Astro >= 7 forks a detached server when the
// environment shows an AI agent, nothing heard that one exit, and `dev:start` went on answering with its address.
//
// Method: the real DevServers over a temporary CLI that serves HTTP (as in startupExit.test.js). The servers here
// really die: the held record names an address nothing listens on. The detached case is a record with no process,
// with the project's .astro/dev.json written by hand to name our port or another's, and a CLI that records whether
// `dev stop` was run. The environment the CLI is started with is written to a file by the CLI itself. A slow `dev stop`
// shows whether the replacement waits for it.
//
// Cleanup is one hook: first the processes, then their folder. Node skips the hooks after one that throws, and Windows
// refuses to remove the folder a live process works in; as two hooks, the removal failed there, the server was never
// stopped, and the suite sat until the runner killed it.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DevServers } = require('#dist/electron/handlers/devServers.js');
const { setToolPathHome } = require('#dist/electron/lib/nodeTools.js');
setToolPathHome(os.homedir());

const ended = (child) => child.exitCode !== null || child.signalCode !== null;

// `dev stop` takes this long, as a CLI on a busy machine does, before it says it has run.
function fixture(context, { stopDelayMs = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-server-death-'));
  const bin = path.join(directory, 'astro.mjs');
  fs.writeFileSync(
    bin,
    [
      'import {existsSync, writeFileSync} from "node:fs";',
      'import {createServer} from "node:http";',
      'if (process.argv.includes("logs")) process.exit(0);',
      `if (process.argv.includes("stop")) { setTimeout(() => { writeFileSync("stopped", "yes"); process.exit(0); }, ${stopDelayMs}); } else {`,
      'writeFileSync("environment", String(process.env.ASTRO_DEV_BACKGROUND));',
      'writeFileSync("stopped-at-start", String(existsSync("stopped")));',
      'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
      'createServer((request, response) => response.end("ready")).listen(port, "127.0.0.1");',
      '}',
    ].join('\n'),
  );
  const events = [];
  const servers = new DevServers({ send: (channel, payload) => events.push({ channel, payload }) });
  servers.installedBin = async () => bin;
  context.after(async () => {
    const child = servers.current()?.proc;
    try {
      // Waits, with a bound of its own, for the server (or the `dev stop` of a detached one) to end.
      await servers.pause();
    } catch (error) {
      child?.kill('SIGKILL');
      throw error;
    }
    assert.ok(child === undefined || ended(child), 'the server ended before its folder is removed');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, bin, events, servers };
}

const answers = (url) =>
  fetch(url).then(
    () => true,
    () => false,
  );

test('the server is told to stay in the foreground, whatever the environment says', async (context) => {
  const { directory, servers } = fixture(context);
  await servers.start(directory, () => {});
  assert.equal(fs.readFileSync(path.join(directory, 'environment'), 'utf8'), '1');
});

test('a held server nothing answers for is replaced; a live one is answered with again', async (context) => {
  const { directory, bin, servers } = fixture(context);
  const first = await servers.start(directory, () => {});
  assert.deepEqual(await servers.start(directory, () => {}), { url: first.url }, 'a live server is not restarted');
  const running = servers.current().proc;
  // A detached server that died: no process to hear from, and nothing on its port.
  await servers.pause();
  assert.ok(ended(running), 'the first server ended');
  servers.server = { proc: undefined, daemon: true, bin, url: 'http://127.0.0.1:9', projectPath: directory };
  const again = await servers.start(directory, () => {});
  assert.notEqual(again.url, 'http://127.0.0.1:9');
  assert.equal(await answers(again.url), true, 'a server that answers');
});

test('a detached server that stopped answering is stopped before its replacement starts', async (context) => {
  // Left running beside the start, a slow `astro dev stop` reads the lock the replacement wrote and ends that one.
  const { directory, bin, servers } = fixture(context, { stopDelayMs: 2000 });
  servers.server = { proc: undefined, daemon: true, bin, url: 'http://127.0.0.1:9', projectPath: directory };
  await servers.start(directory, () => {});
  assert.equal(fs.readFileSync(path.join(directory, 'stopped-at-start'), 'utf8'), 'true');
});

test('stopping a detached server never runs `astro dev stop` against a server the lock gives to someone else', async (context) => {
  const { directory, bin, servers } = fixture(context);
  const lock = (url) => {
    fs.mkdirSync(path.join(directory, '.astro'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.astro', 'dev.json'), JSON.stringify({ url }));
  };
  const ours = { proc: undefined, daemon: true, bin, url: 'http://127.0.0.1:48781', projectPath: directory };
  const stopped = () => fs.existsSync(path.join(directory, 'stopped'));
  // Another app replaced ours: the lock names its server.
  lock('http://localhost:48782');
  servers.server = ours;
  await servers.pause();
  assert.equal(stopped(), false, "someone else's server is left running");
  lock('http://localhost:48781');
  servers.server = ours;
  await servers.pause();
  assert.equal(stopped(), true, 'ours is stopped');
});
