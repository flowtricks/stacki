const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  protocol,
  net: enet,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const {
  parsePage,
  serializePage,
  parseTemplate,
  serializeNodes,
  resolveChunks,
  parsePropSchema,
  parseExtendsTag,
  parseSlots,
} = require('./astroParser');
const { scaffoldProject } = require('./scaffold');
const { importersOf } = require('./cmsRefs');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let devServer = null; // {proc, url, projectPath}

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Asset previews
//
// Thumbnails (Assets panel, the props panel's image field) read straight off
// disk. A bare file:// URL only loads when the document itself came from
// file://, which is true of a packaged build (loadFile) but not of `npm run
// dev`, where the renderer is served over http — Chromium blocks file://
// subresources from an http document, so every preview fell back to its
// extension badge. Serving them over our own scheme behaves the same in both.
// ---------------------------------------------------------------------------

const ASSET_SCHEME = 'stacki-asset';
let openProjectRoot = null; // set when a project's watcher starts

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function registerAssetProtocol() {
  protocol.handle(ASSET_SCHEME, (request) => {
    let abs;
    try {
      abs = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    // stacki-asset://local/Users/… on posix, //local/C:/… on Windows.
    if (isWin) abs = abs.replace(/^\//, '');
    abs = path.resolve(abs);
    // Preview iframes run the user's own site; keep the scheme from being a
    // general-purpose file reader by serving only the open project's files.
    if (!openProjectRoot || !(abs + path.sep).startsWith(openProjectRoot + path.sep)) {
      return new Response(null, { status: 403 });
    }
    return serveFile(abs, request);
  });
}

async function serveFile(abs, request) {
  const res = await enet.fetch(pathToFileURL(abs).toString(), { headers: request.headers });
  // The renderer is a different origin from this scheme, and font loading is
  // CORS-checked (unlike <img>/<video>), so the Assets panel's "Aa" preview
  // needs this to fetch the face at all. Reach is already limited to the open
  // project by the check above.
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const resource = (name) => path.join(__dirname, '..', 'resources', name);

// electron-builder stamps the icon onto packaged builds (build.mac.icon), but
// `npm run dev` runs the bare Electron binary, which shows its own icon in the
// Dock. Set it explicitly so dev looks like the real app. macOS takes the
// padded icon-dock.png; elsewhere the Dock isn't a thing and the window icon
// below covers it.
function setApplicationIcon() {
  if (process.platform !== 'darwin') return;
  const img = nativeImage.createFromPath(resource('icon-dock.png'));
  if (!img.isEmpty()) app.dock?.setIcon(img);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 640,
    title: 'Stacki',
    backgroundColor: '#111111',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Windows/Linux taskbar + window chrome; macOS uses the Dock icon above.
    icon: resource(process.platform === 'darwin' ? 'icon.icns' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Run the preload in preview iframes too, so they can report their
      // page height for the canvas view (the preload guards what each
      // frame type gets).
      nodeIntegrationInSubFrames: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Custom menu: on macOS the native menu consumes ⌘Z/⌘C/⌘V before the page
// sees them, so Undo/Redo/Copy/Paste forward to the renderer, which decides
// between app-level actions (nodes) and native ones (text fields).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('menu:undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('menu:copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('menu:paste') },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Insert Element…', accelerator: 'CmdOrCtrl+E', click: () => send('menu:insert') },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Native clipboard actions on the focused element, requested by the renderer
// when a menu Copy/Paste lands while a text field has focus.
ipcMain.handle('native:copy', () => {
  mainWindow?.webContents.copy();
  return { ok: true };
});
ipcMain.handle('native:paste', () => {
  mainWindow?.webContents.paste();
  return { ok: true };
});

app.whenReady().then(() => {
  setApplicationIcon();
  registerAssetProtocol();
  buildMenu();
  createWindow();
  startAutoUpdateChecks();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopDevServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopDevServer());

// ---------------------------------------------------------------------------
// Auto update
//
// Feed is the GitHub releases repo configured under `build.publish` in
// package.json. The appId must stay `com.stacki.editor` so installs from
// earlier versions upgrade in place instead of landing beside themselves.
// ---------------------------------------------------------------------------

const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let autoUpdateInterval = null;
let autoUpdateCheckInFlight = false;
let autoUpdateErrorDialogShown = false;

// Update-check failures the user can do nothing about, and so should never
// see a dialog for: they're offline, or a release is mid-publish and its
// channel file for this platform hasn't uploaded yet. Both resolve on their
// own by the next check.
function isExpectedAutoUpdateNetworkError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();

  // A release whose other platform published first: the channel file is
  // briefly absent, which surfaces as a 404 on latest-mac.yml / latest.yml.
  if (
    message.includes('cannot find latest') ||
    (message.includes('404') && message.includes('.yml'))
  ) {
    return true;
  }

  if (
    [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ERR_INTERNET_DISCONNECTED',
      'ERR_NAME_NOT_RESOLVED',
    ].includes(code)
  ) {
    return true;
  }

  return [
    'internet disconnected',
    'name not resolved',
    'network',
    'offline',
    'socket hang up',
    'timed out',
    'getaddrinfo',
    'failed to fetch',
    'could not connect',
    'connection refused',
  ].some((fragment) => message.includes(fragment));
}

function formatAutoUpdateError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function logAutoUpdate(message, details) {
  const detailText =
    details === undefined
      ? ''
      : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
  const line = `[${new Date().toISOString()}] ${message}${detailText}`;

  console.log(line);

  if (!app.isReady()) return;

  try {
    const logsDirectory = app.getPath('logs');
    fs.mkdirSync(logsDirectory, { recursive: true });
    fs.appendFileSync(path.join(logsDirectory, 'auto-update.log'), `${line}\n`);
  } catch (error) {
    console.warn('Failed to write auto update log:', error);
  }
}

async function promptToInstallDownloadedUpdate(version) {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const { response } = await dialog.showMessageBox(parent, {
    type: 'info',
    title: 'Update Ready',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: `Stacki ${version} has been downloaded.`,
    detail: 'Restart Stacki to install the update.',
  });

  if (response === 0) {
    stopDevServer();
    autoUpdater.quitAndInstall();
  }
}

function registerAutoUpdaterEvents() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => logAutoUpdate('Checking for updates'));
  autoUpdater.on('update-available', (info) =>
    logAutoUpdate('Update available', { version: info.version }),
  );
  autoUpdater.on('update-not-available', (info) =>
    logAutoUpdate('No update available', { version: info.version }),
  );

  autoUpdater.on('update-downloaded', (info) => {
    logAutoUpdate('Update downloaded', { version: info.version });
    void promptToInstallDownloadedUpdate(info.version);
  });

  autoUpdater.on('error', (error) => {
    logAutoUpdate('Auto update error', formatAutoUpdateError(error));

    if (autoUpdateErrorDialogShown || isExpectedAutoUpdateNetworkError(error)) return;
    autoUpdateErrorDialogShown = true;

    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    void dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'Update Check Failed',
      message: 'Stacki could not check for updates.',
      // The raw error carries response headers and a stack trace; the full
      // text is in the log, so show the user only the first line.
      detail: `${formatAutoUpdateError(error).split('\n')[0].slice(0, 200)}\n\nStacki will try again later.`,
    });
  });
}

async function runAutoUpdateCheck() {
  if (!app.isPackaged || autoUpdateCheckInFlight) return;

  autoUpdateCheckInFlight = true;
  try {
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (error) {
    if (!isExpectedAutoUpdateNetworkError(error)) {
      console.warn('Auto update check failed:', error);
    }
  } finally {
    autoUpdateCheckInFlight = false;
  }
}

function startAutoUpdateChecks() {
  if (!app.isPackaged) {
    logAutoUpdate('Skipping auto update checks in development');
    return;
  }

  registerAutoUpdaterEvents();
  void runAutoUpdateCheck();

  if (autoUpdateInterval) clearInterval(autoUpdateInterval);
  autoUpdateInterval = setInterval(() => void runAutoUpdateCheck(), AUTO_UPDATE_CHECK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Finding Node
//
// Launched from Finder or the Dock, the app inherits launchd's PATH —
// /usr/bin:/bin:/usr/sbin:/sbin — not the shell's. Nothing installed by
// Homebrew, nvm, fnm, volta, or the Node installer is on it, so `astro` (a
// `#!/usr/bin/env node` shim) dies with "env: node: No such file or
// directory" and `npm install` fails as ENOENT. Launched from a terminal it
// all works, which is why this only bites in the packaged app.
// ---------------------------------------------------------------------------

// Interactive login shell, because that's the one that sources .zshrc/.bashrc
// where version managers put themselves. Marker-delimited so rc-file chatter
// around the value can't be mistaken for it.
function shellPathDirs() {
  // $SHELL is usually set even under launchd, but not always — the account's
  // registered login shell is the reliable source when it isn't.
  let shell = process.env.SHELL;
  if (!shell) {
    try {
      shell = require('os').userInfo().shell || null;
    } catch {
      shell = null;
    }
  }
  if (!shell) return [];
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__AVB__%s__AVB__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Quieter rc files: no pagers, no update prompts, no color codes.
      env: { ...process.env, TERM: 'dumb', DISABLE_AUTO_UPDATE: 'true' },
    });
    const m = /__AVB__([\s\S]*?)__AVB__/.exec(out);
    return m ? m[1].split(path.delimiter).filter(Boolean) : [];
  } catch {
    return []; // no shell, hung rc file, exotic setup — fall through to the guesses
  }
}

const cmpVersion = (a, b) => {
  const parts = (v) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

// Where Node ends up when the shell probe comes back empty — every install
// route in common use, since we can't ask the user which one they took.
function nodeDirGuesses() {
  const home = app.getPath('home');
  const dirs = isWin
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
        path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
        path.join(home, 'AppData', 'Local', 'Volta', 'bin'),
        path.join(home, 'AppData', 'Roaming', 'fnm'),
        path.join(home, 'scoop', 'shims'),
        'C:\\ProgramData\\chocolatey\\bin',
      ]
    : [
        '/opt/homebrew/bin', // Homebrew, Apple Silicon
        '/usr/local/bin', // Homebrew on Intel, and the official installer
        '/opt/local/bin', // MacPorts
        '/snap/bin', // Linux snap
        path.join(home, '.volta/bin'),
        path.join(home, '.asdf/shims'),
        path.join(home, '.nodenv/shims'),
        path.join(home, '.local/share/mise/shims'),
        path.join(home, '.local/bin'),
        path.join(home, '.npm-global/bin'),
        path.join(home, 'n/bin'),
      ];
  // Version managers keep one directory per version — take the newest, so a
  // project needing a modern Node still gets one.
  const versioned = isWin
    ? [[path.join(home, 'AppData', 'Roaming', 'nvm'), '']]
    : [
        [path.join(home, '.nvm/versions/node'), 'bin'],
        [path.join(home, '.local/share/fnm/node-versions'), 'installation/bin'],
        [path.join(home, 'Library/Application Support/fnm/node-versions'), 'installation/bin'],
        [path.join(home, '.fnm/node-versions'), 'installation/bin'],
        [path.join(home, '.asdf/installs/nodejs'), 'bin'],
        [path.join(home, '.nodenv/versions'), 'bin'],
        [path.join(home, '.local/share/mise/installs/node'), 'bin'],
        ['/usr/local/n/versions/node', 'bin'],
      ];
  for (const [base, suffix] of versioned) {
    try {
      const newest = fs
        .readdirSync(base)
        .filter((v) => /^v?\d/.test(v))
        .sort(cmpVersion)
        .pop();
      if (newest) dirs.push(suffix ? path.join(base, newest, suffix) : path.join(base, newest));
    } catch {
      /* not installed */
    }
  }
  return dirs;
}

// Costs a shell spawn, so it runs once, lazily — nothing needs it until a
// child process is about to start.
let toolPathReady = false;
function ensureToolPath() {
  if (toolPathReady || isWin) return;
  toolPathReady = true;
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(parts);
  const append = (dir) => {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  };
  // Appended, not prepended: the system's own resolution order stays intact,
  // and these directories only ever win for tools the base PATH lacks.
  for (const dir of shellPathDirs()) append(dir);
  for (const dir of nodeDirGuesses()) if (fs.existsSync(dir)) append(dir);
  process.env.PATH = parts.join(path.delimiter);
}

function resolveNodeBin() {
  ensureToolPath();
  const exe = isWin ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

// node_modules/.bin/<name> is a symlink to the package's JS entry on POSIX
// and a wrapper script on Windows. The package's own `bin` field is correct
// on both (and survives pnpm's store layout, where the symlink points
// somewhere else entirely), so read that first and fall back to the link.
function resolveCliEntry(binPath) {
  const name = path.basename(binPath).replace(/\.(cmd|ps1|exe|bat)$/i, '');
  const pkgDir = path.join(path.dirname(binPath), '..', name);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin[name];
    if (rel) {
      const entry = path.join(pkgDir, rel);
      if (fs.existsSync(entry)) return entry;
    }
  } catch {
    /* not a plain node_modules layout */
  }
  try {
    const real = fs.realpathSync(binPath);
    if (/\.(js|mjs|cjs)$/i.test(real)) return real;
  } catch {
    /* not a symlink */
  }
  return null;
}

// Runs the CLI's JS entry point under a resolved Node instead of going
// through the .bin shim, so the shebang's own PATH lookup — the thing that
// fails on a GUI launch — never happens. Returns [command, argv].
function nodeCliCommand(binPath, args) {
  const node = resolveNodeBin();
  if (!node) return [binPath, args];
  const entry = resolveCliEntry(binPath);
  return entry ? [node, [entry, ...args]] : [binPath, args];
}

function run(cmd, args, cwd, opts = {}) {
  // Launched from Finder, the packaged app inherits a bare PATH — Homebrew's
  // bin isn't on it, so `gh` looks uninstalled however it was set up. Cheap
  // after the first call (memoized).
  ensureToolPath();
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: opts.timeout || 60000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

async function git(projectPath, args, opts = {}) {
  return run('git', args, projectPath, opts);
}

function findFreePort(start) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(findFreePort(start + 1)));
    server.once('listening', () => {
      server.close(() => resolve(start));
    });
    server.listen(start, '127.0.0.1');
  });
}

function listAstroFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro') || (d.includes(`${path.sep}pages`) && entry.name.endsWith('.md'))) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function routeForPage(projectPath, pagePath) {
  const pagesDir = path.join(projectPath, 'src', 'pages');
  let rel = toPosix(path.relative(pagesDir, pagePath)).replace(/\.(astro|md)$/, '');
  if (rel === 'index') return '/';
  if (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);
  return '/' + rel;
}

function isAstroProject(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.astro) return true;
    } catch {
      /* fall through */
    }
  }
  return ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'].some((f) =>
    fs.existsSync(path.join(dir, f))
  );
}

// ---------------------------------------------------------------------------
// Recent projects + preview thumbnails
// ---------------------------------------------------------------------------

const recentsFile = () => path.join(app.getPath('userData'), 'recents.json');
const thumbsDir = () => path.join(app.getPath('userData'), 'thumbs');

function readRecents() {
  try {
    const list = JSON.parse(fs.readFileSync(recentsFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeRecents(list) {
  try {
    fs.writeFileSync(recentsFile(), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }
}

function thumbPathFor(projectPath) {
  const hash = crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 16);
  return path.join(thumbsDir(), `${hash}.png`);
}

ipcMain.handle('recents:list', async () => {
  // Drop entries whose folder is gone or no longer looks like an Astro project.
  const list = readRecents().filter((r) => {
    try {
      return fs.existsSync(r.path) && isAstroProject(r.path);
    } catch {
      return false;
    }
  });
  return list.map((r) => {
    let thumb = null;
    try {
      const tp = thumbPathFor(r.path);
      if (fs.existsSync(tp)) {
        thumb = 'data:image/png;base64,' + fs.readFileSync(tp).toString('base64');
      }
    } catch {
      /* card renders a placeholder */
    }
    return { ...r, thumb };
  });
});

ipcMain.handle('recents:add', async (_e, projectPath) => {
  const list = readRecents().filter((r) => r.path !== projectPath);
  list.unshift({
    path: projectPath,
    name: path.basename(projectPath),
    openedAt: Date.now(),
  });
  writeRecents(list.slice(0, 12));
  return { ok: true };
});

ipcMain.handle('recents:remove', async (_e, projectPath) => {
  writeRecents(readRecents().filter((r) => r.path !== projectPath));
  try {
    fs.rmSync(thumbPathFor(projectPath), { force: true });
  } catch {
    /* non-fatal */
  }
  return { ok: true };
});

// Captures the given window region (the preview iframe's rect, in DIP
// coordinates) and stores it as the project's thumbnail.
ipcMain.handle('recents:captureThumb', async (_e, { projectPath, rect }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  try {
    const image = await mainWindow.webContents.capturePage({
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
    if (image.isEmpty()) return { ok: false };
    fs.mkdirSync(thumbsDir(), { recursive: true });
    fs.writeFileSync(thumbPathFor(projectPath), image.resize({ width: 640 }).toPNG());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Project IPC
// ---------------------------------------------------------------------------

ipcMain.handle('project:openDialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open an Astro project',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const dir = result.filePaths[0];
  if (!isAstroProject(dir)) {
    return { canceled: false, error: 'That folder does not look like an Astro project (no astro dependency or astro.config found).' };
  }
  return { canceled: false, projectPath: dir };
});

ipcMain.handle('project:newDialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an empty folder for the new project',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const dir = result.filePaths[0];
  const entries = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (entries.length > 0) {
    return { canceled: false, error: 'That folder is not empty. Choose or create an empty folder for the new project.' };
  }
  return { canceled: false, projectPath: dir };
});

// Detects the project's package manager from its lockfile.
function detectPackageManager(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock')))
    return 'bun';
  return 'npm';
}

async function installDependencies(dir) {
  ensureToolPath(); // npm/pnpm/yarn are Node shims — same PATH problem as astro
  const pm = detectPackageManager(dir);
  send('progress', { message: `Installing dependencies (${pm} install)…` });
  const args = pm === 'npm' ? ['install', '--no-audit', '--no-fund'] : ['install'];
  try {
    await run(isWin ? `${pm}.cmd` : pm, args, dir, {
      timeout: 10 * 60 * 1000,
      shell: isWin,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `This project uses ${pm} (found its lockfile), but ${pm} is not installed. Install it and try again.`
      );
    }
    throw new Error(`${pm} install failed: ${(err.stderr || err.message || '').slice(-400)}`);
  }
}

// Runs the real `npm create astro@latest`, answering the questions the CLI
// would ask interactively with the choices collected in the app's wizard.
// Output is streamed to the renderer so the user sees the same progress the
// terminal would show. The chosen folder is the cwd and "." the target, so
// create-astro never has to guess a name from a parent directory.
ipcMain.handle('project:createAstro', async (_e, opts) => {
  const { dir, template = 'basics', install = true, git = true, ai = false } = opts || {};
  if (!dir || !fs.existsSync(dir)) throw new Error('Choose a folder for the new project first.');
  ensureToolPath(); // npm is a Node shim — same PATH problem as astro

  const args = [
    'create',
    'astro@latest',
    '.',
    '--',
    '--template',
    template,
    install ? '--install' : '--no-install',
    git ? '--git' : '--no-git',
    ...(ai ? [] : ['--no-ai']),
    '--skip-houston',
    '--yes', // accept defaults for anything not covered above
  ];

  send('create:log', `> npm ${args.join(' ')}\n\n`);

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(isWin ? 'npm.cmd' : 'npm', args, {
        cwd: dir,
        shell: isWin,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      });
    } catch (err) {
      reject(new Error(`Could not run npm: ${err.message}`));
      return;
    }

    let tail = '';
    const onOut = (d) => {
      // create-astro animates with cursor moves and line clears; strip the
      // escape codes so the log pane reads as plain text.
      const text = d
        .toString()
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\r/g, '\n');
      tail = (tail + text).slice(-4000);
      send('create:log', text);
    };
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('error', (err) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? 'npm could not be found. Install Node.js (which includes npm) and try again.'
            : `Could not run npm: ${err.message}`
        )
      );
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        // Sanity-check that a project actually landed.
        if (!fs.existsSync(path.join(dir, 'package.json'))) {
          reject(new Error(`create-astro finished but no package.json appeared.\n\n${tail}`));
          return;
        }
        resolve({ ok: true, installed: install });
      } else {
        reject(new Error(`create-astro exited with code ${code}.\n\n${tail}`));
      }
    });
  });
});

