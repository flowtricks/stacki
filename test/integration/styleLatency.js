// Goal: a style edit shows on the canvas on the edit that made it, not one
// edit later. Astro serves a component's <style> from its last server-side
// compile, so a stylesheet request that reaches the dev server before the
// page's render can be answered with the previous edit's CSS. This drives the
// real thing end to end and says, per edit, how long the canvas took to show
// the value just written — or which value it showed instead.
//
// Method: install a pinned Astro into a temporary project (once per version),
// then re-run this file under Electron. Load the real main process with a
// hidden window, start the real dev server through the `dev:start` handler, and
// open the page in a second hidden window, as the canvas does. Then:
//   1. eight `page:edit` code patches to the page's own <style> (what the style
//      pane sends for a node's style block),
//   2. eight `style:writeFile` writes of a component's <style is:global> (what
//      it sends for another file's global styles),
//   3. one text-only edit, which must not rewrite any stylesheet (the guard
//      that keeps animations from restarting while typing).
// Each edit times from before the write starts and waits for its own computed
// style (or literal text), polling every 20 ms for up to 3 s, then rests 600 ms.
// This is write-to-observed-value latency, not input-to-paint: it includes the
// save but bypasses the UI's input handling and debounce. Browser tests must
// measure those separately from the actual input event. The
// page counts its stylesheet rewrites and its page fetches (the morph).
//
// Outside the offline gate: it installs from the npm registry. Run it as
// `npm run integration:style` for Astro 5.18.2 and 7.2.10, or as
// `npm run integration:style -- --astro 7.2.10` for one version.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { ROOT, repoPath } = require('../helpers/sources.js');

const ASTRO_VERSIONS = ['5.18.2', '7.2.10'];
const EDITS = 8;
const SHOW_MS_MAX = 1000; // Slower than this is a failure, even if it shows later.
const WATCH_MS_MAX = 3000;
const POLL_MS = 20;
const REST_MS = 600;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = [
  '---',
  "import Theme from '../components/Theme.astro';",
  '---',
  '<html><body>',
  '<div class="box"><h1>Style latency</h1></div>',
  '<Theme />',
  '</body></html>',
  '<style>.box { background-color: rgb(1, 0, 0); }</style>',
  '',
].join('\n');
const THEME = (blue) => `<p>theme</p>\n<style is:global>.box { color: rgb(0, 0, ${blue}); }</style>\n`;

function versionsFromArguments() {
  const index = process.argv.indexOf('--astro');
  if (index === -1) {
    return ASTRO_VERSIONS;
  }
  const version = process.argv[index + 1];
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, '--astro takes an exact version');
  return [version];
}

function writeFixture(project, version) {
  fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src', 'components'), { recursive: true });
  const manifest = { name: 'stacki-style-latency', private: true, type: 'module' };
  manifest.dependencies = { astro: version };
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(project, 'astro.config.mjs'), 'export default {};\n');
  fs.writeFileSync(path.join(project, 'src', 'pages', 'index.astro'), PAGE);
  fs.writeFileSync(path.join(project, 'src', 'components', 'Theme.astro'), THEME(1));
}

