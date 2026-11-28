// Goal: start the real Stacki desktop app against a fixture project, from a Node test, the way
// `npm run dev` starts it for a person: a Vite dev server serving the renderer from the working
// tree, the built main process from dist/electron, the real Astro dev server rendering the
// fixture in the canvas. Nothing is faked: no bridge, no clock, no window.
//
// Method:
// - The fixture is a copy of the Lumos example site (studio/test/fixtures/site) with the soak
//   overlay (test/fixtures/style-soak) on top, written to a fresh temporary directory. Astro
//   resolves its packages by walking up from the project, and a symlinked node_modules breaks
//   that (electron/preview/previewWorktree.ts says why), so node_modules is cloned instead:
//   copy-on-write on macOS (`cp -c`), hard links on Linux (`cp -al`), a plain copy elsewhere.
// - The renderer comes from a private Vite server on a free port, with a dependency cache of
//   its own inside the run directory, no file watcher and no HMR: a person's running
//   `npm run dev` keeps its port, its dependency cache and its reloads, and other people's
//   edits during a run cannot reload this one. Runs never share a cache either: one server
//   optimizing replaced the chunks another was serving, and with no HMR to reload it that app
//   drew nothing ("the canvas never rendered the fixture") or lost a panel it imports later.
// - Electron runs `electronEntry.js`, which gives the app an isolated user-data directory and
//   the fixture as the project to reopen (the dev reopen file main.ts reads in dev mode), then
//   loads dist/electron/main.js unchanged and hands the window to the scenario module.
// - Every process of the run is stopped however the run ends, and stale ones from runs that
//   were killed outright are reaped at the next start (soakProcesses.js, soakWatchdog.js).
// - The temporary directory is removed with bounded retries (Windows holds files a moment
//   after a process exits).

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ROOT, repoPath } = require('../sources.js');
const { classicScrollbarArguments } = require('../classicScrollbars.js');
const { RUN_DIRECTORY_PREFIX, reapStaleSoakServers, stopRun, stopRunNow, watchdogOptions, writeRegistry } = require('./soakProcesses.js');

const SITE_SOURCE = repoPath('studio/test/fixtures/site');
const OVERLAY_SOURCE = repoPath('test/fixtures/style-soak');
const SITE_COPY_SKIP = new Set(['node_modules', '.astro', 'dist', '.stacki']);
const REMOVE_ATTEMPTS_MAX = 8;
const REMOVE_RETRY_MS = 250;
const CLONE_TIMEOUT_MS = 180000;
const RENDERER_TREE = Object.freeze(['src', 'shared', 'index.html', 'vite.config.mjs', 'tsconfig.json']);
const ARCHIVE_BYTES_MAX = 512 * 1024 * 1024;
const SIGNAL_EXIT_CODE = 130;
const RENDERER_CACHE_NAME = 'vite-cache';

/** Why the soak cannot run here, or undefined when it can. */
function soakUnavailableReason() {
  if (!fs.existsSync(path.join(SITE_SOURCE, 'node_modules', 'astro', 'package.json'))) {
    return 'studio/test/fixtures/site/node_modules has no astro (run `npm --prefix studio/test/fixtures/site ci`)';
  }
  if (!fs.existsSync(repoPath('dist/electron/main.js'))) {
    return 'dist/electron/main.js is not built (run `npm run build:runtime`)';
  }
  return undefined;
}

function copySite(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(SITE_SOURCE)) {
    if (SITE_COPY_SKIP.has(entry)) {
      continue;
    }
    fs.cpSync(path.join(SITE_SOURCE, entry), path.join(target, entry), { recursive: true });
  }
  fs.cpSync(OVERLAY_SOURCE, target, { recursive: true, force: true });
}