ipcMain.handle('project:scaffold', async (_e, { dir, name }) => {
  scaffoldProject(dir, name);
  await installDependencies(dir);
  return { ok: true };
});

ipcMain.handle('project:hasNodeModules', async (_e, projectPath) => {
  return fs.existsSync(path.join(projectPath, 'node_modules'));
});

ipcMain.handle('project:install', async (_e, projectPath) => {
  await installDependencies(projectPath);
  return { ok: true };
});

ipcMain.handle('project:scan', async (_e, projectPath) => {
  // Also set here, not just in watch:start — the Assets panel can render
  // thumbnails before the watcher starts, and they'd be refused.
  openProjectRoot = path.resolve(projectPath);
  const src = path.join(projectPath, 'src');
  const pagesDir = path.join(src, 'pages');
  const layoutsDir = path.join(src, 'layouts');
  const componentsDir = path.join(src, 'components');

  const pages = listAstroFiles(pagesDir).map((p) => ({
    path: p,
    name: toPosix(path.relative(pagesDir, p)),
    route: routeForPage(projectPath, p),
  }));

  // Folders under src/pages (including empty ones) for the pages tree.
  const pageFolders = [];
  if (fs.existsSync(pagesDir)) {
    const walkDirs = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(d, entry.name);
        pageFolders.push(toPosix(path.relative(pagesDir, full)));
        walkDirs(full);
      }
    };
    walkDirs(pagesDir);
  }

  // `folder` groups these in the components panel. Layouts are relative to
  // src, so they read as the folder they're actually in ("layouts", or
  // "layouts/marketing"); components are relative to src/components, whose
  // own root is the ungrouped case.
  const layouts = listAstroFiles(layoutsDir).map((p) => ({
    path: p,
    name: path.basename(p, '.astro'),
    folder: toPosix(path.relative(src, path.dirname(p))),
    isLayout: true,
    ...safeSchema(p, projectPath),
  }));

  const components = listAstroFiles(componentsDir).map((p) => ({
    path: p,
    name: path.basename(p, '.astro'),
    folder: toPosix(path.relative(componentsDir, path.dirname(p))),
    ...safeSchema(p, projectPath),
  }));

  // Instance counts: how often each component is used across every .astro
  // file in src (pages, layouts, and other components).
  const allSources = listAstroFiles(src).map((f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  });
  // Layouts are counted too: they show up in the palette alongside
  // components, so the instance line has to mean the same thing for both.
  for (const comp of [...components, ...layouts]) {
    const re = new RegExp(`<${comp.name}[\\s/>]`, 'g');
    comp.instances = allSources.reduce((n, s) => n + (s.match(re) || []).length, 0);
  }

  return { pages, layouts, components, pageFolders };
});

// Every CSS class name used anywhere under src/ — class attributes in markup
// plus selectors in stylesheets and <style> blocks — for the class-prop
// autocomplete in the props panel.
ipcMain.handle('project:classes', async (_e, projectPath) => {
  const out = new Set();
  const exts = /\.(astro|css|scss|less|html|jsx|tsx|js|ts|vue|svelte)$/i;
  const files = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.test(e.name)) files.push(full);
    }
  };
  walk(path.join(projectPath, 'src'));

  const addCssClasses = (css) => {
    const re = /(?:^|[\s,{>~+()])\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
    let m;
    while ((m = re.exec(css)) !== null) out.add(m[1]);
  };
  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (/\.(css|scss|less)$/i.test(f)) {
      addCssClasses(content);
      continue;
    }
    const attrRe = /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(content)) !== null) {
      for (const t of (m[1] ?? m[2] ?? '').split(/\s+/)) if (t) out.add(t);
    }
    const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let sm;
    while ((sm = styleRe.exec(content)) !== null) addCssClasses(sm[1]);
  }
  return [...out].sort();
});

function safeSchema(filePath, projectPath) {
  try {
    const source = fs.readFileSync(filePath, 'utf8');
    const schema = parsePropSchema(source);
    resolveIdentifierDefaults(schema, source, filePath, projectPath);
    return {
      schema,
      extendsTag: parseExtendsTag(source),
      slots: parseSlots(source),
      // A `...rest` spread on Astro.props means the component forwards
      // arbitrary attributes — the UI offers a free-form Attributes section.
      hasRest: /\{[^}]*\.\.\.[\s\S]*?\}\s*=\s*Astro\.props/.test(source),
    };
  } catch {
    return { schema: [], extendsTag: null, slots: [], hasRest: false };
  }
}

// ---------------------------------------------------------------------------
// Prop-default resolution: a default like `SITE_TITLE` is often an identifier
// imported from another module (or a local const in the frontmatter). Follow
// it to its literal value so the UI shows the real default.
// ---------------------------------------------------------------------------

function literalValue(raw) {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (/^(true|false)$/.test(s)) return s === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // Strings, including template literals without interpolation.
  if (/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)$/s.test(s)) {
    return s.slice(1, -1).replace(/\\(['"`\\])/g, '$1');
  }
  return undefined;
}

// Finds `export const NAME = <literal>` (or let/var, optional type note).
function constLiteralIn(code, name) {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=\\n]+)?=\\s*` +
      '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`[^`$]*`|-?\\d+(?:\\.\\d+)?|true|false)'
  );
  const m = code.match(re);
  return m ? literalValue(m[1]) : undefined;
}

// Finds which module a named import binds `name` from: {orig, spec}.
function findNamedImport(code, name) {
  const re = /import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const part of m[1].split(',')) {
      const seg = part.trim().replace(/^type\s+/, '');
      if (!seg) continue;
      const asMatch = seg.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      const orig = asMatch ? asMatch[1] : seg;
      const local = asMatch ? asMatch[2] : seg;
      if (local === name) return { orig, spec: m[2] };
    }
  }
  return null;
}