async function orchestrateVersion(version) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-style-latency-'));
  const project = path.join(directory, 'project');
  writeFixture(project, version);
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };
  env.STACKI_INTEGRATION_DIR = directory;
  env.STACKI_INTEGRATION_PROJECT = project;
  env.STACKI_ASTRO_VERSION = version;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  // Keep the user's interactive shell startup files out of Node discovery.
  env.SHELL = process.platform === 'win32' ? env.SHELL : '/usr/bin/false';
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  try {
    console.log(`\nInstalling Astro ${version} in an isolated temporary project…`);
    const installed = childProcess.spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-audit', '--no-fund', '--cache', path.join(os.tmpdir(), 'stacki-npm-cache')],
      { cwd: project, env, stdio: 'inherit', timeout: 300000, shell: process.platform === 'win32' },
    );
    if (installed.error) {
      throw installed.error;
    }
    assert.equal(installed.status, 0, 'fixture dependencies install');
    const electron = require('electron');
    return await new Promise((resolve, reject) => {
      const child = childProcess.spawn(electron, [__filename, '--electron'], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    stopDaemon(project, env);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Astro 7 runs its dev server as a daemon that outlives the process that
// started it. The app asks it to stop when the project closes, but the run
// exits before that request has landed, and every run left one serving a
// deleted folder. Stopped here, from the fixture's own CLI, before the folder
// goes; a version without the subcommand just says so.
function stopDaemon(project, env) {
  const cli = path.join(project, 'node_modules', 'astro', 'bin', 'astro.mjs');
  if (fs.existsSync(cli)) {
    childProcess.spawnSync(process.execPath, [cli, 'dev', 'stop'], {
      cwd: project,
      env,
      stdio: 'ignore',
      timeout: 20000,
    });
  }
}

async function orchestrate() {
  let failed = 0;
  for (const version of versionsFromArguments()) {
    const code = await orchestrateVersion(version);
    if (code !== 0) {
      failed += 1;
    }
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

// The real main process, with its own windows hidden and kept off any page:
// only its IPC handlers are wanted, called directly.
async function loadMain(electron) {
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
    win.loadFile = () => win.loadURL('data:text/html,<title>Stacki style latency</title>');
    win.webContents.send = () => {};
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
    assert.ok(handlers.has(channel), `${channel} is registered`);
    return handlers.get(channel)({}, ...args);
  };
}

// Counters the page keeps for this test: stylesheet rewrites (a dev <style>
// added, removed or rewritten) and page fetches (the morph re-fetching the
// page after a change).
const INSTRUMENT = `(() => {
  window.__styleRewrites = 0;
  window.__pageFetches = 0;
  const dev = (node) => node.nodeType === 1 && node.matches('style[data-vite-dev-id]');
  new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target.nodeType === 3 ? record.target.parentNode : record.target;
      const touched = [...record.addedNodes, ...record.removedNodes].some(dev);
      if (touched || (target && dev(target))) window.__styleRewrites += 1;
    }
  }).observe(document.head, { childList: true, subtree: true, characterData: true });
  const fetchPage = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url.split('?')[0] === location.href.split('?')[0]) window.__pageFetches += 1;
    return fetchPage(input, init);
  };
  return true;
})()`;

async function openCanvas(BrowserWindow, url) {
  const canvas = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  // The page's console, kept for the first late edit's report: Vite's client
  // logs every stylesheet it hot-updates there.
  canvas.consoleLines = [];
  canvas.webContents.on('console-message', (...args) => {
    const message = typeof args[2] === 'string' ? args[2] : args[0]?.message;
    if (canvas.consoleLines.length < 200) {
      canvas.consoleLines.push(String(message));
    }
  });
  await canvas.loadURL(url);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ready = await canvas.webContents.executeJavaScript("!!document.querySelector('.box')");
    if (ready) {
      break;
    }
    await sleep(50);
  }
  assert.equal(await canvas.webContents.executeJavaScript(INSTRUMENT), true);
  return canvas;
}

const readCounters = (canvas) => canvas.webContents.executeJavaScript('[window.__styleRewrites, window.__pageFetches]');

// How long from starting the write until its exact expected value is observed.
// Use one monotonic clock in the test process, never a server/browser timestamp.
async function timeToShow(canvas, row, started) {
  const read =
    row.property === 'textContent' ? "document.querySelector('.box h1').textContent" : `getComputedStyle(document.querySelector('.box')).${row.property}`;
  let shown = '';
  while (performance.now() - started <= WATCH_MS_MAX) {
    shown = await canvas.webContents.executeJavaScript(read);
    if (shown === row.expected) {
      return { ms: performance.now() - started, shown };
    }
    await sleep(POLL_MS);
  }
  return { ms: undefined, shown };
}

// One page:edit code patch, stated against the checksum the page was read at,
// as the renderer's saver sends it.
async function editPage(invoke, codePatch, pagePath, change) {
  const read = await invoke('page:read', pagePath);
  const next = change(read.source);
  assert.notEqual(next, read.source, 'the edit changes the page');
  const hunks = codePatch.diffCodePatch(read.source, next);
  assert.equal(hunks.ok, true, 'the patch is within bounds');
  const edit = { tag: 'code-patch', hunks: hunks.value };
  const reply = await invoke('page:edit', { pagePath, authoredChecksum: read.checksum, edit });
  assert.equal(reply.ok, true, `page:edit applied: ${JSON.stringify(reply.error ?? '')}`);
}

// Every <style> in the document, for the first late edit's report: where it
// sits, what Vite named it, and how it starts.
const STYLE_INVENTORY = `[...document.querySelectorAll('style')].map((style) =>
  [style.parentNode.nodeName, style.getAttribute('data-vite-dev-id') || '-',
   style.textContent.replace(/\\s+/g, ' ').slice(0, 90)].join(' | '))`;

async function measure(canvas, rows, row, write) {
  const [rewritesBefore, fetchesBefore] = await readCounters(canvas);
  const consoleFrom = canvas.consoleLines.length;
  const started = performance.now();
  await write();
  const writeMs = performance.now() - started;
  const shown = await timeToShow(canvas, row, started);
  if (shown.ms === undefined && !rows.some((earlier) => earlier.diagnosis)) {
    row = { ...row, diagnosis: true };
    const say = (message) => fs.writeSync(1, message + '\n');
    say(`\nFirst late edit (${row.path} ${row.edit}): its console, then every <style>`);
    for (const line of canvas.consoleLines.slice(consoleFrom)) {
      say(`  console: ${line}`);
    }
    for (const line of await canvas.webContents.executeJavaScript(STYLE_INVENTORY)) {
      say(`  style: ${line}`);
    }
  }
  await sleep(REST_MS);
  const [rewritesAfter, fetchesAfter] = await readCounters(canvas);
  rows.push({
    ...row,
    writeMs,
    ms: shown.ms,
    shown: shown.shown,
    styleRewrites: rewritesAfter - rewritesBefore,
    pageFetches: fetchesAfter - fetchesBefore,
  });
}

async function runEdits(invoke, canvas, project) {
  const codePatch = require(repoPath('dist/shared/engine/codePatch.js'));
  const pagePath = path.join(project, 'src', 'pages', 'index.astro');
  const themePath = path.join(project, 'src', 'components', 'Theme.astro');
  const rows = [];
  for (let edit = 1; edit <= EDITS; edit += 1) {
    const red = edit * 20;
    const row = { path: 'page:edit', edit, property: 'backgroundColor' };
    await measure(canvas, rows, { ...row, expected: `rgb(${red}, 0, 0)` }, () =>
      editPage(invoke, codePatch, pagePath, (source) => source.replace(/background-color: rgb\(\d+, 0, 0\)/, `background-color: rgb(${red}, 0, 0)`)),
    );
  }
  for (let edit = 1; edit <= EDITS; edit += 1) {
    const blue = edit * 20;
    const row = { path: 'style:writeFile', edit, property: 'color' };
    await measure(canvas, rows, { ...row, expected: `rgb(0, 0, ${blue})` }, () => invoke('style:writeFile', { filePath: themePath, css: THEME(blue) }));
  }
  const text = { path: 'text only', edit: 1, property: 'textContent' };
  await measure(canvas, rows, { ...text, expected: 'Style latency, typed' }, () =>
    editPage(invoke, codePatch, pagePath, (source) => source.replace('<h1>Style latency</h1>', '<h1>Style latency, typed</h1>')),
  );
  return rows;
}

function report(version, rows) {
  const say = (message) => fs.writeSync(1, message + '\n');
  say(`\nAstro ${version}: write-to-observed-value latency (not input-to-paint)`);
  say('path             edit  expected            ms     write   shown instead       sheets  fetches');
  for (const row of rows) {
    const ms = row.ms === undefined ? 'never' : row.ms.toFixed(1);
    const instead = row.ms === undefined ? row.shown : '';
    say(
      `${row.path.padEnd(17)}${String(row.edit).padEnd(6)}${row.expected.padEnd(20)}` +
        `${ms.padEnd(7)}${row.writeMs.toFixed(1).padEnd(8)}` +
        `${instead.padEnd(20)}${String(row.styleRewrites).padEnd(8)}` +
        `${row.pageFetches}`,
    );
  }
  const late = rows.filter((row) => row.ms === undefined || row.ms > SHOW_MS_MAX);
  const typing = rows.find((row) => row.path === 'text only');
  const verdicts = [
    [`every style edit shows within ${SHOW_MS_MAX} ms`, late.length === 0],
    ['a text-only edit rewrites no stylesheet', typing?.styleRewrites === 0],
  ];
  for (const [what, held] of verdicts) {
    say(`${held ? 'PASS' : 'FAIL'} ${what}`);
  }
  return verdicts.every(([, held]) => held);
}

async function inElectron() {
  const electron = require('electron');
  const { app, BrowserWindow } = electron;
  const directory = process.env.STACKI_INTEGRATION_DIR;
  const project = process.env.STACKI_INTEGRATION_PROJECT;
  const version = process.env.STACKI_ASTRO_VERSION;
  assert.ok(directory && path.basename(directory).startsWith('stacki-style-latency-'));
  assert.equal(path.dirname(project), directory, 'use the isolated fixture only');
  const userData = path.join(directory, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setAppLogsPath(path.join(directory, 'logs'));
  app.setPath('crashDumps', directory);
  const invoke = await loadMain(electron);
  try {
    await invoke('project:scan', project);
    const server = await invoke('dev:start', project);
    // The canvas hash enables Stacki's DOM patcher; without it Vite correctly
    // reloads a normal browser page and the instrumentation disappears.
    const canvas = await openCanvas(BrowserWindow, `${server.url}/#avb-design`);
    const rows = await runEdits(invoke, canvas, project);
    if (!report(version, rows)) {
      process.exitCode = 1;
    }
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
  orchestrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
