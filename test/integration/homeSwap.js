// Goal: making a page the homepage, done the way Page settings does it (page:applySettings), leaves the running dev
// server serving both routes with the right content, never shows the error overlay on the canvas, and one undo
// (page:revertSettings) brings both routes back.
//
// Method: a generated Lumos-like fixture project (never the owner's) with the studio fixture's packages cloned beside
// it, as styleDelete.js does: a BaseLayout with nav links to `/` and `/about`, a Home page at src/pages/index.astro
// and an About page in a folder, src/pages/company/about.astro (so the swap changes both files' depth and rewrites
// their relative imports). The real main process is loaded with hidden windows and its IPC handlers called directly;
// the real dev server starts through `dev:start`. A host window with the app's preload embeds the canvas iframe the
// way the app does. The canvas is on /company/about when the swap runs; afterwards it opens `/`, where that page now
// lives. Every wait is a bounded poll of a condition. Screenshots go to STACKI_SCREENSHOT_DIR when it is set.
//
// Outside the offline gate (it starts a dev server): `npm run build:runtime && node test/integration/homeSwap.js`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, repoPath } = require('../helpers/sources.js');
const SITE_SOURCE = repoPath('studio/test/fixtures/site');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

const FILES = {
  'src/layouts/BaseLayout.astro':
    "---\ninterface Props { title: string; description?: string }\nconst { title, description = 'A site' } = Astro.props;\nconst links = [\n  { label: 'Home', href: '/' },\n  { label: 'About', href: '/company/about' },\n];\n---\n<html><head><title>{title}</title><meta name=\"description\" content={description} /></head><body>\n<nav>{links.map((link) => <a class=\"nav-link\" href={link.href}>{link.label}</a>)}</nav>\n<main id=\"main\"><slot /></main>\n</body></html>\n",
  'src/components/Hero.astro': '---\nconst { heading } = Astro.props;\n---\n<section class="hero"><h1 id="heading">{heading}</h1></section>\n',
  'src/pages/index.astro':
    '---\nimport BaseLayout from \'../layouts/BaseLayout.astro\';\nimport Hero from \'../components/Hero.astro\';\n---\n<BaseLayout title="Home"><Hero heading="Home page" /><a href="/company/about">About us</a></BaseLayout>\n',
  'src/pages/company/about.astro':
    '---\nimport BaseLayout from \'../../layouts/BaseLayout.astro\';\nimport Hero from \'../../components/Hero.astro\';\n---\n<BaseLayout title="About"><Hero heading="About page" /><a href="/">Back home</a></BaseLayout>\n',
};