function resolveModuleFile(spec, fromFile, projectPath) {
  let base;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    base = path.join(projectPath, 'src', spec.slice(2));
  } else if (spec.startsWith('src/')) base = path.join(projectPath, spec);
  else return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.mts`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function resolveIdentifierDefaults(schema, source, filePath, projectPath) {
  for (const field of schema) {
    if (!field.defaultExpr) continue;
    const ident = String(field.default).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(ident)) continue;
    // Local const in the component's own frontmatter first.
    let value = constLiteralIn(source, ident);
    if (value === undefined) {
      const imp = findNamedImport(source, ident);
      if (imp) {
        const file = resolveModuleFile(imp.spec, filePath, projectPath);
        if (file) {
          try {
            value = constLiteralIn(fs.readFileSync(file, 'utf8'), imp.orig);
          } catch {
            /* unreadable module — leave the identifier as-is */
          }
        }
      }
    }
    if (value !== undefined) {
      field.default = value;
      delete field.defaultExpr;
      if (field.type === 'other') {
        field.type =
          typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal panel — CLI coding harnesses in a real PTY (see electron/terminal.js)
// ---------------------------------------------------------------------------

const terminal = require('./terminal');

// Events go back to whichever renderer asked, rather than through the main
// window's emitter.
const replyTo = (event) => (channel, payload) => {
  if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
};

ipcMain.handle('term:shells', () => {
  ensureToolPath();
  return terminal.listShells();
});
ipcMain.handle('term:open', (e, opts) => {
  ensureToolPath();
  return terminal.open(replyTo(e), opts || {});
});
ipcMain.handle('term:write', (_e, { id, data } = {}) => terminal.write(id, data));
ipcMain.handle('term:resize', (_e, { id, cols, rows } = {}) => terminal.resize(id, cols, rows));
ipcMain.handle('term:close', (_e, { id } = {}) => terminal.close(id));

app.on('before-quit', () => terminal.closeAll());

// ---------------------------------------------------------------------------
// File watching — reflect external edits back into the app
// ---------------------------------------------------------------------------

let watcher = null;
const selfWrites = new Map(); // absolute path -> timestamp of app-made write

function markSelfWrite(p) {
  selfWrites.set(path.resolve(p), Date.now());
}

ipcMain.handle('watch:start', async (_e, projectPath) => {
  openProjectRoot = path.resolve(projectPath); // scopes the asset protocol
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  const srcDir = path.join(projectPath, 'src');
  if (!fs.existsSync(srcDir)) return { ok: false };

  let pending = new Set();
  let timer = null;
  let cmsTimer = null;

  watcher = fs.watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const name = filename.toString();
    // JSON data files feed the CMS panel, not the page model.
    if (/\.json$/i.test(name)) {
      const full = path.join(srcDir, name);
      const wrote = selfWrites.get(path.resolve(full));
      if (wrote && Date.now() - wrote < 1000) return;
      clearTimeout(cmsTimer);
      cmsTimer = setTimeout(() => send('cms:changed', {}), 200);
      return;
    }
    if (!/\.(astro|md|html)$/i.test(name)) return;
    const full = path.join(srcDir, name);
    // Ignore events caused by the app's own recent writes.
    const wrote = selfWrites.get(path.resolve(full));
    if (wrote && Date.now() - wrote < 1000) return;
    pending.add(full);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending];
      pending = new Set();
      send('fs:changed', { files });
    }, 150);
  });

  // Watch public/ too — external asset changes refresh the Assets panel.
  if (assetsWatcher) {
    assetsWatcher.close();
    assetsWatcher = null;
  }
  const publicDir = path.join(projectPath, 'public');
  if (fs.existsSync(publicDir)) {
    let assetsTimer = null;
    assetsWatcher = fs.watch(publicDir, { recursive: true }, (_event, filename) => {
      if (filename && String(filename).startsWith('.')) return;
      const full = filename ? path.join(publicDir, filename.toString()) : null;
      if (full) {
        const wrote = selfWrites.get(path.resolve(full));
        if (wrote && Date.now() - wrote < 1000) return;
      }
      clearTimeout(assetsTimer);
      assetsTimer = setTimeout(() => send('assets:changed', {}), 200);
    });
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Assets (public/) — list, upload, move, rename, folders
// ---------------------------------------------------------------------------

let assetsWatcher = null;

const publicDirOf = (projectPath) => path.join(projectPath, 'public');

// Refuses paths that escape public/.
function assetAbs(projectPath, rel) {
  const abs = path.resolve(publicDirOf(projectPath), rel || '');
  if (!abs.startsWith(path.resolve(publicDirOf(projectPath)))) {
    throw new Error('Invalid asset path');
  }
  return abs;
}

// A destination name that doesn't collide: name.ext, name-1.ext, name-2.ext …
function uniqueDest(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${i++}${ext}`;
  }
  return path.join(dir, candidate);
}

ipcMain.handle('assets:list', async (_e, projectPath) => {
  const root = publicDirOf(projectPath);
  const entries = [];
  if (!fs.existsSync(root)) return { entries, missing: true };
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push({ rel: entryRel, name: entry.name, parent: rel, isDir: true });
        walk(full, entryRel);
      } else {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* race */
        }
        entries.push({
          rel: entryRel,
          name: entry.name,
          parent: rel,
          isDir: false,
          size,
          abs: full,
        });
      }
    }
  };
  walk(root, '');
  return { entries };
});

// Opens a picker and copies the chosen files into public/<destRel>.
ipcMain.handle('assets:pickUpload', async (_e, { projectPath, destRel }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Upload assets',
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return { added: 0 };
  return copyAssetsIn(projectPath, destRel, result.filePaths);
});

// Copies OS-dragged files into public/<destRel>.
ipcMain.handle('assets:upload', async (_e, { projectPath, destRel, filePaths }) => {
  return copyAssetsIn(projectPath, destRel, filePaths || []);
});

function copyAssetsIn(projectPath, destRel, filePaths) {
  const destDir = assetAbs(projectPath, destRel);
  fs.mkdirSync(destDir, { recursive: true });
  let added = 0;
  for (const src of filePaths) {
    try {
      const dest = uniqueDest(destDir, path.basename(src));
      markSelfWrite(dest);
      fs.cpSync(src, dest, { recursive: true });
      added++;
    } catch {
      /* skip unreadable file */
    }
  }
  send('assets:changed', {});
  return { added };
}

ipcMain.handle('assets:move', async (_e, { projectPath, fromRel, toDirRel }) => {
  const from = assetAbs(projectPath, fromRel);
  const toDir = assetAbs(projectPath, toDirRel);
  if (!fs.existsSync(from)) return { ok: false };
  // Refuse moving a folder into itself/its own subtree.
  if (fs.statSync(from).isDirectory() && (toDir === from || toDir.startsWith(from + path.sep))) {
    throw new Error('Cannot move a folder into itself.');
  }
  const dest = uniqueDest(toDir, path.basename(from));
  markSelfWrite(from);
  markSelfWrite(dest);
  fs.mkdirSync(toDir, { recursive: true });
  fs.renameSync(from, dest);
  send('assets:changed', {});
  return { ok: true };
});

ipcMain.handle('assets:rename', async (_e, { projectPath, rel, newName }) => {
  const clean = String(newName).trim().replace(/[/\\]/g, '');
  if (!clean) throw new Error('Invalid name');
  const from = assetAbs(projectPath, rel);
  const dest = path.join(path.dirname(from), clean);
  if (dest === from) return { ok: true };
  if (fs.existsSync(dest)) throw new Error('Something with that name already exists.');
  markSelfWrite(from);
  markSelfWrite(dest);
  fs.renameSync(from, dest);
  send('assets:changed', {});
  return { ok: true };
});

// Text assets (css/js/json/svg/…) are editable in the floating code window.
const MAX_EDITABLE_BYTES = 5 * 1024 * 1024;

ipcMain.handle('assets:readText', async (_e, { projectPath, rel }) => {
  const abs = assetAbs(projectPath, rel);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_EDITABLE_BYTES) {
    throw new Error('That file is too large to edit in the app (over 5 MB).');
  }
  return { text: fs.readFileSync(abs, 'utf8') };
});

ipcMain.handle('assets:writeText', async (_e, { projectPath, rel, text }) => {
  const abs = assetAbs(projectPath, rel);
  markSelfWrite(abs);
  fs.writeFileSync(abs, text, 'utf8');
  return { ok: true };
});

ipcMain.handle('assets:mkdir', async (_e, { projectPath, parentRel, name }) => {
  const clean = String(name).trim().replace(/[/\\]/g, '');
  if (!clean) throw new Error('Invalid folder name');
  const dir = path.join(assetAbs(projectPath, parentRel), clean);
  markSelfWrite(dir);
  fs.mkdirSync(dir, { recursive: true });
  send('assets:changed', {});
  return { ok: true };
});

// ---------------------------------------------------------------------------
// CMS — JSON data files under src/ edited as collections
// ---------------------------------------------------------------------------

const MAX_CMS_BYTES = 2 * 1024 * 1024;
// Config files that happen to live in src/ aren't content.
const CMS_SKIP = /^(tsconfig|jsconfig|package|package-lock|env\.d)\.json$/i;

// Refuses paths that escape src/.
function cmsAbs(projectPath, rel) {
  const root = path.resolve(projectPath, 'src');
  const abs = path.resolve(root, rel || '');
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Invalid data path');
  return abs;
}

// Every .json under src/, with its parsed contents. Files are small enough
// that parsing them all up front is cheaper than a round trip per collection,
// and it lets the panel show item counts without opening anything.
ipcMain.handle('cms:list', async (_e, projectPath) => {
  const root = path.join(projectPath, 'src');
  const files = [];
  if (!fs.existsSync(root)) return { files };
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, entryRel);
      } else if (/\.json$/i.test(entry.name) && !CMS_SKIP.test(entry.name)) {
        const file = { rel: entryRel, name: entry.name, dir: rel, abs: full };
        try {
          const stat = fs.statSync(full);
          file.size = stat.size;
          if (stat.size > MAX_CMS_BYTES) {
            file.error = 'This file is too large to edit here (over 2 MB).';
          } else {
            file.data = JSON.parse(fs.readFileSync(full, 'utf8'));
          }
        } catch (err) {
          file.error = `Not valid JSON — ${String(err.message || err).replace(/\s+in JSON.*$/, '')}`;
        }
        files.push(file);
      }
    }
  };
  walk(root, '');
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files };
});

ipcMain.handle('cms:read', async (_e, { projectPath, rel }) => {
  const abs = cmsAbs(projectPath, rel);
  return { data: JSON.parse(fs.readFileSync(abs, 'utf8')) };
});

