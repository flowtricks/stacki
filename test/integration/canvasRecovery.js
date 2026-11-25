// Goal: the canvas returns from an error page to the real page with no user action, on a real Astro dev
// server, for every way the error goes away (docs/canvas-recovery.md).
//
// Method: a generated fixture project (never the owner's) with the studio fixture's packages cloned beside
// it. The real main process is loaded with hidden windows and its IPC handlers called directly, as
// insertLatency.bench.js does; the real dev server starts through `dev:start`. A host window embeds the
// server's page in an iframe (#avb-design, so the real morph client runs and falls back to a reload that
// lands on the error screen, as in the app) and runs the real canvas recovery controller
// (src/features/preview/canvasRecovery.ts) wired as appLifecycle.ts wires it: the app's write
// announcements, the failed-navigation reports of the real listener, the real `dev:inspect`. Scenarios:
// (a) compile error, fixed by undo; (b) runtime TypeError, fixed by an edit in the app; (c) fixed by an
// outside write; (d) the dev server restarts while the page is in error; (e) an error that persists.
// Every wait is bounded and relative; the time from the fix to a healthy canvas is printed.
//
// Outside the offline gate (it starts a dev server): `npm run integration:recovery`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, repoPath } = require('../helpers/sources.js');
const SITE_SOURCE = repoPath('studio/test/fixtures/site');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

const GOOD = '---\nconst title = "Healthy";\n---\n<html><body><main id="m"><h1>{title}</h1></main></body></html>\n';
const COMPILE_BAD = '---\nconst title = "Healthy";\n---\n<html><body><main id="m"><h1>{title</h1></main></body></html>\n';
const RUNTIME_BAD =
  '---\nimport getCollection from "astro:content";\nconst items = await getCollection("x");\n---\n<html><body><main id="m"><h1>Healthy</h1></main></body></html>\n';

function writeFixture(project) {
  fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
  fs.copyFileSync(path.join(SITE_SOURCE, 'package.json'), path.join(project, 'package.json'));
  fs.writeFileSync(path.join(project, 'astro.config.mjs'), 'export default {};\n');
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{ "extends": "astro/tsconfigs/strict" }\n');
  fs.writeFileSync(path.join(project, 'src', 'pages', 'index.astro'), GOOD);
  const cloned = childProcess.spawnSync('cp', ['-c', '-R', path.join(SITE_SOURCE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'inherit' });
  assert.equal(cloned.status, 0);
}

function orchestrate() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-recovery-repro-'));
  const project = path.join(directory, 'project');
  writeFixture(project);
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', STACKI_INTEGRATION_DIR: directory, STACKI_INTEGRATION_PROJECT: project };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  env.SHELL = '/usr/bin/false';
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  const electron = require('electron');
  const child = childProcess.spawn(electron, [__filename, '--electron'], { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    const cli = path.join(project, 'node_modules', 'astro', 'bin', 'astro.mjs');
    if (fs.existsSync(cli)) {
      childProcess.spawnSync(process.execPath, [cli, 'dev', 'stop'], { cwd: project, env, stdio: 'ignore', timeout: 20000 });
    }
    fs.rmSync(directory, { recursive: true, force: true });
    process.exitCode = code ?? 1;
  });
}

async function loadMain(electron, sends) {
  const { app, ipcMain, BrowserWindow } = electron;
  const handlers = new Map();
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    handlers.set(channel, handler);
    register(channel, handler);
  };
  const Module = require('node:module');
  const originalLoad = Module._load;
  const mainPath = repoPath('dist/electron/main.js');
  function HiddenWindow(options) {
    const win = new BrowserWindow({ ...options, show: false, webPreferences: { sandbox: true } });
    win.loadFile = () => win.loadURL('data:text/html,<title>x</title>');
    win.webContents.send = (channel, payload) => sends.forEach((listener) => listener(channel, payload));
    return win;
  }
  Object.setPrototypeOf(HiddenWindow, BrowserWindow);
  Module._load = function (name, parent) {
    if (name === 'electron' && parent?.filename === mainPath) {
      return { ...electron, BrowserWindow: HiddenWindow };
    }
    return originalLoad.apply(this, arguments);
  };
  require(mainPath);
  Module._load = originalLoad;
  await app.whenReady();
  await sleep(100);
  return (channel, ...args) => {
    assert.ok(handlers.has(channel), channel);
    return handlers.get(channel)({}, ...args);
  };
}

