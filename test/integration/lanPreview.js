// Goal: the phone preview works end to end on a real Astro dev server, and only the site reaches the network.
// With the mode on, a second client using this machine's LAN address gets the page, renders it in Chromium
// without errors from Stacki's scripts, and receives a live edit over the HMR socket; the same client is
// refused (403) on /__avb/*, /studio and /__open-in-editor, while 127.0.0.1 still reaches /__avb/*. With the
// mode off again, the LAN address no longer answers at all and the canvas address still does.
//
// Method: a generated fixture project (never the owner's) with the Studio fixture's packages cloned beside it
// (as canvasRecovery.js does). In Electron, the real DevServers (dist/electron/handlers/devServers.js) starts
// the server with the app's generated config and its IPC handlers turn the mode on and off. Requests to one's
// own LAN address arrive from that address, so they are a real non-loopback source without a second device.
// A hidden window is the phone: it loads the LAN URL, and every wait polls its document with a bounded
// deadline, never a fixed pause. A machine with no network address skips with a message.
//
// Outside the offline gate (it starts a dev server and needs a network): `npm run integration:lan`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, repoPath } = require('../helpers/sources.js');
const { pollUntil } = require('../helpers/waitFor.js');
const SITE_SOURCE = repoPath('studio/test/fixtures/site');
const POLL_MS = 50;
// A line in the fixture's .env that must never reach the network (Vite's default fs.deny holds it).
const ENV_SECRET = 'STACKI_LAN_SECRET=do-not-serve';

const page = (title) =>
  `---\nconst title = ${JSON.stringify(title)};\n---\n<html><head><title>{title}</title></head><body><main id="m"><h1>{title}</h1></main></body></html>\n`;

function writeFixture(project) {
  fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
  fs.copyFileSync(path.join(SITE_SOURCE, 'package.json'), path.join(project, 'package.json'));
  fs.writeFileSync(path.join(project, 'astro.config.mjs'), 'export default {};\n');
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{ "extends": "astro/tsconfigs/strict" }\n');
  fs.writeFileSync(path.join(project, 'src', 'pages', 'index.astro'), page('Healthy'));
  fs.writeFileSync(path.join(project, '.env'), `${ENV_SECRET}\n`);
  const cloned = childProcess.spawnSync('cp', ['-c', '-R', path.join(SITE_SOURCE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'inherit' });
  assert.equal(cloned.status, 0);
}

function orchestrate() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-lan-preview-'));
  const project = path.join(directory, 'project');
  writeFixture(project);
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', STACKI_INTEGRATION_DIR: directory, STACKI_INTEGRATION_PROJECT: project };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  const electron = require('electron');
  const child = childProcess.spawn(electron, [__filename, '--electron', '--use-mock-keychain'], { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    const cli = path.join(project, 'node_modules', 'astro', 'bin', 'astro.mjs');
    if (fs.existsSync(cli)) {
      childProcess.spawnSync(process.execPath, [cli, 'dev', 'stop'], { cwd: project, env, stdio: 'ignore', timeout: 20000 });
    }
    fs.rmSync(directory, { recursive: true, force: true });
    process.exitCode = code ?? 1;
  });
}