// Writes the collection back, matching the file's existing indentation so
// the diff stays limited to what the user actually changed.
ipcMain.handle('cms:write', async (_e, { projectPath, rel, data }) => {
  const abs = cmsAbs(projectPath, rel);
  // A save still in flight when the collection is deleted must not recreate
  // the file — the editor closes a moment after the delete lands.
  if (!fs.existsSync(abs)) throw new Error(`src/${rel} no longer exists.`);
  let indent = 2;
  let trailingNewline = true;
  const before = fs.readFileSync(abs, 'utf8');
  const match = before.match(/\n([ \t]+)\S/);
  if (match) indent = match[1] === '\t' ? '\t' : match[1].length;
  trailingNewline = /\n$/.test(before);
  markSelfWrite(abs);
  fs.writeFileSync(abs, JSON.stringify(data, null, indent) + (trailingNewline ? '\n' : ''), 'utf8');
  return { ok: true };
});

// New collections land in src/data/, the conventional home for Astro content
// that isn't a content collection.
ipcMain.handle('cms:create', async (_e, { projectPath, name }) => {
  const slug = String(name).trim().toLowerCase().replace(/\.json$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('Give the collection a name.');
  const rel = `data/${slug}.json`;
  const abs = cmsAbs(projectPath, rel);
  if (fs.existsSync(abs)) throw new Error(`src/${rel} already exists.`);
  markSelfWrite(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '[]\n', 'utf8');
  send('cms:changed', {});
  return { rel };
});

// A field's type is inferred from its values, which can't tell a phone number
// from a line of text — or anything at all from an empty field. Types the user
// picked explicitly are remembered here, keyed by collection and field path.
const cmsMetaPath = (projectPath) => path.join(projectPath, '.stacki', 'cms.json');

function readCmsMeta(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(cmsMetaPath(projectPath), 'utf8'));
  } catch {
    return {};
  }
}

ipcMain.handle('cms:meta', async (_e, projectPath) => ({ meta: readCmsMeta(projectPath) }));

ipcMain.handle('cms:setMeta', async (_e, { projectPath, rel, fields }) => {
  const meta = readCmsMeta(projectPath);
  if (fields && Object.keys(fields).length) meta[rel] = fields;
  else delete meta[rel];
  const file = cmsMetaPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { ok: true };
});

// Deleting a collection rewrites the pages that imported it (see cmsRefs.js):
// the import becomes `const clients = []`, which leaves every
// `clients.map(...)` on the page working and rendering nothing.

ipcMain.handle('cms:usage', async (_e, { projectPath, rel }) => {
  const abs = cmsAbs(projectPath, rel);
  return { files: importersOf(projectPath, abs).map((h) => h.rel) };
});

