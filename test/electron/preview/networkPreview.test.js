// Goal: the preview opens on the local network only when asked, for this run of the app only, and the
// canvas never notices: off by default; on restarts the dev server with --host 0.0.0.0 and off with
// 127.0.0.1; the app's own address stays loopback; the generated config names allowed hosts only in
// network mode; closing the project (stop) turns it off; a failed restart ends off, restarted on
// loopback, with a failure the renderer turns into a toast; and a change never takes more than two restarts.
// Letting in only the devices that scan the code is an option of the network mode: it restarts the server
// with a new random key in its environment (and nowhere else), each time it is turned on, and the key goes
// with the mode when the preview goes back to this computer or the project closes.
// Method: the pure parts (devServerArgs, devServerURL, networkAllowedHosts) are called directly, and the
// generated config is written by writeMarkerConfig into a temporary project and read back as text. The
// lifecycle runs on a DevServers whose process work (pause, start) is replaced by recorders that note the
// mode each start would spawn in, as contentConfigRestart.test.js does; network interfaces are passed in
// as tables, so the answer never depends on the machine running the test.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DevServers, startProjectPreview } = require('#dist/electron/handlers/devServers.js');
const { devServerArgs, devServerURL, networkAllowedHosts } = require('#dist/electron/preview/devServerArgs.js');

const URL = 'http://127.0.0.1:48781';
const WIFI = { lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], en0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }] };
const OFFLINE = { lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };

test('the command line: one --host, loopback by default, every interface in network mode', () => {
  assert.deepEqual(devServerArgs({ port: 48781, mode: 'local', configPath: 'node_modules/.avb/astro.config.mjs', force: false }), [
    'dev',
    '--port',
    '48781',
    '--host',
    '127.0.0.1',
    '--config',
    'node_modules/.avb/astro.config.mjs',
  ]);
  assert.deepEqual(devServerArgs({ port: 48781, mode: 'network', configPath: undefined, force: true }), [
    'dev',
    '--port',
    '48781',
    '--host',
    '0.0.0.0',
    '--force',
  ]);
  assert.throws(() => devServerArgs({ port: 0, mode: 'local', configPath: undefined, force: false }), /port is positive/);
  assert.throws(() => devServerArgs({ port: 70000, mode: 'local', configPath: undefined, force: false }), /at most 65535/);
  assert.throws(() => devServerArgs({ port: 1, mode: 'local', configPath: '/abs/config.mjs', force: false }), /relative to the project/);
});

test('the app reaches the server on loopback in every mode', () => {
  assert.equal(devServerURL(48781), URL);
  assert.deepEqual(networkAllowedHosts(['192.168.1.23', '10.0.0.5', '192.168.1.23']), ['localhost', '127.0.0.1', '192.168.1.23', '10.0.0.5']);
});

function project(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-network-preview-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'astro.config.mjs'), 'export default {};\n');
  return root;
}

