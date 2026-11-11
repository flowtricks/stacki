// Windows path handling is tested on every host by selecting win32 explicitly.
// These cases pin case-insensitive containment, executable discovery, and shim launching.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');
const { repoPath } = require('../../helpers/sources.js');

const {
  commandNeedsShell,
  isPathDescendant,
  isPathWithin,
  mergeToolPaths,
  pathEnvironmentValue,
  sameFilesystemPath,
  setPathEnvironment,
  staticToolPathGuesses,
} = require('#dist/electron/lib/platform.js');

const bundleDirectory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(bundleDirectory, { recursive: true });
const projectPathBundle = path.join(bundleDirectory, 'project-path.cjs');
esbuild.buildSync({
  entryPoints: [repoPath('src/lib/projectPath.ts')],
  outfile: projectPathBundle,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const { projectRelativePath } = require(projectPathBundle);
const assetURLBundle = path.join(bundleDirectory, 'asset-url.cjs');
esbuild.buildSync({
  entryPoints: [repoPath('src/ui/AssetThumb.tsx')],
  outfile: assetURLBundle,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react'],
  logLevel: 'silent',
});
const { sourceCandidates } = require(assetURLBundle);
const shortcutBundle = path.join(bundleDirectory, 'shortcut-label.cjs');
esbuild.buildSync({
  entryPoints: [repoPath('src/lib/shortcutLabel.ts')],
  outfile: shortcutBundle,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const { shortcutLabel } = require(shortcutBundle);

test('Windows containment accepts case changes and rejects sibling prefixes', () => {
  const root = 'C:\\Users\\Tim\\Site';
  assert.equal(isPathWithin(root, 'c:\\users\\tim\\site\\src\\pages\\index.astro', 'win32'), true);
  assert.equal(isPathWithin(root, 'C:\\Users\\Tim\\Site-copy\\secret.txt', 'win32'), false);
  assert.equal(isPathWithin(root, 'D:\\Site\\index.astro', 'win32'), false);
  assert.equal(isPathDescendant(root, 'c:\\USERS\\TIM\\SITE', 'win32'), false);
  assert.equal(sameFilesystemPath(root, 'c:\\users\\tim\\site\\', 'win32'), true);
});

test('POSIX containment remains case-sensitive', () => {
  assert.equal(isPathWithin('/Users/Tim/Site', '/Users/Tim/Site/src/index.astro', 'darwin'), true);
  assert.equal(isPathWithin('/Users/Tim/Site', '/users/tim/site/src/index.astro', 'darwin'), false);
});

test('Windows PATH handling preserves its existing key and deduplicates case', () => {
  const environment = { Path: 'C:\\Windows;C:\\Tools' };
  assert.equal(pathEnvironmentValue(environment, 'win32'), environment.Path);
  const merged = mergeToolPaths(environment.Path, ['c:\\tools', 'C:\\Node'], 'win32');
  assert.equal(merged, 'C:\\Windows;C:\\Tools;C:\\Node');
  setPathEnvironment(environment, merged, 'win32');
  assert.equal(environment.Path, merged);
  assert.equal(Object.hasOwn(environment, 'PATH'), false);
});

test('Windows command shims use a shell while executable files do not', () => {
  assert.equal(commandNeedsShell('C:\\Site\\node_modules\\.bin\\astro.cmd', 'win32'), true);
  assert.equal(commandNeedsShell('C:\\Tools\\BUILD.BAT', 'win32'), true);
  assert.equal(commandNeedsShell('C:\\Program Files\\nodejs\\node.exe', 'win32'), false);
  assert.equal(commandNeedsShell('/project/node_modules/.bin/astro', 'darwin'), false);
});

test('Windows discovery covers installers and common version managers', () => {
  const guesses = staticToolPathGuesses(
    'C:\\Users\\Tim',
    {
      APPDATA: 'C:\\Users\\Tim\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Tim\\AppData\\Local',
      NVM_SYMLINK: 'C:\\nvm\\current',
      PNPM_HOME: 'C:\\pnpm',
      BUN_INSTALL: 'C:\\bun',
    },
    'win32',
  );
  assert.ok(guesses.includes('C:\\nvm\\current'));
  assert.ok(guesses.includes('C:\\pnpm'));
  assert.ok(guesses.includes('C:\\bun\\bin'));
  assert.ok(guesses.includes('C:\\Program Files\\nodejs'));
  assert.ok(guesses.includes('C:\\Program Files\\Git\\cmd'));
  assert.ok(guesses.includes('C:\\Users\\Tim\\scoop\\shims'));
});

test('renderer derives project-relative paths from Windows paths', () => {
  assert.equal(projectRelativePath('C:\\Users\\Tim\\Site', 'c:\\users\\tim\\site\\src\\pages\\index.astro', 'win32'), 'src/pages/index.astro');
  assert.equal(projectRelativePath('C:\\Users\\Tim\\Site', 'D:\\Other\\index.astro', 'win32'), 'D:/Other/index.astro');
});

test('asset URLs preserve Windows drive and UNC roots', () => {
  assert.deepEqual(sourceCandidates('C:\\Site Files\\public\\hero.png'), [
    'stacki-asset://local/C:/Site%20Files/public/hero.png',
    'file:///C:/Site%20Files/public/hero.png',
  ]);
  assert.deepEqual(sourceCandidates('\\\\server\\share\\Site Files\\hero.png'), [
    'stacki-asset://local///server/share/Site%20Files/hero.png',
    'file://server/share/Site%20Files/hero.png',
  ]);
});

test('shortcut labels match the host operating system', () => {
  assert.equal(shortcutLabel('J', 'primary', 'win32'), 'Ctrl+J');
  assert.equal(shortcutLabel('A', 'primary-shift', 'win32'), 'Ctrl+Shift+A');
  assert.equal(shortcutLabel('J', 'primary', 'darwin'), '⌘J');
  assert.equal(shortcutLabel('A', 'primary-shift', 'darwin'), '⌘⇧A');
});

test('a missing native terminal binding does not prevent app startup', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, listener) => handlers.set(channel, listener),
    on: () => {},
  };
  const originalLoad = Module._load;
  let nativeLoadCount = 0;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return { ipcMain };
    }
    if (request === 'node-pty') {
      nativeLoadCount++;
      throw new Error('simulated missing native binding');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const terminalPath = require.resolve('#dist/electron/terminal/terminal.js');
  delete require.cache[terminalPath];
  try {
    const terminal = require(terminalPath);
    assert.equal(nativeLoadCount, 0, 'node-pty must remain unloaded while the app starts');
    terminal.registerTerminalHandlers({ send: () => {}, projectRoot: () => process.cwd(), gate: () => undefined });
    const start = handlers.get('terminal:start');
    assert.equal(typeof start, 'function');
    const result = await start({}, { id: 'test', cwd: process.cwd(), cols: 92, rows: 18 });
    assert.equal(result.ok, false);
    assert.match(result.error, /PTY_LOAD_FAILED/);
    assert.equal(nativeLoadCount, 1);
  } finally {
    Module._load = originalLoad;
    delete require.cache[terminalPath];
  }
});

// Record the real IPC handler's native spawn options so a renderer-only fix cannot
// accidentally leave ConPTY using its old 80-column, 24-row startup grid.
test('native terminal starts with the measured grid before its first output', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, listener) => handlers.set(channel, listener), on: () => {} };
  const originalLoad = Module._load;
  const sizes = [];
  let spawnOptions;
  const nativeTerminal = {
    process: 'powershell.exe',
    onData: () => {},
    onExit: () => {},
    resize: (cols, rows) => sizes.push({ cols, rows }),
    kill: () => {},
  };
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return { ipcMain };
    }
    if (request === 'node-pty') {
      return {
        spawn: (_shell, _arguments, options) => {
          spawnOptions = options;
          return nativeTerminal;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const terminalPath = require.resolve('#dist/electron/terminal/terminal.js');
  delete require.cache[terminalPath];
  let terminal;
  try {
    terminal = require(terminalPath);
    terminal.registerTerminalHandlers({ send: () => {}, projectRoot: () => process.cwd(), gate: () => undefined });
    const result = await handlers.get('terminal:start')(
      {},
      {
        id: 'measured',
        cwd: process.cwd(),
        cols: 92,
        rows: 18,
      },
    );
    assert.deepEqual(result, { ok: true, id: 'measured' });
    assert.equal(spawnOptions.cols, 92);
    assert.equal(spawnOptions.rows, 18);
    assert.deepEqual(sizes, [], 'starting correctly needs no corrective native resize');
    await handlers.get('terminal:resize')({}, { id: 'measured', cols: 100, rows: 30 });
    assert.deepEqual(sizes, [{ cols: 100, rows: 30 }]);
  } finally {
    terminal?.cleanupTerminals();
    Module._load = originalLoad;
    delete require.cache[terminalPath];
  }
});