function cloneModules(target) {
  const source = path.join(SITE_SOURCE, 'node_modules');
  const destination = path.join(target, 'node_modules');
  if (process.platform === 'darwin') {
    const cloned = childProcess.spawnSync('cp', ['-c', '-R', source, destination], { stdio: 'inherit', timeout: CLONE_TIMEOUT_MS });
    if (cloned.status === 0) {
      return;
    }
  }
  if (process.platform === 'linux') {
    const linked = childProcess.spawnSync('cp', ['-a', '-l', source, destination], { stdio: 'inherit', timeout: CLONE_TIMEOUT_MS });
    if (linked.status === 0) {
      return;
    }
  }
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

async function removeWithRetries(directory) {
  for (let attempt = 1; attempt <= REMOVE_ATTEMPTS_MAX; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === REMOVE_ATTEMPTS_MAX) {
        console.warn(`[soak] could not remove ${directory}: ${String(error)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS * attempt));
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' ? (address ?? undefined)?.port : undefined;
      server.close(() => resolve(port ?? 0));
    });
  });
}

// The renderer files at an earlier commit, for checking that the soak catches a defect a later
// commit fixed: `git archive` into the run directory (never a worktree or a checkout of the
// person's tree), with node_modules linked from the repository. Only the renderer is old; the
// main process stays the built one.
function exportRendererTree(revision, target) {
  fs.mkdirSync(target, { recursive: true });
  const archive = childProcess.spawnSync('git', ['archive', '--format=tar', revision, ...RENDERER_TREE], { cwd: ROOT, maxBuffer: ARCHIVE_BYTES_MAX });
  if (archive.status !== 0) {
    throw new Error(`soakLaunch: git archive ${revision} failed: ${String(archive.stderr)}`);
  }
  const extracted = childProcess.spawnSync('tar', ['-x', '-f', '-', '-C', target], { input: archive.stdout, maxBuffer: ARCHIVE_BYTES_MAX });
  if (extracted.status !== 0) {
    throw new Error(`soakLaunch: extracting ${revision} failed: ${String(extracted.stderr)}`);
  }
  fs.symlinkSync(repoPath('node_modules'), path.join(target, 'node_modules'), 'junction');
  return target;
}

// The renderer as `npm run dev` serves it, from a server of our own, which writes its
// pre-bundled dependencies under `runDirectory` and nowhere another run can reach.
async function startRendererServer(root, runDirectory) {
  assert.ok(path.isAbsolute(runDirectory), 'startRendererServer: the run directory is an absolute path');
  const cacheDirectory = path.join(runDirectory, RENDERER_CACHE_NAME);
  const { createServer } = await import('vite');
  const port = await freePort();
  // eslint-disable-next-line stacki/no-null -- Vite's documented value for "no file watcher".
  const noWatcher = null;
  const server = await createServer({
    configFile: path.join(root, 'vite.config.mjs'),
    root,
    cacheDir: cacheDirectory,
    logLevel: 'warn',
    clearScreen: false,
    // Vite's dependency scan reads every .html file under the root when none are named, and
    // studio/demo/index.html imports `__APP__/...` placeholders that only the Studio build fills in:
    // on a cold cache the scan failed with an unresolved import and the page never loaded (the 1.4.4
    // release run, on all three platforms). The renderer's one entry is all this server serves.
    optimizeDeps: { entries: ['index.html'] },
    // The cache is outside the root, so the strict file check is told of it beside the root.
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: noWatcher, fs: { strict: root === ROOT, allow: [root, cacheDirectory] } },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}/` };
}

/**
 * Runs `scenarioModule` inside the real app. `options` reach the scenario as JSON through the
 * environment. Resolves with Electron's exit code, the run directory (kept when asked) and the
 * pids of any process of the run that would not stop (none, unless something is badly wrong).
 * However the run ends (an error, SIGINT, SIGTERM, an uncaught exception), its processes are
 * stopped and its directory removed (soakProcesses.js has the layers that cover a SIGKILL).
 * `scrollbars: 'classic'` draws classic scrollbars whatever the computer is set to (classicScrollbars.js).
 */
async function runSoak({ scenarioModule, options, keepDirectory, scrollbars = 'as-set' }) {
  const reaped = await reapStaleSoakServers();
  if (reaped.length > 0) {
    console.log(`# reaped ${reaped.length} soak process(es) left by earlier runs: ${reaped.join(', ')}`);
  }
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), RUN_DIRECTORY_PREFIX));
  writeRegistry(directory);
  const teardownNow = (reason) => {
    stopRunNow(directory);
    if (!keepDirectory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    console.error(`[soak] stopped the run (${reason})`);
  };
  const onSignal = (name) => {
    teardownNow(name);
    process.exit(SIGNAL_EXIT_CODE);
  };
  const onFatal = (error) => {
    console.error('[soak] fatal:', error);
    teardownNow('fatal error');
    process.exit(1);
  };
  const handlers = [
    ['SIGINT', () => onSignal('SIGINT')],
    ['SIGTERM', () => onSignal('SIGTERM')],
    ['uncaughtException', onFatal],
    ['unhandledRejection', onFatal],
  ];
  for (const [event, handler] of handlers) {
    process.on(event, handler);
  }
  let renderer;
  try {
    const project = path.join(directory, 'project');
    const userData = path.join(directory, 'user-data');
    fs.mkdirSync(userData, { recursive: true });
    copySite(project);
    cloneModules(project);
    const rendererRoot = options.rendererRevision ? exportRendererTree(options.rendererRevision, path.join(directory, 'renderer-tree')) : ROOT;
    renderer = await startRendererServer(rendererRoot, directory);
    const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    env.VITE_DEV_SERVER_URL = renderer.url;
    env.STACKI_SOAK_PROJECT = project;
    env.STACKI_SOAK_USER_DATA = userData;
    env.STACKI_SOAK_SCENARIO = scenarioModule;
    env.STACKI_SOAK_OPTIONS = JSON.stringify(options);
    // Every Node child (Electron's main, the Astro dev server and its daemon) carries the
    // watchdog and the runner's pid: if this process dies without cleaning up, they follow.
    env.STACKI_SOAK_RUNNER_PID = String(process.pid);
    env.NODE_OPTIONS = watchdogOptions(env.NODE_OPTIONS);
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
    const electron = require('electron');
    const code = await new Promise((resolve, reject) => {
      // Its own process group, and the run directory on its command line, so the stop finds
      // it and everything it started.
      const scrollbarArguments = scrollbars === 'classic' ? classicScrollbarArguments() : [];
      const child = childProcess.spawn(electron, [path.join(__dirname, 'electronEntry.js'), `--soak-run=${directory}`, ...scrollbarArguments], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      });
      child.on('error', reject);
      child.on('exit', (exitCode) => resolve(exitCode ?? 1));
    });
    return { code, directory, leftovers: await stopRun(directory) };
  } finally {
    // Idempotent: a run that returned has already stopped; one that threw has not.
    await stopRun(directory);
    if (renderer !== undefined) {
      await renderer.server.close();
    }
    for (const [event, handler] of handlers) {
      process.off(event, handler);
    }
    if (!keepDirectory) {
      await removeWithRetries(directory);
    }
  }
}

module.exports = { cloneModules, copySite, removeWithRetries, runSoak, soakUnavailableReason, startRendererServer };