// Polls `probe` until it returns something other than undefined, or fails at the deadline.
async function until(what, limitMs, probe) {
  const outcome = await pollUntil({
    what,
    read: probe,
    until: (value) => value !== undefined,
    pollIntervalMs: POLL_MS,
    pollCountMax: Math.ceil(limitMs / POLL_MS),
  });
  if (outcome.kind === 'reached') {
    return outcome.value;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function status(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return 0; // Refused or unreachable.
  }
}

async function inElectron() {
  const { app, BrowserWindow } = require('electron');
  const directory = process.env.STACKI_INTEGRATION_DIR;
  const project = process.env.STACKI_INTEGRATION_PROJECT;
  app.setPath('userData', path.join(directory, 'user-data'));
  // The phone window closes halfway; Electron would quit with its last window.
  app.on('window-all-closed', () => undefined);
  await app.whenReady();
  // Main sets this before anything spawns (main.ts); the test stands in for main.
  require(repoPath('dist/electron/lib/nodeTools.js')).setToolPathHome(app.getPath('home'));
  const { DevServers, registerDevServerHandlers } = require(repoPath('dist/electron/handlers/devServers.js'));
  const { selectLanAddresses } = require(repoPath('dist/electron/preview/lanAddresses.js'));
  const lan = selectLanAddresses(os.networkInterfaces())[0];
  if (lan === undefined) {
    console.log('lan-preview: skipped, this machine has no network address a phone could share.');
    app.exit(0);
    return;
  }
  const handlers = new Map();
  const devServers = new DevServers({ send() {} });
  registerDevServerHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    devServers,
    thumbnails: { noteProjectOpened() {}, schedule() {} },
  });
  const invoke = (channel, payload) => handlers.get(channel)({}, payload);
  const say = (line) => fs.writeSync(1, `lan-preview: ${line}\n`);
  try {
    const started = await invoke('dev:start', project);
    const local = started.url;
    const port = new URL(local).port;
    const network = `http://${lan.address}:${port}`;
    say(`server at ${local}; network address ${network}`);
    assert.equal(new URL(local).hostname, '127.0.0.1', 'the canvas address is loopback');
    assert.deepEqual(await invoke('dev:network', project), { kind: 'off' }, 'off by default');
    assert.equal(await status(`${network}/`), 0, 'off: the network gets nothing');

    // Astro 7 forks its server into a daemon and the CLI exits once it is up; until main has seen that
    // exit it does not know to stop the daemon with `dev stop`, and a restart in that moment would find
    // the port still held. A person cannot toggle that fast; the test waits for main to know.
    await until('main to see the daemon', 30000, () => (devServers.current()?.daemon === true ? true : undefined));
    const on = await invoke('dev:setNetwork', { projectPath: project, mode: 'network' });
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.equal(on.value.kind, 'on');
    assert.equal(devServers.current().url, local, 'the canvas keeps its address');
    await until('the server on the network', 60000, async () => ((await status(`${network}/`)) === 200 ? true : undefined));
    assert.equal(await status(`${local}/`), 200, 'the canvas address still answers');
    assert.equal(await status(`${local}/__avb/paths?p=src/pages/index.astro`), 200, 'loopback reaches Stacki routes');
    for (const route of [
      '/__avb/paths?p=src/pages/index.astro',
      '/__avb/value?m=x&f=y',
      '/__avb/data?c=x',
      '/__avb/reload?r=x',
      '/__avb/touch?f=x',
      '/studio',
      '/__open-in-editor?file=astro.config.mjs',
    ]) {
      assert.equal(await status(`${network}${route}`), 403, `${route} is refused from the network`);
    }
    say('the network gets the site, and 403 on every Stacki route');
    for (const route of ['/.env', `/@fs${fs.realpathSync(project)}/.env`]) {
      const body = await fetch(`${network}${route}`, { signal: AbortSignal.timeout(5000) }).then((response) => response.text());
      assert.equal(body.includes(ENV_SECRET), false, `${route} does not serve the .env`);
    }
    assert.equal(await status(`${network}/@fs/etc/hosts`), 403, 'Vite fs.strict refuses a file outside the project');
    say('neither the .env nor a file outside the project is served (Vite fs.strict and fs.deny at their defaults)');

    // The canvas, on loopback in network mode: still the editor's page, markers and all.
    const canvas = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await canvas.loadURL(`${local}/#avb-design`);
    const canvasMarked = () => canvas.webContents.executeJavaScript("document.documentElement.outerHTML.includes('avb-s:') ? true : undefined");
    await until('the canvas markers on loopback', 30000, canvasMarked);
    canvas.destroy();
    say('the canvas on 127.0.0.1 keeps its markers in network mode');

    // The phone: a second browser on the LAN origin renders the page, and Stacki's scripts stay quiet.
    const phone = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    const problems = [];
    let connected = false;
    phone.webContents.on('console-message', (event) => {
      const message = event.message ?? '';
      if (message.includes('[vite] connected')) {
        connected = true;
      }
      if (event.level === 'error' || /Uncaught|TypeError|ReferenceError/.test(message)) {
        problems.push(message);
      }
    });
    await phone.loadURL(`${network}/`);
    const heading = () => phone.webContents.executeJavaScript("document.querySelector('h1')?.textContent ?? ''");
    await until('the page on the phone', 30000, async () => ((await heading()) === 'Healthy' ? true : undefined));
    await until('the HMR socket from the LAN origin', 30000, () => (connected ? true : undefined));
    const markers = await phone.webContents.executeJavaScript("document.documentElement.outerHTML.includes('avb-s:')");
    say(`page rendered on the LAN origin; HMR connected; Stacki markers left in the phone's DOM: ${markers}`);
    fs.writeFileSync(path.join(project, 'src', 'pages', 'index.astro'), page('Edited'));
    await until('the edit on the phone', 30000, async () => ((await heading()) === 'Edited' ? true : undefined));
    assert.deepEqual(problems, [], 'no script errors on the phone (the morph client included)');
    say('a live edit reached the phone over HMR');
    phone.destroy();

    const off = await invoke('dev:setNetwork', { projectPath: project, mode: 'local' });
    assert.deepEqual(off, { ok: true, value: { kind: 'off' } });
    await until('the network address to stop answering', 30000, async () => ((await status(`${network}/`)) === 0 ? true : undefined));
    assert.equal(await status(`${local}/`), 200, 'the canvas address answers after the mode is off');
    say('off: the network gets nothing, the canvas still answers');
    devServers.stop();
    assert.deepEqual(await invoke('dev:network', project), { kind: 'off' });
    say('passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    devServers.stop();
    app.exit(1);
  }
}

if (process.argv.includes('--electron')) {
  void inElectron();
} else {
  orchestrate();
}