ipcMain.handle('cms:delete', async (_e, { projectPath, rel }) => {
  const abs = cmsAbs(projectPath, rel);
  const hits = importersOf(projectPath, abs);
  for (const hit of hits) {
    markSelfWrite(hit.file);
    fs.writeFileSync(hit.file, hit.next, 'utf8');
  }
  await shell.trashItem(abs);
  const meta = readCmsMeta(projectPath);
  if (meta[rel]) {
    delete meta[rel];
    fs.writeFileSync(cmsMetaPath(projectPath), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  }
  send('cms:changed', {});
  // Our own writes are invisible to the watcher, so tell the app directly —
  // an open page holding the old import needs to reload.
  if (hits.length) send('fs:changed', { files: hits.map((h) => h.file) });
  return { ok: true, rewritten: hits.map((h) => h.rel) };
});

// ---------------------------------------------------------------------------
// HTML chunks — resolution lives in astroParser so the dev server's marker
// config can reuse it (see writeMarkerConfig).
// ---------------------------------------------------------------------------

// Writes any edited chunk subtrees back to their .html files. Compares
// normalized (reparsed) forms so untouched chunks aren't rewritten just for
// formatting differences.
function writeChunks(model) {
  const walk = (list) => {
    for (const node of list) {
      if (node.chunkFile && Array.isArray(node.children)) {
        const next = serializeNodes(node.children);
        let unchanged = false;
        try {
          const disk = fs.readFileSync(node.chunkFile, 'utf8');
          const parsed = parseTemplate(disk);
          unchanged = parsed.clean && serializeNodes(parsed.nodes) === next;
        } catch {
          /* file missing — write it */
        }
        if (!unchanged) {
          markSelfWrite(node.chunkFile);
          fs.writeFileSync(node.chunkFile, next, 'utf8');
        }
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(model.nodes);
}

// ---------------------------------------------------------------------------
// Page IPC
// ---------------------------------------------------------------------------

ipcMain.handle('page:read', async (_e, pagePath) => {
  const source = fs.readFileSync(pagePath, 'utf8');
  if (pagePath.endsWith('.md')) {
    return { editable: false, reason: 'Markdown pages open in code view.', source };
  }
  const parsed = parsePage(source);
  if (parsed.editable) resolveChunks(parsed.model, pagePath);
  return { ...parsed, source };
});

// Astro's dev server serves a page's <style> block ONE EDIT BEHIND: after the file
// changes it re-renders the HTML correctly, but hands the browser the *previous*
// transform of `…?astro&type=style&…`, and that module overwrites the (correct) CSS
// inlined in the SSR'd HTML. So a style edit only appeared on the canvas once the NEXT
// edit pushed the stale transform along — which read as "the panel writes the wrong
// value". Writing the same bytes a second time flushes it. Plain .css files transform
// correctly, so this is only for .astro files that carry a <style> block.
const STYLE_NUDGE_MS = 150;
const styleNudges = new Map(); // path -> pending timer

function writePageText(pagePath, text) {
  markSelfWrite(pagePath);
  fs.writeFileSync(pagePath, text, 'utf8');
  if (!/<style[\s>]/i.test(text)) return;
  clearTimeout(styleNudges.get(pagePath)); // a newer edit supersedes this one's nudge
  styleNudges.set(
    pagePath,
    setTimeout(() => {
      styleNudges.delete(pagePath);
      try {
        // Skip it if anything has changed the file since — the nudge must never
        // resurrect text that's already been superseded.
        if (fs.readFileSync(pagePath, 'utf8') !== text) return;
        markSelfWrite(pagePath);
        fs.writeFileSync(pagePath, text, 'utf8');
      } catch {
        /* file moved or deleted — nothing to flush */
      }
    }, STYLE_NUDGE_MS)
  );
}

ipcMain.handle('page:write', async (_e, { pagePath, model }) => {
  writePageText(pagePath, serializePage(model));
  writeChunks(model);
  return { ok: true };
});

ipcMain.handle('page:writeRaw', async (_e, { pagePath, source }) => {
  writePageText(pagePath, source);
  return { ok: true };
});

ipcMain.handle('page:create', async (_e, { projectPath, name, layout }) => {
  const pagesDir = path.join(projectPath, 'src', 'pages');
  let fileName = name.trim().replace(/\.astro$/i, '');
  fileName = fileName.replace(/[^a-zA-Z0-9/_-]+/g, '-');
  if (!fileName) throw new Error('Invalid page name');
  const pagePath = path.join(pagesDir, fileName + '.astro');
  if (fs.existsSync(pagePath)) throw new Error('A page with that name already exists.');
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });

  const model = { imports: [], extraFrontmatter: '', nodes: [] };
  if (layout) {
    const rel = toPosix(path.relative(path.dirname(pagePath), layout.path));
    model.imports.push({ name: layout.name, path: rel.startsWith('.') ? rel : './' + rel });
    model.nodes.push({ id: 'layout', kind: 'component', name: layout.name, props: {}, children: [] });
  }
  markSelfWrite(pagePath);
  fs.writeFileSync(pagePath, serializePage(model), 'utf8');
  return { pagePath };
});

ipcMain.handle('page:delete', async (_e, pagePath) => {
  markSelfWrite(pagePath);
  fs.rmSync(pagePath);
  return { ok: true };
});

// Moves/renames a page within src/pages. `to` is the new path relative to
// the pages dir (with extension). When the folder changes, relative imports
// in the file's frontmatter are rewritten so they keep resolving.
ipcMain.handle('page:move', async (_e, { projectPath, from, to }) => {
  const pagesDir = path.join(projectPath, 'src', 'pages');
  const dest = path.resolve(pagesDir, to);
  if (!dest.startsWith(pagesDir + path.sep)) throw new Error('Invalid destination.');
  if (path.resolve(from) === dest) return { newPath: dest };
  if (fs.existsSync(dest)) throw new Error('A page with that name already exists there.');
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let source = fs.readFileSync(from, 'utf8');
  const fromDir = path.dirname(from);
  const toDir = path.dirname(dest);
  if (path.resolve(fromDir) !== path.resolve(toDir)) {
    source = source.replace(
      /(import\s[^'"]*?from\s*['"])(\.\.?\/[^'"]+)(['"])/g,
      (m, pre, spec, post) => {
        const abs = path.resolve(fromDir, spec);
        let rel = toPosix(path.relative(toDir, abs));
        if (!rel.startsWith('.')) rel = './' + rel;
        return pre + rel + post;
      }
    );
  }
  markSelfWrite(from);
  markSelfWrite(dest);
  fs.writeFileSync(dest, source, 'utf8');
  fs.rmSync(from);
  return { newPath: dest };
});

// Folder management under src/pages. Renames are same-parent only (from the
// UI), so contained files keep their relative-import depth.
const resolvePagesDir = (projectPath, rel) => {
  const pagesDir = path.join(projectPath, 'src', 'pages');
  const full = path.resolve(pagesDir, rel);
  if (full !== pagesDir && !full.startsWith(pagesDir + path.sep)) {
    throw new Error('Invalid folder.');
  }
  return full;
};

ipcMain.handle('pagefolder:create', async (_e, { projectPath, dir }) => {
  fs.mkdirSync(resolvePagesDir(projectPath, dir), { recursive: true });
  return { ok: true };
});

ipcMain.handle('pagefolder:rename', async (_e, { projectPath, from, to }) => {
  const a = resolvePagesDir(projectPath, from);
  const b = resolvePagesDir(projectPath, to);
  if (fs.existsSync(b)) throw new Error('A folder with that name already exists.');
  fs.renameSync(a, b);
  return { ok: true };
});

ipcMain.handle('pagefolder:delete', async (_e, { projectPath, dir }) => {
  const full = resolvePagesDir(projectPath, dir);
  const pagesDir = path.join(projectPath, 'src', 'pages');
  if (full === pagesDir) throw new Error('Invalid folder.');
  fs.rmSync(full, { recursive: true, force: true });
  return { ok: true };
});

ipcMain.handle('page:importPathFor', async (_e, { pagePath, targetPath, projectPath }) => {
  const rel = toPosix(path.relative(path.dirname(pagePath), targetPath));
  const relative = rel.startsWith('.') ? rel : './' + rel;
  let srcRelative = null;
  if (projectPath) {
    const srcDir = path.join(projectPath, 'src');
    if (targetPath.startsWith(srcDir + path.sep)) {
      srcRelative = toPosix(path.relative(srcDir, targetPath));
    }
  }
  return { relative, srcRelative };
});

// ---------------------------------------------------------------------------
// Dev server IPC
// ---------------------------------------------------------------------------

function stopDevServer() {
  if (!devServer) return;
  const { proc, daemon, bin, projectPath } = devServer;
  devServer = null;
  // Daemonized servers (Astro >= 7 forks a background process) stop via the CLI.
  if (daemon && bin) {
    try {
      const [cmd, argv] = nodeCliCommand(bin, ['dev', 'stop']);
      execFile(cmd, argv, { cwd: projectPath, timeout: 10000 }, () => {});
    } catch {
      /* best effort */
    }
    return;
  }
  // External servers (started by the user, e.g. in a terminal) are never killed.
  if (!proc) return;
  try {
    if (isWin) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: true });
    } else {
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

let devLogBuffer = [];

function pushDevLog(chunk) {
  devLogBuffer.push(chunk);
  // Keep roughly the last 200 chunks.
  if (devLogBuffer.length > 200) devLogBuffer = devLogBuffer.slice(-200);
  send('dev:log', chunk);
}

function recentDevLog(maxChars = 1200) {
  const text = devLogBuffer.join('').replace(/\x1b\[[0-9;]*m/g, '');
  return text.slice(-maxChars).trim();
}

function portAnswers(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    sock.setTimeout(1500);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => resolve(false));
  });
}

// Astro >= 5 keeps a per-project single-instance lock and reports the
// already-running server's URL when it refuses to start. The message format
// varies: "already running.\n  URL: http://..." on a TTY, or a JSON log line
// "Dev server already running at http://localhost:4322 (pid 69052)" otherwise —
// so grab the first URL that follows "already running".
function parseExistingServer(log) {
  const m = log.match(/already running[\s\S]*?(https?:\/\/[^\s"\\)]+)/i);
  return m ? m[1].replace(/\/+$/, '') : null;
}

// Wraps the project's Astro config (dev preview only) with a Vite plugin
// that swaps each page's source for a marker-annotated equivalent — every
// model node is wrapped in <template data-avb-s/e="path"> pairs so the
// preview can outline the node selected/hovered in the app. Written into
// node_modules/.avb so it never shows up in the user's git status; the file
// on disk is untouched.
// Renders one component in isolation for the palette hover preview (served
// at /__avb/preview?c=Name by the injected route below). Project styles are
// eagerly imported so components look like they do on the site, and
// placeholder slot content is passed so slot-driven components (buttons,
// headings, wrappers) render something visible instead of an empty shell.
// The stage lays out at a desktop width, then a fit script scales the
// rendered content to fill the card.
const PREVIEW_PAGE = `---
// Generated by Stacki (dev preview only) — do not edit.
// On-demand so Astro.url keeps its query string (prerendered pages get
// their searchParams stripped, even in dev).
export const prerender = false;
const styles = import.meta.glob('/src/styles/**/*.{css,scss}', { eager: true });
const mods = import.meta.glob('/src/components/**/*.astro');
const name = Astro.url.searchParams.get('c') || '';
let C = null;
if (/^[A-Za-z][\\w-]*$/.test(name)) {
  for (const [p, load] of Object.entries(mods)) {
    if (p.endsWith('/' + name + '.astro')) {
      C = (await load()).default;
      break;
    }
  }
}
---
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; background: #f2f2f2; }
      #avb-stage {
        position: absolute;
        top: 0;
        left: 0;
        width: 1200px;
        transform-origin: 0 0;
        visibility: hidden;
      }
      #avb-empty {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 16px;
        text-align: center;
        font: 12px/1.5 -apple-system, system-ui, sans-serif;
        color: #8a8a8a;
      }
      body.avb-is-empty #avb-empty { display: flex; }
    </style>
  </head>
  <body>
    <div id="avb-stage">{C ? <C>{name}</C> : null}</div>
    <div id="avb-empty">Nothing to preview — this component needs props or slot content.</div>
    <script is:inline>
      (function () {
        var stage = document.getElementById('avb-stage');
        var PAD = 12;
        // Fixed/sticky descendants are out of flow: untransformed they anchor
        // to the iframe viewport (so they measure small), then re-anchor to
        // the transformed stage and spill past the card. Pin them into flow
        // with an inline style, which outranks any stylesheet rule.
        function unfix() {
          var all = stage.querySelectorAll('*');
          for (var i = -1; i < all.length; i++) {
            var el = i < 0 ? stage.firstElementChild : all[i];
            if (!el) continue;
            var p = getComputedStyle(el).position;
            if (p === 'fixed' || p === 'sticky') el.style.position = 'relative';
          }
        }
        function bbox(el) {
          var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
          for (var i = 0; i < el.children.length; i++) {
            var q = el.children[i].getBoundingClientRect();
            if (!q.width && !q.height) continue;
            l = Math.min(l, q.left); t = Math.min(t, q.top);
            r = Math.max(r, q.right); b = Math.max(b, q.bottom);
          }
          return isFinite(l) ? { l: l, t: t, w: r - l, h: b - t } : null;
        }
        var scheduled = false;
        function fit() {
          scheduled = false;
          stage.style.transform = 'none';
          unfix();
          var box = bbox(stage);
          if (!box || box.w < 1 || box.h < 1) {
            document.body.classList.add('avb-is-empty');
            return;
          }
          document.body.classList.remove('avb-is-empty');
          var aw = window.innerWidth - PAD * 2;
          var ah = window.innerHeight - PAD * 2;
          var s = Math.min(1, aw / box.w, ah / box.h);
          var tx = PAD + (aw - box.w * s) / 2 - box.l * s;
          var ty = PAD + (ah - box.h * s) / 2 - box.t * s;
          stage.style.transform =
            'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
          stage.style.visibility = 'visible';
        }
        function refit() {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(fit);
        }
        fit();
        // In dev, Vite injects component CSS asynchronously and images decode
        // later — both change the layout after the first fit, which would
        // leave the stage unscaled and spilling past the card. Re-fit on any
        // size change, on late <style>/<link> injection, and on media load.
        window.addEventListener('load', refit);
        window.addEventListener('resize', refit);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
        if (window.ResizeObserver) {
          var ro = new ResizeObserver(refit);
          ro.observe(stage);
          for (var i = 0; i < stage.children.length; i++) ro.observe(stage.children[i]);
        }
        new MutationObserver(refit).observe(document.head, { childList: true, subtree: true });
        new MutationObserver(refit).observe(stage, { childList: true, subtree: true });
        document.addEventListener('load', refit, true); // images/iframes
        [60, 200, 600, 1200].forEach(function (ms) { setTimeout(refit, ms); });
      })();
    </script>
  </body>
</html>
`;

function writeMarkerConfig(projectPath) {
  try {
    const dir = path.join(projectPath, 'node_modules', '.avb');
    fs.mkdirSync(dir, { recursive: true });
    const userCfg = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'].find((f) =>
      fs.existsSync(path.join(projectPath, f))
    );
    // The dev server is a plain Node process, and plain Node can't read
    // inside app.asar — it would fail the config import and take the whole
    // preview down. build.asarUnpack keeps a real copy on disk beside the
    // archive; this points at that copy. Unpacked in dev too (no asar in the
    // path), so the replace is a no-op there.
    const parserPath = path
      .join(__dirname, 'astroParser.js')
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const pagesDir = toPosix(path.join(projectPath, 'src', 'pages'));
    const cfg = `// Generated by Stacki (dev preview only) — do not edit.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
${userCfg ? `import userConfig from '../../${userCfg}';` : 'const userConfig = {};'}

const require = createRequire(import.meta.url);
const { parsePage, serializePageMarked, resolveChunks, markChunkHtml } = require(${JSON.stringify(
      parserPath
    )});
const PAGES_DIR = ${JSON.stringify(pagesDir)};

// Must hook \`load\` (not \`transform\`): Astro's own compiler plugin is also
// enforce:'pre' and runs first, so a transform would receive compiled JS —
// and returning Astro source at that point breaks the module graph.
const avbMarkers = {
  name: 'avb-node-markers',
  enforce: 'pre',
  load(id) {
    const qi = id.indexOf('?');
    const file = qi === -1 ? id : id.slice(0, qi);
    const query = qi === -1 ? '' : id.slice(qi + 1);
    // A <Fragment set:html={x} /> renders from an imported HTML string, so
    // the page's own markers can't reach inside it. serializePageMarked tags
    // the ?raw import with the Fragment's path; mark the chunk here so its
    // nodes outline like any other. Runs before vite:asset's own ?raw load.
    if (query) {
      const m = /(?:^|&)avb=([\\d.]+)/.exec(query);
      if (!m) return null;
      try {
        const marked = markChunkHtml(
          readFileSync(file, 'utf8'),
          m[1],
          /(?:^|&)avbg=1(?:&|$)/.test(query)
        );
        return marked == null ? null : 'export default ' + JSON.stringify(marked) + ';';
      } catch {
        return null;
      }
    }
    if (!file.endsWith('.astro') || !file.startsWith(PAGES_DIR + '/')) return null;
    try {
      const parsed = parsePage(readFileSync(file, 'utf8'));
      if (!parsed.editable) return null;
      resolveChunks(parsed.model, file);
      return serializePageMarked(parsed.model);
    } catch {
      return null;
    }
  },
};

// Isolated component previews for the palette hover cards.
const avbPreviewRoute = {
  name: 'avb-preview-route',
  hooks: {
    'astro:config:setup': ({ injectRoute }) => {
      injectRoute({ pattern: '/__avb/preview', entrypoint: ${JSON.stringify(
        toPosix(path.join(dir, 'preview.astro'))
      )} });
    },
  },
};

const base = userConfig || {};
export default {
  ...base,
  // The floating dev toolbar is viewport-fixed clutter in an editor canvas,
  // and it would sit on top of component thumbnails. Only this app's dev
  // server is affected — the project's own \`astro dev\` is untouched.
  devToolbar: { enabled: false },
  integrations: [...(base.integrations || []), avbPreviewRoute],
  vite: {
    ...(base.vite || {}),
    plugins: [avbMarkers, ...((base.vite && base.vite.plugins) || [])],
  },
};
`;
    const cfgPath = path.join(dir, 'astro.config.mjs');
    fs.writeFileSync(cfgPath, cfg);
    fs.writeFileSync(path.join(dir, 'preview.astro'), PREVIEW_PAGE);
    return cfgPath;
  } catch {
    return null; // preview still works, just without outlines
  }
}

async function spawnDevServer(projectPath, localBin, force) {
  const port = await findFreePort(4321);
  const args = ['dev', '--port', String(port), '--host', '127.0.0.1'];
  // Astro resolves --config against the project root and rejects absolute
  // paths ([ConfigNotFound]), so pass it relative to the spawn cwd.
  const markerCfg = writeMarkerConfig(projectPath);
  if (markerCfg) args.push('--config', toPosix(path.relative(projectPath, markerCfg)));
  if (force) args.push('--force');

  const [cmd, argv] = nodeCliCommand(localBin, args);
  const proc = spawn(cmd, argv, {
    cwd: projectPath,
    // Only the Windows .cmd shim needs a shell to run at all. Going through
    // one when we have a real node.exe path would re-split it on spaces —
    // "C:\Program Files\nodejs\node.exe" is the common case.
    shell: isWin && cmd === localBin,
    // No stdin pipe — the daemon child can inherit CLI stdio, and a pipe
    // that closes when the CLI exits has been observed to kill it.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  const url = `http://127.0.0.1:${port}`;
  devServer = { proc, url, projectPath, bin: localBin };

  proc.stdout.on('data', (d) => pushDevLog(d.toString()));
  proc.stderr.on('data', (d) => pushDevLog(d.toString()));
  proc.on('error', (err) => pushDevLog(`\n[spawn error] ${err.message}\n`));
  proc.on('exit', (code) => {
    if (devServer && devServer.proc === proc) {
      // Astro >= 7 daemonizes: the CLI exits 0 after forking the real server
      // into a background process. That's a success, not a failure.
      const running = recentDevLog().match(
        /Dev server running at (https?:\/\/[^\s"\\)]+)/i
      );
      if (code === 0 && running) {
        devServer = { proc: null, url, projectPath, daemon: true, bin: localBin };
      } else {
        devServer = null;
        send('dev:exit', { code, log: recentDevLog() });
      }
    }
  });

  // The daemon's own failure reasons only land in `astro dev logs`.
  const failureDetail = async () => {
    let log = recentDevLog();
    try {
      const [logCmd, logArgs] = nodeCliCommand(localBin, ['dev', 'logs']);
      const { stdout } = await new Promise((resolve, reject) =>
        execFile(logCmd, logArgs, { cwd: projectPath, timeout: 10000 }, (err, so) =>
          err ? reject(err) : resolve({ stdout: so.toString() })
        )
      );
      const tail = stdout.trim().split('\n').slice(-12).join('\n');
      if (tail) log += `\n\n— astro dev logs —\n${tail}`;
    } catch {
      /* no daemon logs available */
    }
    return log;
  };

  // Wait until the port answers so the iframe doesn't load into a dead server.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (!devServer) {
      throw new Error('Dev server exited before it was ready.\n\n' + (await failureDetail()));
    }
    if (await portAnswers(port)) return url;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Astro dev server did not start within 60 seconds.\n\n' + (await failureDetail()));
}

// Probes the URL's port on its hostname plus both loopback families —
// on macOS "localhost" may resolve to ::1 while the server listens on IPv4.
async function serverAlive(urlString) {
  const u = new URL(urlString);
  const port = Number(u.port || 80);
  for (const host of [u.hostname, '127.0.0.1', '::1']) {
    if (await portAnswers(port, host)) return true;
  }
  return false;
}

// Astro's daemon lock file (.astro/dev.json) — the source of truth for an
// already-running background server, regardless of who started it.
function readAstroLock(projectPath) {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(projectPath, '.astro', 'dev.json'), 'utf8')
    );
    if (data && data.url) return data;
  } catch {
    /* no lock */
  }
  return null;
}

// Serialize dev:start calls — concurrent spawns race Astro's daemon lock and
// the loser dies with "exited before becoming ready".
let devStartInFlight = null;

ipcMain.handle('dev:start', (_e, projectPath) => {
  if (devStartInFlight) return devStartInFlight;
  devStartInFlight = doDevStart(projectPath).finally(() => {
    devStartInFlight = null;
  });
  return devStartInFlight;
});

async function doDevStart(projectPath) {
  if (devServer && devServer.projectPath === projectPath) {
    // For adopted external servers, make sure it's still alive.
    if (devServer.external) {
      if (await serverAlive(devServer.url)) {
        return { url: devServer.url, external: true };
      }
      devServer = null;
    } else {
      return { url: devServer.url };
    }
  }
  stopDevServer();
  devLogBuffer = [];

  // Without this the failure is the shim's "env: node: No such file or
  // directory", which reads like a broken project rather than a missing tool.
  if (!resolveNodeBin() && !isWin) {
    throw new Error(
      'Node.js could not be found. Stacki launched from the Dock only sees the system PATH, ' +
        'so a Node installed by Homebrew, nvm, fnm, or volta has to be on it. Install Node, ' +
        'or launch Stacki from a terminal, and try again.'
    );
  }

  const binName = isWin ? 'astro.cmd' : 'astro';
  const localBin = path.join(projectPath, 'node_modules', '.bin', binName);
  if (!fs.existsSync(localBin)) {
    // Dependencies missing or incomplete — install with the right PM first.
    await installDependencies(projectPath);
    send('progress', { message: null });
    if (!fs.existsSync(localBin)) {
      throw new Error('astro is not installed in this project (no node_modules/.bin/astro after install). Is astro listed in package.json dependencies?');
    }
  }

  // A lock file means a daemon exists (possibly stale, possibly started
  // without the app's marker config) — pass --force so ours replaces it.
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const force = attempt > 0 || !!readAstroLock(projectPath);
    try {
      // Retry with --force: first-attempt daemon startup can flake (stale
      // daemon state, vite re-optimizing after a config change).
      return { url: await spawnDevServer(projectPath, localBin, force) };
    } catch (err) {
      lastErr = err;
      // Another dev server already running for this project?
      const existing = parseExistingServer(recentDevLog());
      if (existing) {
        const alive = await serverAlive(existing);
        if (alive) {
          // Adopt the user's own server instead of fighting it.
          devServer = { proc: null, url: existing, projectPath, external: true };
          return { url: existing, external: true };
        }
      }
      devLogBuffer = [];
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Style sources
//
// Where the style panel can author CSS: every stylesheet in the project, plus
// (added on the renderer side) the <style> blocks on the current page and in
// its components. Anything under node_modules, dist or the app's own generated
// config is skipped — those aren't the author's to edit.
// ---------------------------------------------------------------------------

// Same containment rule the asset protocol uses: the style panel writes only
// inside the project that is currently open.
function assertInProject(filePath) {
  const abs = path.resolve(String(filePath || ""));
  if (!openProjectRoot || !(abs + path.sep).startsWith(openProjectRoot + path.sep)) {
    throw new Error("Refusing to touch a file outside the open project.");
  }
  return abs;
}

const CSS_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', 'release', '.avb']);

function listCssFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (CSS_SKIP_DIRS.has(entry.name)) continue;
        walk(full, relPath);
      } else if (/\.(css|scss|sass|less)$/i.test(entry.name)) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* unreadable — still list it, the read will report the error */
        }
        out.push({ rel: toPosix(relPath), name: entry.name, path: full, size });
      }
    }
  };
  walk(root, '');
  // Shallow paths first (src/styles/global.css before a deeply nested partial),
  // then alphabetical — the file you want is usually near the top of the tree.
  return out.sort((a, b) => {
    const da = a.rel.split('/').length;
    const db = b.rel.split('/').length;
    return da - db || a.rel.localeCompare(b.rel);
  });
}

