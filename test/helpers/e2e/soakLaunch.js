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
// - The renderer comes from a private Vite server on a free port with its own cache directory,
//   no file watcher and no HMR: a person's running `npm run dev` keeps its port, its dependency
//   cache and its reloads, and other people's edits during a run cannot reload this one.
// - Electron runs `electronEntry.js`, which gives the app an isolated user-data directory and
//   the fixture as the project to reopen (the dev reopen file main.ts reads in dev mode), then
//   loads dist/electron/main.js unchanged and hands the window to the scenario module.
// - The temporary directory is removed with bounded retries (Windows holds files a moment
//   after a process exits).

const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ROOT, repoPath } = require('../sources.js');

const SITE_SOURCE = repoPath('studio/test/fixtures/site');
const OVERLAY_SOURCE = repoPath('test/fixtures/style-soak');
const SITE_COPY_SKIP = new Set(['node_modules', '.astro', 'dist', '.stacki']);
const REMOVE_ATTEMPTS_MAX = 8;
const REMOVE_RETRY_MS = 250;
const CLONE_TIMEOUT_MS = 180000;
const RENDERER_TREE = Object.freeze(['src', 'shared', 'index.html', 'vite.config.mjs', 'tsconfig.json']);
const ARCHIVE_BYTES_MAX = 512 * 1024 * 1024;

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

// The renderer as `npm run dev` serves it, from a server of our own.
async function startRendererServer(root) {
  const { createServer } = await import('vite');
  const port = await freePort();
  // eslint-disable-next-line stacki/no-null -- Vite's documented value for "no file watcher".
  const noWatcher = null;
  const server = await createServer({
    configFile: path.join(root, 'vite.config.mjs'),
    root,
    cacheDir: repoPath('node_modules/.stacki-test/soak-vite'),
    logLevel: 'warn',
    clearScreen: false,
    server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: noWatcher, fs: { strict: root === ROOT } },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}/` };
}

/**
 * Runs `scenarioModule` inside the real app. `options` reach the scenario as JSON through the
 * environment. Resolves with Electron's exit code and the run directory (kept when asked).
 */
async function runSoak({ scenarioModule, options, keepDirectory }) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'stacki-style-soak-'));
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  copySite(project);
  cloneModules(project);
  const rendererRoot = options.rendererRevision ? exportRendererTree(options.rendererRevision, path.join(directory, 'renderer-tree')) : ROOT;
  const renderer = await startRendererServer(rendererRoot);
  const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  env.VITE_DEV_SERVER_URL = renderer.url;
  env.STACKI_SOAK_PROJECT = project;
  env.STACKI_SOAK_USER_DATA = userData;
  env.STACKI_SOAK_SCENARIO = scenarioModule;
  env.STACKI_SOAK_OPTIONS = JSON.stringify(options);
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
  try {
    const electron = require('electron');
    const code = await new Promise((resolve, reject) => {
      const child = childProcess.spawn(electron, [path.join(__dirname, 'electronEntry.js')], { cwd: ROOT, env, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (exitCode) => resolve(exitCode ?? 1));
    });
    return { code, directory };
  } finally {
    await renderer.server.close();
    if (!keepDirectory) {
      await removeWithRetries(directory);
    }
  }
}

module.exports = { runSoak, soakUnavailableReason };