function writeFixture(project) {
  for (const [relative, text] of Object.entries(FILES)) {
    const target = path.join(project, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  fs.copyFileSync(path.join(SITE_SOURCE, 'package.json'), path.join(project, 'package.json'));
  fs.writeFileSync(path.join(project, 'astro.config.mjs'), 'export default {};\n');
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{ "extends": "astro/tsconfigs/strict" }\n');
  fs.cpSync(path.join(SITE_SOURCE, 'node_modules'), path.join(project, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
}

function orchestrate() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-home-swap-'));
  const project = path.join(directory, 'project');
  writeFixture(project);
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', STACKI_INTEGRATION_DIR: directory, STACKI_INTEGRATION_PROJECT: project };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
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
  const shots = process.env.STACKI_SCREENSHOT_DIR;
  const userData = path.join(directory, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setAppLogsPath(path.join(directory, 'logs'));
  app.setPath('crashDumps', directory);
  const invoke = await loadMain(electron, []);
  await invoke('project:scan', project);
  const server = await invoke('dev:start', project);
  const host = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: {
      backgroundThrottling: false,
      preload: repoPath('dist/electron/preload/preload.js'),
      contextIsolation: true,
      nodeIntegrationInSubFrames: true,
    },
  });
  await host.loadURL('data:text/html,<body style="margin:0"></body>');
  const startedAt = now();
  const say = (message) => fs.writeSync(1, `${String(now() - startedAt).padStart(6)}ms ${message}\n`);
  const mount = (route) =>
    host.webContents.executeJavaScript(
      `(() => { document.querySelectorAll('iframe').forEach((f) => f.remove()); const f = document.createElement('iframe'); f.style='width:880px;height:580px;border:0'; f.src=${JSON.stringify(server.url + route + '#avb-design')}; document.body.append(f); })()`,
    );
  const inFrame = async (script) => {
    const frame = host.webContents.mainFrame.frames.find((candidate) => candidate.url.startsWith(server.url));
    assert.ok(frame, 'the canvas frame is there');
    let timer;
    const late = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the canvas frame did not answer')), 3000);
    });
    try {
      return await Promise.race([frame.executeJavaScript(script), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const until = async (predicate, limitMs) => {
    const began = now();
    while (now() - began < limitMs) {
      if (await predicate().catch(() => false)) {
        return now() - began;
      }
      await pause(50);
    }
    return undefined;
  };
  const heading = () => inFrame("document.getElementById('heading')?.textContent ?? ''");
  const overlayShown = () => inFrame("!!document.querySelector('vite-error-overlay')").catch(() => false);
  // Watched for the whole window after a step: the overlay never comes up, not only at the end.
  const noOverlayFor = async (name, windowMs) => {
    const began = now();
    while (now() - began < windowMs) {
      assert.equal(await overlayShown(), false, name + ': no error overlay on the canvas');
      await pause(100);
    }
  };
  const serves = async (route, text) => {
    const response = await fetch(server.url + route);
    const body = await response.text();
    return response.status === 200 && body.includes(text);
  };
  const shoot = async (name) => {
    if (!shots) {
      return;
    }
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, name), (await host.webContents.capturePage()).toPNG());
    say('screenshot ' + path.join(shots, name));
  };
  try {
    await mount('/company/about');
    assert.notEqual(await until(async () => (await heading()) === 'About page', 30000), undefined, 'the About page renders');
    await shoot('home-swap-0-before.png');

    say('=== the swap');
    const plan = await invoke('page:planSettings', { projectPath: project, request: { kind: 'home', page: 'company/about.astro' } });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    say(`plan: ${plan.value.links} links in ${plan.value.files} files, moves ${JSON.stringify(plan.value.moves)}`);
    const applied = await invoke('page:applySettings', { projectPath: project, request: { kind: 'home', page: 'company/about.astro' } });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.value.page, 'index.astro');
    // The canvas follows the page it was on: About now lives at `/`.
    await mount('/');
    assert.notEqual(await until(async () => (await heading()) === 'About page', 15000), undefined, '/ renders the About page');
    await noOverlayFor('after the swap', 2500);
    assert.ok(await serves('/', 'About page'), '/ answers 200 with the About page');
    assert.ok(await serves('/company/about', 'Home page'), '/company/about answers 200 with the Home page');
    assert.ok(await serves('/', 'href="/company/about"'), 'the nav link to the old homepage moved with it');
    await shoot('home-swap-1-after.png');

    say('=== undo');
    const undone = await invoke('page:revertSettings', { token: applied.value.undo, direction: 'undo' });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    assert.notEqual(await until(() => serves('/', 'Home page'), 15000), undefined, 'undo: / is the Home page again');
    assert.ok(await serves('/company/about', 'About page'), 'undo: /company/about is the About page again');
    await mount('/company/about');
    assert.notEqual(await until(async () => (await heading()) === 'About page', 15000), undefined, 'undo: the canvas shows About at its old route');
    await noOverlayFor('after undo', 2500);
    for (const [relative, text] of Object.entries(FILES)) {
      assert.equal(fs.readFileSync(path.join(project, ...relative.split('/')), 'utf8'), text, `undo: ${relative} byte for byte`);
    }
    fs.writeSync(1, 'home swap: both routes served, no overlay, undo byte-exact\n');
  } catch (error) {
    await shoot('home-swap-failure.png').catch(() => {});
    throw error;
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