ipcMain.handle('style:listFiles', async (_e, projectPath) => {
  if (!projectPath) return { files: [] };
  return { files: listCssFiles(projectPath) };
});

ipcMain.handle('style:readFile', async (_e, filePath) => {
  const abs = assertInProject(filePath);
  return { css: fs.readFileSync(abs, 'utf8') };
});

ipcMain.handle('style:writeFile', async (_e, { filePath, css }) => {
  const abs = assertInProject(filePath);
  markSelfWrite(abs); // the watcher must not treat our own write as external
  fs.writeFileSync(abs, css, 'utf8');
  return { ok: true };
});

ipcMain.handle('dev:stop', async () => {
  stopDevServer();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Why the dev server won't start
//
// A raw Astro log tells a user nothing actionable. Nearly every failure that
// isn't the project's own code is one of: no Node at all, a Node too old for
// the version of Astro the project pins, or dependencies never installed —
// so name which one it is and what the project actually needs.
// ---------------------------------------------------------------------------

// engines.node ranges as they're actually written ("18.20.8 || ^20.3.0 ||
// >=22.0.0", ">=22.12.0"). Anything this can't parse counts as satisfied:
// the point is to explain a failure that already happened, never to block a
// launch over a range we couldn't read.
function satisfiesRange(version, range) {
  if (!version || !range) return true;
  const parse = (v) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v));
    return m ? [+m[1], +m[2], +m[3]] : null;
  };
  const cur = parse(version);
  if (!cur) return true;
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return range.split('||').some((partRaw) => {
    const part = partRaw.trim();
    const target = parse(part);
    if (!target) return true; // "*", "latest", something exotic — don't judge
    if (part.startsWith('>=')) return cmp(cur, target) >= 0;
    if (part.startsWith('>')) return cmp(cur, target) > 0;
    if (part.startsWith('^')) return cur[0] === target[0] && cmp(cur, target) >= 0;
    if (part.startsWith('~')) return cur[0] === target[0] && cur[1] === target[1] && cmp(cur, target) >= 0;
    return cmp(cur, target) === 0;
  });
}