async function inElectron() {
  const electron = require('electron');
  const { app, BrowserWindow } = electron;
  const directory = process.env.STACKI_INTEGRATION_DIR;
  const project = process.env.STACKI_INTEGRATION_PROJECT;
  const userData = path.join(directory, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setAppLogsPath(path.join(directory, 'logs'));
  app.setPath('crashDumps', directory);
  const sends = [];
  const invoke = await loadMain(electron, sends);
  const codePatch = require(repoPath('dist/shared/engine/codePatch.js'));
  const { listenForPreviewFailures } = require(repoPath('dist/electron/preview/previewFailure.js'));
  const { createCanvasRecovery, isCurrentPageFailure } = require(repoPath('test/helpers/rendererModule.js'))('src/features/preview/canvasRecovery.ts');
  const pagePath = path.join(project, 'src', 'pages', 'index.astro');
  await invoke('project:scan', project);
  const server = await invoke('dev:start', project);
  const host = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await host.loadURL('data:text/html,<body></body>');
  const log = [];
  const startedAt = now();
  const say = (message) => {
    const line = `${String(now() - startedAt).padStart(6)}ms ${message}`;
    log.push(line);
    fs.writeSync(1, line + '\n');
  };
  const mount = () =>
    host.webContents.executeJavaScript(
      `(() => { document.body.innerHTML = ''; const f = document.createElement('iframe'); f.id='f'; f.style='width:600px;height:400px'; f.src=${JSON.stringify(server.url + '/#avb-design')}; document.body.append(f); })()`,
    );
  const frameOf = () => host.webContents.mainFrame.frames.find((candidate) => candidate.url.startsWith(server.url));
  const frameText = async () => {
    try {
      const frame = frameOf();
      return frame ? await frame.executeJavaScript('document.body ? document.body.innerText.slice(0,80) : ""') : '<none>';
    } catch (error) {
      return '<err>';
    }
  };
  const healthy = async () => {
    const frame = frameOf();
    if (!frame) {
      return false;
    }
    try {
      return await frame.executeJavaScript("!!document.querySelector('#m')");
    } catch {
      return false;
    }
  };
  const untilHealthy = async (limitMs) => {
    const began = now();
    while (now() - began < limitMs) {
      if (await healthy()) {
        return now() - began;
      }
      await sleep(50);
    }
    return undefined;
  };

  let reloads = 0;
  let inspects = 0;
  const events = [];
  const makeRecovery = (serverUrl) =>
    createCanvasRecovery({
      pageUrl: () => serverUrl + '/',
      inspect: (url) => {
        inspects++;
        return invoke('dev:inspect', url).then((verdict) => {
          say('inspect ' + verdict.kind + ' ' + verdict.status);
          return verdict;
        });
      },
      reload: () => {
        reloads++;
        say('recovery reload');
        void mount();
      },
      visible: () => true,
      onEvent: (event) => events.push(event.kind),
    });
  let recovery = makeRecovery(server.url);
  listenForPreviewFailures(host.webContents, () => server.url);
  host.webContents.send = (channel, payload) => {
    if (channel === 'dev:preview-failed' && isCurrentPageFailure(payload, server.url + '/')) {
      say('preview-failed ' + payload);
      recovery.failed(payload);
    }
  };
  sends.push((channel, payload) => {
    if (channel === 'page:maybe-changed') {
      recovery.trigger(payload.external ? 'external' : 'write');
    }
  });
  const frameLoaded = () => host.webContents.on('did-frame-finish-load', () => recovery.loaded());
  frameLoaded();

  const appWrite = async (source) => {
    const read = await invoke('page:read', pagePath);
    const hunks = codePatch.diffCodePatch(read.source, source);
    if (!hunks.ok) {
      throw new Error('hunks');
    }
    const reply = await invoke('page:edit', { pagePath, authoredChecksum: read.checksum, edit: { tag: 'code-patch', hunks: hunks.value } });
    assert.equal(reply.ok, true, JSON.stringify(reply));
  };
  const externalWrite = (source) => fs.writeFileSync(pagePath, source);

  try {
    await mount();
    say('initial healthy after ' + (await untilHealthy(30000)));
    await sleep(1500);
    const errorShown = async () => {
      const started = now();
      while (now() - started < 15000) {
        if (!(await healthy()) && frameOf()) {
          return now() - started;
        }
        await sleep(50);
      }
      return undefined;
    };
    const results = [];
    const scenarios = [
      ['a compile error, fixed by app undo', COMPILE_BAD, (good) => appWrite(good)],
      ['b runtime TypeError, fixed by app edit', RUNTIME_BAD, (good) => appWrite(good)],
      ['c compile error, fixed by an outside write', COMPILE_BAD, (good) => externalWrite(good)],
      ['c2 runtime error, fixed by an outside write', RUNTIME_BAD, (good) => externalWrite(good)],
    ];
    for (const [name, bad, fix] of scenarios) {
      say('=== ' + name);
      await appWrite(bad);
      assert.notEqual(await errorShown(), undefined, name + ': the error page shows');
      await sleep(3500); // the person reads it, then fixes it
      await fix(GOOD);
      const took = await untilHealthy(20000);
      assert.notEqual(took, undefined, name + ': the canvas stays on the error page');
      results.push(`${name}: healthy ${took} ms after the fix`);
      await sleep(1500);
    }

    say('=== d the dev server restarts while the page is in error');
    await appWrite(RUNTIME_BAD);
    assert.notEqual(await errorShown(), undefined);
    await invoke('dev:stop');
    fs.writeFileSync(pagePath, GOOD);
    const restarted = await invoke('dev:start', project);
    recovery.stop();
    recovery = makeRecovery(restarted.url);
    server.url = restarted.url;
    recovery.trigger('restart');
    const restartedAt = now();
    await mount();
    const tookRestart = await untilHealthy(30000);
    assert.notEqual(tookRestart, undefined, 'd: healthy after a restart');
    results.push(`d dev server restart: healthy ${tookRestart} ms after it came back (${now() - restartedAt} total)`);

    say('=== e an error that persists');
    await appWrite(RUNTIME_BAD);
    assert.notEqual(await errorShown(), undefined);
    const reloadsBefore = reloads;
    const inspectsBefore = inspects;
    const documentId = await frameOf().executeJavaScript('performance.timeOrigin');
    await sleep(14000);
    const polled = inspects - inspectsBefore;
    assert.ok(polled >= 4 && polled <= 9, `e: polled ${polled} times in 14 s: on the schedule, not hammering`);
    assert.equal(reloads, reloadsBefore, 'e: no reload while the error persists');
    assert.equal(await frameOf().executeJavaScript('performance.timeOrigin'), documentId, 'e: the error document was never replaced (no flicker)');
    await appWrite(GOOD);
    const tookLast = await untilHealthy(20000);
    assert.notEqual(tookLast, undefined, 'e: and it still recovers when fixed');
    results.push(`e persistent error: ${polled} polls in 14 s, no reload; recovered ${tookLast} ms after the fix`);
    recovery.stop();
    for (const line of results) {
      fs.writeSync(1, line + '\n');
    }
    fs.writeSync(1, 'canvas recovery: all scenarios passed\n');
  } finally {
    await invoke('project:close').catch(() => {});
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
  }
}

if (process.argv.includes('--electron')) {
  const { app } = require('electron');
  inElectron().then(
    () => app.exit(process.exitCode ?? 0),
    (error) => {
      fs.writeSync(2, String(error.stack || error) + '\n');
      app.exit(1);
    },
  );
} else {
  orchestrate();
}
