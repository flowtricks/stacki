// Goal: a collection added while the preview runs can be read. Astro loads
// src/content.config.* once, at startup, so a config that appears later (the
// CMS's first collection, or one written by hand) is never loaded: its
// collections read as empty, the data picker said "Reading one entry…"
// forever, and the content-sync hook could not help, since it re-syncs the
// config the server already has. DevServers restarts such a server once, on the
// same address, and never for a server that started with its config.
// Method: a DevServers whose process work (pause, start) is replaced by
// recorders, over a temporary project; the restart decision is driven through
// every case: no server, another address, an external server, a server that
// started with the config, one whose project still has none, the stale one
// (restarted, then never again), and a restart that comes back elsewhere.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DevServers } = require('#dist/electron/handlers/devServers.js');

const URL = 'http://127.0.0.1:48781';

function project(context, { withConfig }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-content-restart-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  if (withConfig) {
    addConfig(root);
  }
  return root;
}

function addConfig(root) {
  fs.writeFileSync(path.join(root, 'src/content.config.ts'), 'export const collections = {};\n');
}

// A DevServers whose server is `server`, started with or without a config, and
// whose restart records what it did and answers at `restartUrl`.
function servers(server, { configAtStart, restartUrl = URL }) {
  const sent = [];
  const calls = [];
  const instance = new DevServers({ send: (channel, payload) => sent.push({ channel, payload }) });
  instance.server = server;
  instance.contentConfigAtStart = server === undefined ? undefined : { url: server.url, present: configAtStart };
  instance.pause = async () => {
    calls.push('pause');
    instance.server = undefined;
  };
  instance.start = async (projectPath) => {
    calls.push('start');
    instance.server = { ...server, url: restartUrl };
    instance.contentConfigAtStart = { url: restartUrl, present: fs.existsSync(path.join(projectPath, 'src/content.config.ts')) };
    return { url: restartUrl };
  };
  instance.readTrailingSlash = () => 'ignore';
  return { instance, calls, sent };
}

const owned = (projectPath, url = URL) => ({ proc: undefined, daemon: true, bin: 'astro', url, projectPath });

test('a server that started before its content config restarts once, at the same address', async (context) => {
  const root = project(context, { withConfig: false });
  const { instance, calls, sent } = servers(owned(root), { configAtStart: false });
  addConfig(root); // The CMS's first collection, written while the preview runs.
  assert.equal(await instance.restartForNewContentConfig(URL), true);
  assert.deepEqual(calls, ['pause', 'start'], 'stopped, then started on the config');
  assert.equal(instance.current()?.url, URL);
  assert.deepEqual(
    sent.filter((message) => message.channel === 'dev:exit'),
    [],
    'the app is not told the preview went away',
  );
  assert.equal(await instance.restartForNewContentConfig(URL), false, 'and never again: it started with the config');
  assert.deepEqual(calls, ['pause', 'start']);
});

test('nothing restarts when there is nothing a restart would fix', async (context) => {
  const withConfig = project(context, { withConfig: true });
  const started = servers(owned(withConfig), { configAtStart: true });
  assert.equal(await started.instance.restartForNewContentConfig(URL), false, 'a server that started with its config');
  assert.deepEqual(started.calls, []);

  const none = project(context, { withConfig: false });
  const empty = servers(owned(none), { configAtStart: false });
  assert.equal(await empty.instance.restartForNewContentConfig(URL), false, 'a project that still has no config');
  assert.deepEqual(empty.calls, []);

  const later = project(context, { withConfig: false });
  const elsewhere = servers(owned(later), { configAtStart: false });
  addConfig(later);
  assert.equal(await elsewhere.instance.restartForNewContentConfig('http://127.0.0.1:1'), false, 'a URL that is not the running server');
  assert.deepEqual(elsewhere.calls, []);

  const external = servers({ proc: undefined, url: URL, projectPath: later, external: true }, { configAtStart: false });
  assert.equal(await external.instance.restartForNewContentConfig(URL), false, "the user's own server is never restarted");
  assert.deepEqual(external.calls, []);

  const stopped = servers(undefined, { configAtStart: false });
  assert.equal(await stopped.instance.restartForNewContentConfig(URL), false, 'no server at all');
  assert.deepEqual(stopped.calls, []);
});

test('a restart that comes back at another address tells the app the old one is gone', async (context) => {
  const root = project(context, { withConfig: false });
  const { instance, calls, sent } = servers(owned(root), { configAtStart: false, restartUrl: 'http://127.0.0.1:48782' });
  addConfig(root);
  assert.equal(await instance.restartForNewContentConfig(URL), false);
  assert.deepEqual(calls, ['pause', 'start']);
  const exits = sent.filter((message) => message.channel === 'dev:exit');
  assert.equal(exits.length, 1, 'the app hears the preview at the old address ended');
  assert.equal(typeof exits[0].payload.log, 'string');
});