function nodeVersionOf(bin) {
  try {
    return execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

ipcMain.handle('dev:diagnose', async (_e, projectPath) => {
  const nodePath = resolveNodeBin();
  const nodeVersion = nodePath ? nodeVersionOf(nodePath) : null;

  let astroVersion = null;
  let requires = null;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectPath, 'node_modules', 'astro', 'package.json'), 'utf8')
    );
    astroVersion = pkg.version || null;
    requires = (pkg.engines && pkg.engines.node) || null;
  } catch {
    /* astro not installed — reported as its own kind below */
  }

  const hasDeps = fs.existsSync(path.join(projectPath, 'node_modules'));
  const nodeOk = nodeVersion ? satisfiesRange(nodeVersion, requires) : false;

  let kind = 'unknown';
  if (!nodePath) kind = 'no-node';
  else if (!hasDeps || !astroVersion) kind = 'no-deps';
  else if (!nodeOk) kind = 'node-too-old';

  return { kind, nodePath, nodeVersion, astroVersion, requires, launchedFromGui: !process.env.SHELL };
});

// ---------------------------------------------------------------------------
// Git / GitHub IPC
// ---------------------------------------------------------------------------

ipcMain.handle('git:info', async (_e, projectPath) => {
  try {
    await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { isRepo: false };
  }
  const info = { isRepo: true, branch: '', branches: [], remote: null, dirty: false, ahead: 0 };
  try {
    info.branch = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    info.branch = '(no commits yet)';
  }
  try {
    info.branches = (await git(projectPath, ['branch', '--format=%(refname:short)'])).stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    /* empty repo */
  }
  try {
    info.remote = (await git(projectPath, ['remote', 'get-url', 'origin'])).stdout.trim() || null;
  } catch {
    info.remote = null;
  }
  try {
    const out = (await git(projectPath, ['status', '--porcelain'])).stdout;
    // Porcelain v1 is "XY path" — two status columns, a space, then the path
    // (renames as "old -> new"). Don't trim the line before slicing: the
    // first column is a space for worktree-only changes.
    const lines = out.split('\n').filter((l) => l.trim());
    info.dirty = lines.length > 0;
    info.dirtyFiles = lines.slice(0, 50).map((l) => {
      const p = l.slice(3);
      const arrow = p.lastIndexOf(' -> ');
      return (arrow === -1 ? p : p.slice(arrow + 4)).replace(/^"|"$/g, '');
    });
  } catch {
    /* ignore */
  }
  // Without an upstream there's no count to give — and "0 ahead" would read
  // as "nothing to push" when in fact the branch has never been pushed at
  // all, so the two cases have to stay distinguishable.
  try {
    await git(projectPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    info.hasUpstream = true;
  } catch {
    info.hasUpstream = false;
  }
  if (info.hasUpstream) {
    try {
      const counts = (
        await git(projectPath, ['rev-list', '--count', '--left-only', 'HEAD...@{upstream}'])
      ).stdout.trim();
      info.ahead = parseInt(counts, 10) || 0;
    } catch {
      info.ahead = 0;
    }
  }
  return info;
});

// Is the GitHub CLI usable? Checked when the publish dialog opens so a
// missing or logged-out `gh` is stated up front, instead of surfacing as a
// failure after the user has filled the form in.
ipcMain.handle('git:ghStatus', async (_e, projectPath) => {
  try {
    await run('gh', ['--version'], projectPath);
  } catch {
    return { installed: false, authed: false };
  }
  try {
    // Writes its report to stderr and exits non-zero when logged out.
    const r = await run('gh', ['auth', 'status'], projectPath);
    const out = `${r.stdout}${r.stderr}`;
    const m = out.match(/(?:account|as)\s+([\w-]+)/i);
    return { installed: true, authed: true, user: m ? m[1] : null };
  } catch {
    return { installed: true, authed: false };
  }
});

ipcMain.handle('git:init', async (_e, projectPath) => {
  await git(projectPath, ['init', '-b', 'main']);
  return { ok: true };
});

ipcMain.handle('git:checkout', async (_e, { projectPath, branch, create }) => {
  const args = create ? ['checkout', '-b', branch] : ['checkout', branch];
  try {
    await git(projectPath, args);
  } catch (err) {
    const detail = String(err.stderr || err.message || '');
    // Git refuses to switch when the working tree would be clobbered, and
    // leaves HEAD where it was — every later edit then lands on the branch
    // the user thought they left. Say so plainly instead of passing the raw
    // porcelain through.
    if (/would be overwritten|Please commit your changes|overwritten by checkout/i.test(detail)) {
      const files = detail
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^(error|Please|Aborting|warning)/i.test(l) && !l.endsWith(':'));
      throw new Error(
        `Still on "${(await currentBranch(projectPath)) || 'this branch'}" — switching to "${branch}" would overwrite uncommitted changes` +
          (files.length ? ` in ${files.slice(0, 4).join(', ')}` : '') +
          '. Commit them first, then switch.'
      );
    }
    throw new Error(detail.trim() || `Could not switch to "${branch}".`);
  }
  return { ok: true };
});

async function currentBranch(projectPath) {
  try {
    return (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  } catch {
    return null;
  }
}

ipcMain.handle('git:commit', async (_e, { projectPath, message }) => {
  await git(projectPath, ['add', '-A']);
  await git(projectPath, ['commit', '-m', message || 'Update from Stacki']);
  return { ok: true };
});

ipcMain.handle('git:push', async (_e, { projectPath, branch }) => {
  await git(projectPath, ['push', '-u', 'origin', branch], { timeout: 120000 });
  return { ok: true };
});

ipcMain.handle('git:publish', async (_e, { projectPath, repoName, isPrivate }) => {
  try {
    await run('gh', ['--version'], projectPath);
  } catch {
    throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run `gh auth login`.');
  }
  const args = [
    'repo',
    'create',
    repoName,
    isPrivate ? '--private' : '--public',
    '--source',
    '.',
    '--remote',
    'origin',
    '--push',
  ];
  const result = await run('gh', args, projectPath, { timeout: 180000 });
  const output = result.stdout + result.stderr;
  // gh prints the new repo's URL; fall back to the remote it just set.
  let url = (output.match(/https:\/\/github\.com\/[^\s"']+/) || [])[0] || null;
  if (!url) {
    try {
      url = (await git(projectPath, ['remote', 'get-url', 'origin'])).stdout.trim() || null;
    } catch {
      /* no remote — caller just won't get a link */
    }
  }
  if (url) url = url.replace(/[.,)]+$/, '').replace(/\.git$/, '');
  return { ok: true, url, output };
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});