test('the generated config names allowed hosts in network mode only, and guards Stacki routes in both', (context) => {
  const root = project(context);
  const servers = new DevServers({ send() {} });
  const localConfig = fs.readFileSync(servers.writeMarkerConfig(root), 'utf8');
  assert.match(localConfig, /const AVB_NETWORK_HOSTS = null;/);
  assert.match(localConfig, /plugins: \[avbLoopbackGuard, /, 'the guard is the first plugin');
  const networkConfig = fs.readFileSync(servers.writeMarkerConfig(root, ['localhost', '127.0.0.1', '192.168.1.23']), 'utf8');
  assert.match(networkConfig, /const AVB_NETWORK_HOSTS = \["localhost","127\.0\.0\.1","192\.168\.1\.23"\];/);
  assert.match(networkConfig, /plugins: \[avbLoopbackGuard, /);
  assert.doesNotMatch(networkConfig, /fs:\s*\{\s*strict:\s*false/, 'Vite fs.strict is never loosened');
  assert.doesNotMatch(localConfig, /fs:\s*\{/, 'nor is server.fs touched at all');
});

// A DevServers running `server`, whose restarts record the mode each start would spawn in and can be made to fail.
function servers(server, { failStarts = 0 } = {}) {
  const sent = [];
  const starts = [];
  let failuresLeft = failStarts;
  const instance = new DevServers({ send: (channel, payload) => sent.push({ channel, payload }) });
  instance.server = server;
  instance.pause = async () => {
    instance.server = undefined;
  };
  instance.start = async (projectPath) => {
    starts.push(instance.networkMode(projectPath));
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('Astro dev server did not start within 60 seconds.');
    }
    instance.server = { ...server, url: URL };
    return { url: URL };
  };
  instance.readTrailingSlash = () => 'ignore';
  return { instance, starts, sent };
}

const owned = (projectPath) => ({ proc: undefined, daemon: true, bin: 'astro', url: URL, projectPath });
// The requests the renderer sends (shared/ipc/devNetwork.ts), on the network to anyone unless `access` says otherwise.
const onNetwork = (projectPath, access = 'open') => ({ projectPath, mode: 'network', access });
const onComputer = (projectPath) => ({ projectPath, mode: 'local' });
const OPEN = { kind: 'open' };

test('off by default; on restarts with 0.0.0.0, off restarts with 127.0.0.1; the canvas address never moves', async (context) => {
  const root = project(context);
  const { instance, starts, sent } = servers(owned(root));
  assert.deepEqual(instance.networkState(root, WIFI), { kind: 'off' });
  assert.equal(instance.networkMode(root), 'local');
  const on = await instance.setNetwork(onNetwork(root), WIFI);
  assert.deepEqual(on, { ok: true, value: { kind: 'on', port: 48781, addresses: [{ address: '192.168.1.23', interfaceName: 'en0' }], access: OPEN } });
  assert.deepEqual(starts, ['network']);
  assert.equal(instance.current().url, URL, 'the canvas keeps its loopback address');
  assert.deepEqual(await instance.setNetwork(onNetwork(root), WIFI), on, 'asking again changes nothing');
  assert.deepEqual(starts, ['network'], 'and restarts nothing');
  const off = await instance.setNetwork(onComputer(root), WIFI);
  assert.deepEqual(off, { ok: true, value: { kind: 'off' } });
  assert.deepEqual(starts, ['network', 'local']);
  assert.equal(instance.current().url, URL);
  assert.deepEqual(
    sent.filter((message) => message.channel === 'dev:exit'),
    [],
    'the preview never went away',
  );
});

test('closing the project or quitting turns it off; a restart for another reason keeps it', async (context) => {
  const root = project(context);
  const { instance } = servers(owned(root));
  await instance.setNetwork(onNetwork(root), WIFI);
  await instance.pause(); // A branch switch: the same project starts again in the same mode.
  assert.equal(instance.networkMode(root), 'network');
  instance.stop(); // project:close, before-quit, window-all-closed
  assert.equal(instance.networkMode(root), 'local');
  assert.deepEqual(instance.networkState(root, WIFI), { kind: 'off' });
});

test('another project starts on this computer only', async (context) => {
  const root = project(context);
  const other = project(context);
  const { instance } = servers(owned(root));
  await instance.setNetwork(onNetwork(root), WIFI);
  assert.equal(instance.networkMode(other), 'local');
  // The real start, up to the point it would spawn: it clears the mode of the project it is not.
  const real = new DevServers({ send() {} });
  real.networkProject = root;
  real.installedBin = async () => {
    throw new Error('stopped before anything is installed or spawned');
  };
  await assert.rejects(
    real.start(other, () => undefined),
    /stopped before/,
  );
  assert.equal(real.networkMode(root), 'local');
});

test('no network address: refused, nothing restarts, the mode stays off', async (context) => {
  const root = project(context);
  const { instance, starts } = servers(owned(root));
  assert.deepEqual(await instance.setNetwork(onNetwork(root), OFFLINE), { ok: false, error: 'no-address' });
  assert.deepEqual(starts, []);
  assert.equal(instance.networkMode(root), 'local');
});

test('no server, another project, or a server the user runs: refused without a restart', async (context) => {
  const root = project(context);
  const none = servers(undefined);
  assert.deepEqual(await none.instance.setNetwork(onNetwork(root), WIFI), { ok: false, error: 'no-server' });
  const elsewhere = servers(owned(project(context)));
  assert.deepEqual(await elsewhere.instance.setNetwork(onNetwork(root), WIFI), { ok: false, error: 'no-server' });
  const external = servers({ proc: undefined, url: URL, projectPath: root, external: true });
  assert.deepEqual(await external.instance.setNetwork(onNetwork(root), WIFI), { ok: false, error: 'external' });
  assert.deepEqual([...none.starts, ...elsewhere.starts, ...external.starts], []);
  assert.deepEqual(external.instance.networkState(root, WIFI), { kind: 'off' });
});

test('a restart that fails ends off, started again on loopback once, and says so', async (context) => {
  const root = project(context);
  const { instance, starts, sent } = servers(owned(root), { failStarts: 1 });
  assert.deepEqual(await instance.setNetwork(onNetwork(root), WIFI), { ok: false, error: 'restart-failed' });
  assert.deepEqual(starts, ['network', 'local'], 'two restarts at most: the asked mode, then back to loopback');
  assert.equal(instance.networkMode(root), 'local');
  assert.equal(instance.current().url, URL, 'the canvas is back');
  assert.deepEqual(
    sent.filter((message) => message.channel === 'dev:exit'),
    [],
  );
});

test('when the loopback restart fails too, the app hears the preview went away', async (context) => {
  const root = project(context);
  const { instance, starts, sent } = servers(owned(root), { failStarts: 2 });
  assert.deepEqual(await instance.setNetwork(onNetwork(root), WIFI), { ok: false, error: 'restart-failed' });
  assert.deepEqual(starts, ['network', 'local'], 'still no third restart');
  assert.equal(instance.networkMode(root), 'local');
  assert.equal(sent.filter((message) => message.channel === 'dev:exit').length, 1);
});

test('a second change while one restarts is refused', async (context) => {
  const root = project(context);
  const { instance, starts } = servers(owned(root));
  const first = instance.setNetwork(onNetwork(root), WIFI);
  assert.deepEqual(await instance.setNetwork(onComputer(root), WIFI), { ok: false, error: 'busy' });
  assert.equal((await first).ok, true);
  assert.deepEqual(starts, ['network']);
});

test('only scanned devices: a restart with a new key, in the server’s environment and nowhere else', async (context) => {
  const root = project(context);
  const { instance, starts } = servers(owned(root));
  assert.deepEqual(instance.previewKeyEnvironment('local'), {}, 'off: no key');
  await instance.setNetwork(onNetwork(root), WIFI);
  assert.deepEqual(instance.previewKeyEnvironment('network'), {}, 'open to anyone: no key');
  const keyed = await instance.setNetwork(onNetwork(root, 'key'), WIFI);
  assert.equal(keyed.ok, true);
  const access = keyed.value.access;
  assert.equal(access.kind, 'key');
  assert.match(access.key, /^[A-Za-z0-9_-]{43}$/, '32 random bytes in base64url');
  assert.deepEqual(starts, ['network', 'network'], 'choosing it restarts the server once');
  assert.deepEqual(instance.previewKeyEnvironment('network'), { STACKI_PREVIEW_KEY: access.key });
  assert.deepEqual(instance.previewKeyEnvironment('local'), {}, 'never on this computer only');
  assert.deepEqual(await instance.setNetwork(onNetwork(root, 'key'), WIFI), keyed, 'asking again keeps the key and restarts nothing');
  assert.equal(starts.length, 2);

  await instance.setNetwork(onNetwork(root), WIFI);
  assert.deepEqual(instance.networkState(root, WIFI).access, OPEN, 'back to anyone: the key is gone');
  const again = await instance.setNetwork(onNetwork(root, 'key'), WIFI);
  assert.notEqual(again.value.access.key, access.key, 'turned on again, a new key: an older code stops working');

  await instance.setNetwork(onComputer(root), WIFI);
  assert.deepEqual(instance.previewKeyEnvironment('network'), {}, 'back to this computer: the key goes with the mode');
  const reopened = await instance.setNetwork(onNetwork(root), WIFI);
  assert.deepEqual(reopened.value.access, OPEN, 'turned on again, it starts open: nothing is remembered');
});

test('closing the project drops the key with the mode; a failed restart ends open', async (context) => {
  const root = project(context);
  const { instance } = servers(owned(root));
  await instance.setNetwork(onNetwork(root, 'key'), WIFI);
  instance.stop();
  assert.deepEqual(instance.previewKeyEnvironment('network'), {});
  const failing = servers(owned(root), { failStarts: 1 });
  assert.deepEqual(await failing.instance.setNetwork(onNetwork(root, 'key'), WIFI), { ok: false, error: 'restart-failed' });
  assert.deepEqual(failing.instance.previewKeyEnvironment('network'), {}, 'back on loopback, open, with no key left behind');
});

test('turning it on and off is announced as a restart, never as the preview ending, even when the address moves', async (context) => {
  const root = project(context);
  const { instance, sent } = servers(owned(root));
  await instance.setNetwork(onNetwork(root, 'key'), WIFI);
  await instance.setNetwork(onComputer(root), WIFI);
  const done = { kind: 'done', url: URL };
  const told = (messages) => messages.filter((message) => message.channel !== 'dev:log');
  assert.deepEqual(told(sent), [
    { channel: 'dev:restart', payload: { kind: 'begun' } },
    { channel: 'dev:restart', payload: done },
    { channel: 'dev:restart', payload: { kind: 'begun' } },
    { channel: 'dev:restart', payload: done },
  ]);
  // The reported bug: the server ran on the next port (its own was taken when the project opened), the restart came
  // back elsewhere, and a running server was reported as ended ("Preview is offline").
  const moved = servers({ ...owned(root), url: 'http://127.0.0.1:48782' });
  assert.equal((await moved.instance.setNetwork(onNetwork(root, 'key'), WIFI)).ok, true);
  assert.deepEqual(
    told(moved.sent).map((message) => message.channel),
    ['dev:restart', 'dev:restart'],
  );
  assert.deepEqual(told(moved.sent).at(-1).payload, done);
});

test('a start asked for while main restarts waits for that restart, and joins its server', async (context) => {
  const root = project(context);
  const { instance, starts } = servers(owned(root));
  let release;
  const stopping = new Promise((resolve) => (release = resolve));
  instance.pause = async () => {
    instance.server = undefined;
    await stopping;
  };
  const change = instance.setNetwork(onNetwork(root, 'key'), WIFI);
  const asked = startProjectPreview(instance, { noteProjectOpened() {}, schedule() {} }, root);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [], 'nothing starts while the old server stops');
  release();
  assert.equal((await change).ok, true);
  assert.equal((await asked).url, URL);
  assert.deepEqual(starts.slice(0, 1), ['network'], 'the restart starts first, in the asked mode');
  assert.ok(starts.every((mode) => mode === 'network'));
});
