import { registerPublishHandlers } from './handlers/publishHandlers';
import { registerProjectMetadataHandlers } from './handlers/projectMetadataHandlers';
import { registerImageConversionHandler } from './handlers/imageConversionHandler';
import { registerGitRepositoryHandlers } from './handlers/gitRepositoryHandlers';
import { listenForPreviewFailures } from './preview/previewFailure';
import { registerStudioHandlers } from './handlers/studioHandlers';
import { createIpcRegistrar } from './lib/ipcRegistrar';
import { RUNTIME_PATHS, resourcePath } from './lib/runtimePaths';
import { readSource } from './lib/mainLimits';
import { isAtomicTemporary } from './documents/atomicWrite';
import { createNodeDocumentActors } from './documents/documentActors';
import { documentHost, installDocumentHost } from './documents/documentWrites';
import { isPathDescendant, sameFilesystemPath } from './lib/platform';
import type {
  BrowserWindow as Window,
  MenuItemConstructorOptions,
  MessageBoxOptions,
  OpenDialogOptions,
} from 'electron';
import { toRecord } from '../shared/core/record';
import { parseOptionalString, parseRecents, parseSettings } from './app/mainValidation';
import type { AppSettings } from './app/mainValidation';
import {
  sendUsageCount,
  shouldCountUsage,
  usageDay,
  USAGE_NOTICE_VERSION,
} from './app/usageCounts';
import type { RecentProject } from './lib/mainTypes';
import {
  app,
  BrowserWindow,
  screen,
  ipcMain as nativeIpcMain,
  dialog,
  shell,
  Menu,
  protocol,
  net as enet,
  nativeImage,
  clipboard,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { stopAllServices } from './content/contentConfig';
import * as thumbs from './project/thumbs';
import { openingBounds } from './app/windowBounds';
import { registerTerminalHandlers, cleanupTerminals } from './terminal/terminal';
import { watchProject } from './project/projectWatcher';
import { autoUpdater } from 'electron-updater';
import { AutoUpdates } from './app/autoUpdate';
import { isWin } from './lib/mainHelpers';
import { setToolPathHome } from './lib/nodeTools';
import { isAstroProject, hasDependencies } from './project/projectFiles';
import { MEDIA_EXT } from './project/assetFiles';
import { stopAllPreviews } from './preview/previewServers';
import type { MainHost } from './handlers/mainHost';
import { DevServers, registerDevServerHandlers } from './handlers/devServers';
import { Thumbnails, registerThumbnailHandlers } from './handlers/thumbnails';
import { registerAssetHandlers } from './handlers/assetHandlers';
import { registerCmsHandlers } from './handlers/cmsHandlers';
import { registerComponentHandlers } from './handlers/componentHandlers';
import { registerFeedbackHandlers } from './handlers/feedbackHandlers';
import { registerContentHandlers } from './handlers/contentHandlers';
import { registerCssVariableHandlers } from './handlers/cssVariableHandlers';
import { registerGitHandlers } from './handlers/gitHandlers';
import { registerPageHandlers } from './handlers/pageHandlers';
import { registerPreviewHandlers } from './handlers/previewHandlers';
import { registerProjectHandlers } from './handlers/projectHandlers';
import { registerProjectScanHandlers } from './handlers/projectScanHandlers';
import { registerStyleSourceHandlers } from './handlers/styleSourceHandlers';

// The facade keeps native Electron registration behind a parsed payload boundary.
const ipcMain = { handle: createIpcRegistrar(nativeIpcMain) };
setToolPathHome(app.getPath('home'));

let mainWindow: Window | undefined = undefined;
// The project's dev server and its home-page pictures: state of this process,
// kept by the objects that own it (handlers/devServers.ts, thumbnails.ts).
const devServers = new DevServers({ send });
const thumbnails = new Thumbnails({
  send,
  devServers,
  userDataPath: () => app.getPath('userData'),
});
const autoUpdates = new AutoUpdates({
  app,
  autoUpdater,
  beforeInstall: () => devServers.stop(),
  parentWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
  showMessageBox,
});

// --- Dev reload ------------------------------------------------------------
// Only the renderer hot-reloads on its own (Vite). preload.js is re-read from
// disk on a window reload, but main.js and astroParser.js are bound into this
// process at require time and can only be picked up by starting over — which
// is what "Reload All Code" does. So the app relaunches itself, leaving the
// open project in a file for the next process to pick up (the supervisor
// re-spawns us with the same argv, so there's nothing to hand forward there),
// landing back where you were instead of on the welcome screen.
const isDev = !!process.env['VITE_DEV_SERVER_URL'];
// Exiting with this asks scripts/build/devElectron.ts to start us again. Not
// app.relaunch(): `npm run dev` runs us under `concurrently -k`, so quitting
// would take the Vite server down with us and the new process would load a
// dead localhost:5173.
const RELAUNCH_CODE = 42;
const reopenFile = () => path.join(app.getPath('userData'), 'dev-reopen.json');

function relaunchApp() {
  try {
    // openProjectRoot is set whenever a project's watcher starts, i.e. on open.
    if (openProjectRoot) {
      fs.writeFileSync(reopenFile(), JSON.stringify({ path: openProjectRoot }), 'utf8');
    }
  } catch {
    /* worst case the reload lands on the welcome screen */
  }
  // app.exit skips before-quit, so take the Astro dev server down by hand —
  // otherwise it keeps the port and the next process adopts a server still
  // running the previously generated config.
  devServers.stop();
  app.exit(RELAUNCH_CODE);
}

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
let openProjectRoot: string | undefined = undefined; // set when a project's watcher starts

// The project the app has open: the asset protocol, the style panel and the
// terminal touch files only inside it.
function noteProjectRoot(projectPath: string): void {
  openProjectRoot = path.resolve(projectPath);
}

// Same containment rule the asset protocol uses: the style panel writes only
// inside the project that is currently open.
function assertInProject(filePath: string) {
  const abs = path.resolve(String(filePath || ''));
  if (!openProjectRoot || !isPathDescendant(openProjectRoot, abs)) {
    throw new Error('Refusing to touch a file outside the open project.');
  }
  return abs;
}

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
      return new Response(undefined, { status: 400 });
    }
    // The URL's path is stacki-asset://local/Users/… on POSIX, /C:/… for a
    // Windows drive, and ///server/share/… for a Windows UNC path.
    if (isWin) {
      abs = abs.replace(/^\//, '');
    }
    abs = path.resolve(abs);
    // Preview iframes run the user's own site; keep the scheme from being a
    // general-purpose file reader by serving only the open project's files.
    if (!openProjectRoot || !isPathDescendant(openProjectRoot, abs)) {
      return new Response(undefined, { status: 403 });
    }
    return serveFile(abs, request);
  });
}

async function serveFile(abs: string, request: Request) {
  const response = await enet.fetch(pathToFileURL(abs).toString(), { headers: request.headers });
  // The renderer is a different origin from this scheme, and font loading is
  // CORS-checked (unlike <img>/<video>), so the Assets panel's "Aa" preview
  // needs this to fetch the face at all. Reach is already limited to the open
  // project by the check above.
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const resource = resourcePath;

// electron-builder stamps the icon onto packaged builds (build.mac.icon), but
// `npm run dev` runs the bare Electron binary, which shows its own icon in the
// Dock. Set it explicitly so dev looks like the real app. macOS takes the
// padded icon-dock.png; elsewhere the Dock isn't a thing and the window icon
// below covers it.
function setApplicationIcon() {
  if (process.platform !== 'darwin') {
    return;
  }
  const img = nativeImage.createFromPath(resource('icon-dock.png'));
  if (!img.isEmpty()) {
    app.dock?.setIcon(img);
  }
}

function createWindow() {
  // Opened filled: the display the pointer is on, minus what the OS keeps (see
  // windowBounds.js). The display under the pointer rather than the primary
  // one — on a laptop with a monitor beside it, the app should open where the
  // person is looking.
  let bounds;
  try {
    bounds = openingBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
  } catch {
    // No display to ask about (a headless run, an unusual session): a laptop
    // sized window is a fine thing to fall back to.
    bounds = openingBounds({ width: 1480, height: 940 });
  }
  mainWindow = new BrowserWindow({
    ...bounds,
    title: 'Stacki',
    backgroundColor: '#111111',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : isWin ? 'hidden' : 'default',
    ...(isWin
      ? {
          titleBarOverlay: {
            color: '#171717',
            symbolColor: '#a8a8a8',
            height: 40,
          },
        }
      : {}),
    // Windows/Linux taskbar + window chrome; macOS uses the Dock icon above.
    icon: resource(process.platform === 'darwin' ? 'icon.icns' : isWin ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: RUNTIME_PATHS.preload,
      contextIsolation: true,
      nodeIntegration: false,
      // Run the preload in preview iframes too, so they can report their
      // page height for the canvas view (the preload guards what each
      // frame type gets).
      nodeIntegrationInSubFrames: true,
    },
  });

  listenForPreviewFailures(mainWindow.webContents, () => devServers.current()?.url);

  // A renderer that does not load leaves an empty window; the log says why.
  const loaded = process.env['VITE_DEV_SERVER_URL']
    ? mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL'])
    : mainWindow.loadFile(RUNTIME_PATHS.rendererIndex);
  loaded.catch((error: unknown) => {
    console.error('[window] the renderer did not load:', error);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });

  // Somebody closed the window. Whatever was open is over: the next window is a
  // fresh start and belongs on the welcome screen, not back in the project this
  // one had. (A reload doesn't come through here, which is the difference the
  // reopen above is asking about.)
  mainWindow.on('closed', () => {
    openProjectRoot = undefined;
    stopWatchingProject();
    devServers.stop();
    stopAllServices();
    stopAllPreviews();
    cleanupTerminals();
  });
}

// Links open in the user's browser. There is no one to tell when the browser
// cannot be started, so the failure goes to the log.
function openExternalLink(url: string) {
  shell.openExternal(url).catch((error: unknown) => {
    console.error(`[shell] could not open ${url}:`, error);
  });
}

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (/^https?:\/\//.test(url)) {
    openExternalLink(url);
  }
  return { ok: true as const };
});

// Custom menu: on macOS the native menu consumes ⌘Z/⌘C/⌘V before the page
// sees them, so Undo/Redo/Copy/Paste forward to the renderer, which decides
// between app-level actions (nodes) and native ones (text fields).
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      // Spelled out rather than `role: 'fileMenu'`, which takes no additions.
      // What that role provides is one item — Close Window on macOS, Quit
      // everywhere else — so the menu keeps exactly what it had, with the
      // update check above it.
      label: 'File',
      submenu: [
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => send('menu:settings'),
        },
        { type: 'separator' },
        // Until now the only way out of a project was to close the app, and on
        // macOS closing the app is not what people think it is: the window goes
        // and the process stays, so coming back lands on the same project and
        // there is nothing to press that says otherwise.
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('menu:openProject'),
        },
        {
          label: 'Close Project',
          accelerator: 'Shift+CmdOrCtrl+W',
          click: () => send('menu:closeProject'),
        },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => void autoUpdates.checkFromMenu() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
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
        {
          label: 'Copy Selection',
          accelerator: 'Shift+CmdOrCtrl+C',
          click: () => send('menu:copySelection'),
        },
        { label: 'Insert Element…', accelerator: 'CmdOrCtrl+E', click: () => send('menu:insert') },
      ],
    },
    // In dev ⌘R has to mean "restart the process". main.js, astroParser.js and
    // the rest of this side are bound in at require time, so the stock reload
    // repaints the renderer while silently going on running the old code —
    // the failure mode is an edit that appears to do nothing. The plain window
    // reload keeps its usual behaviour one item down. A packaged build has no
    // supervisor to restart it and no source to pick up, so it keeps the stock
    // menu.
    buildViewMenu(),
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A project the app has been asked to open in the window it is about to load —
// set by `project:close` when somebody picks a different project, since letting
// go of one is done by reloading the window and the choice has to outlive that.
// Consumed on read.
let pendingProject: string | undefined = undefined;

// The project the renderer should pick up as it mounts, or undefined — which is the
// welcome screen, and is what a cold start gets.
//
// Three ways a renderer can come up wanting a project:
//   - it was told to: somebody chose one from the menu, and the window was
//     reloaded to let go of the last one (`pendingProject`).
//   - it reloaded but this process didn't — a Vite full page reload, or
//     "Reload Window Only" in dev. openProjectRoot is still in memory, so use
//     it. A window that a PERSON closed clears that memory (see createWindow),
//     because closing a window is not reloading it: the next one is a fresh
//     start and must land on the welcome screen.
//   - the whole process restarted ("Reload All Code"), and memory is gone —
//     relaunchApp left the path in a file. Consumed on read, so a later cold
//     start doesn't silently skip the welcome screen.
ipcMain.handle('project:pending', () => {
  const asked = pendingProject;
  pendingProject = undefined;
  if (asked && fs.existsSync(asked)) {
    return asked;
  }
  if (!isDev) {
    return undefined;
  }
  if (openProjectRoot && fs.existsSync(openProjectRoot)) {
    return openProjectRoot;
  }
  let reopenPath: string | undefined = undefined;
  try {
    const input: unknown = JSON.parse(readSource(reopenFile()));
    reopenPath = parseOptionalString(toRecord(input)?.['path']) || undefined;
  } catch {
    return undefined;
  }
  try {
    fs.rmSync(reopenFile(), { force: true });
  } catch {
    /* non-fatal */
  }
  return reopenPath && fs.existsSync(reopenPath) ? reopenPath : undefined;
});

// Native clipboard actions on the focused element, requested by the renderer
// when a menu Copy/Paste lands while a text field has focus.
ipcMain.handle('native:copy', () => {
  mainWindow?.webContents.copy();
  return { ok: true as const };
});
ipcMain.handle('native:paste', () => {
  mainWindow?.webContents.paste();
  return { ok: true as const };
});
// Undo INSIDE a field. ⌘Z is a menu accelerator, so the key never reaches the
// page and a text field's own undo never runs — this is the app handing it
// back when that is what the shortcut meant.
ipcMain.handle('native:undo', () => {
  mainWindow?.webContents.undo();
  return { ok: true as const };
});
ipcMain.handle('native:redo', () => {
  mainWindow?.webContents.redo();
  return { ok: true as const };
});

// Electron resolves whenReady once; were it ever refused, there is no window
// to report that to, so the log says it.
app.whenReady().then(
  () => {
    // Before the menu, which draws the sound item's tick from it.
    settings = readSettings();
    setApplicationIcon();
    registerAssetProtocol();
    buildMenu();
    createWindow();
    autoUpdates.start();
    void showUsageNotice();
    app.on('browser-window-focus', () => {
      if (watcher) {
        noteUsageActivity();
      }
    });
    // Terminals open in the project the app has open — same reach as the asset
    // protocol, which is what `openProjectRoot` already scopes.
    registerTerminalHandlers({ send, projectRoot: () => openProjectRoot });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  },
  (error: unknown) => {
    console.error('[app] Electron did not become ready:', error);
  },
);

// Everything a project had running, let go of. The window reloads after this,
// which is the only way to be sure nothing of the last project is still being
// held — a page half-loaded, an undo stack, a watcher, a shell — and none of
// this survives the reload on its own: a pty outlives the window that opened
// it, and the dev server outlives everything.
ipcMain.handle('project:close', async (_event, next) => {
  pendingProject = typeof next === 'string' && next ? next : undefined;
  devServers.stop();
  stopAllServices();
  stopAllPreviews();
  cleanupTerminals();
  stopWatchingProject();
  // Nothing is open, so nothing is in reach: the asset protocol and the
  // terminals both scope themselves to this.
  openProjectRoot = undefined;
  // The window starts over. Done here rather than in the renderer because it
  // is the same act as the teardown above — the renderer holds a page, an undo
  // stack and forty pieces of state that belong to the project just closed, and
  // none of it should be in the window that opens the next one.
  mainWindow?.webContents.reload();
  return { ok: true as const };
});

app.on('window-all-closed', () => {
  // The hidden window a thumbnail is captured in is still a window, and
  // destroying it fires this. That is not the app being closed — and treating
  // it as one killed the dev server (and, off macOS, quit) in the middle of
  // taking a picture.
  if (mainWindow && !mainWindow.isDestroyed()) {
    return;
  }
  devServers.stop();
  // The pty ids are keyed to the window that opened them, so a surviving shell
  // could never be reached again — and on macOS the app stays running.
  cleanupTerminals();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopWatchingProject();
  devServers.stop();
});
// Reading a project's content config leaves a process behind holding its
// schemas; they go when the app does.
app.on('before-quit', () => stopAllServices());
// The preview checkouts live inside the user's projects, so leaving one behind
// leaves a stray folder in a place they will notice.
app.on('before-quit', () => stopAllPreviews());
// A pty outlives the window that opened it unless it is killed.
app.on('before-quit', () => cleanupTerminals());

// ---------------------------------------------------------------------------
// The renderer's window: what the main process tells it, and its dialogs
// ---------------------------------------------------------------------------

function send(channel: string, payload?: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showMessageBox(parent: Window | undefined, options: MessageBoxOptions) {
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}
function showOpenDialog(options: OpenDialogOptions) {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}

// ---------------------------------------------------------------------------
// Settings
//
// One file, read once at startup and written on every change. Only the app's
// own preferences live here — anything about a project belongs to the project.
// ---------------------------------------------------------------------------

// Sound is off. An editor that makes a noise the first time somebody touches it
// is an editor they turn off, so it is asked for rather than opted out of.
const SETTINGS_DEFAULTS: AppSettings = {
  sound: false,
  usageCountsEnabled: true,
  usageNoticeVersion: 0,
};
let settings: AppSettings = { ...SETTINGS_DEFAULTS };
let usageCountInFlight: AbortController | undefined;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  if (!fs.existsSync(settingsFile())) {
    return { ...SETTINGS_DEFAULTS };
  }
  try {
    const input: unknown = JSON.parse(readSource(settingsFile()));
    return parseSettings(input);
  } catch {
    // A damaged preference file must never silently re-enable usage counts.
    return { ...SETTINGS_DEFAULTS, usageCountsEnabled: false };
  }
}

function writeSettings(): boolean {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Preferences apply immediately; replies distinguish session changes from saved ones.
const publicSettings = () => ({
  sound: settings.sound,
  usageCountsEnabled: settings.usageCountsEnabled,
});
ipcMain.handle('settings:get', publicSettings);
ipcMain.handle('settings:set', (_event, { setting, enabled }) => {
  let saved: boolean;
  if (setting === 'sound') {
    settings = { ...settings, sound: enabled };
    saved = writeSettings();
    send('menu:sound', enabled);
  } else {
    saved = setUsageCountsEnabled(enabled);
  }
  return { ...publicSettings(), saved };
});

function setUsageCountsEnabled(enabled: boolean): boolean {
  if (!enabled) {
    usageCountInFlight?.abort();
  }
  settings = { ...settings, usageCountsEnabled: enabled };
  const saved = writeSettings();
  if (!saved) {
    void showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Privacy Setting Not Saved',
      message: 'Stacki could not save your usage-count preference.',
      detail: 'The change applies for this session. Check available disk space and try again.',
    });
  }
  if (enabled && watcher) {
    noteUsageActivity();
  }
  return saved;
}

function noteUsageActivity(): void {
  const day = usageDay(new Date());
  if (
    !shouldCountUsage(
      {
        packaged: app.isPackaged,
        enabled: settings.usageCountsEnabled,
        noticeVersion: settings.usageNoticeVersion,
        lastAttemptDay: settings.usageLastAttemptDay,
      },
      day,
    )
  ) {
    return;
  }
  if (usageCountInFlight) {
    return;
  }
  const controller = new AbortController();
  usageCountInFlight = controller;
  // Save the attempt before sending so reopening projects cannot produce
  // duplicate counts if the server accepted a request but its reply was lost.
  settings = { ...settings, usageLastAttemptDay: day };
  if (!writeSettings()) {
    usageCountInFlight = undefined;
    return;
  }
  void sendUsageCount({ signal: controller.signal }, fetch).finally(() => {
    if (usageCountInFlight === controller) {
      usageCountInFlight = undefined;
    }
  });
}

function usageNoticeOptions(): MessageBoxOptions {
  return {
    type: 'info',
    title: 'Anonymous Usage Counts',
    message: 'Help us understand how many Stacki installations are active.',
    detail:
      'Stacki sends one count on days you open a project. It sends no project names, ' +
      'file contents, device identifier, or activity history. Daily totals are kept ' +
      'on Cloudflare for up to 366 days; its network sees the connection IP, but the ' +
      'usage database does not store it. Turn this off any time in File → Settings.',
    buttons: ['Continue'],
    checkboxLabel: 'Turn off anonymous usage counts',
    checkboxChecked: !settings.usageCountsEnabled,
  };
}

async function showUsageNotice(): Promise<void> {
  if (!app.isPackaged || settings.usageNoticeVersion >= USAGE_NOTICE_VERSION) {
    return;
  }
  try {
    const answer = await showMessageBox(mainWindow, usageNoticeOptions());
    settings = {
      ...settings,
      usageCountsEnabled: !answer.checkboxChecked,
      usageNoticeVersion: USAGE_NOTICE_VERSION,
    };
    writeSettings();
    buildMenu();
    if (watcher) {
      noteUsageActivity();
    }
  } catch (error: unknown) {
    // If the notice could not be shown, the version stays old and no count is sent.
    console.warn('Could not show usage notice:', error);
  }
}

// ---------------------------------------------------------------------------
// Recent projects (their pictures: handlers/thumbnails.ts)
// ---------------------------------------------------------------------------

const recentsFile = () => path.join(app.getPath('userData'), 'recents.json');

function readRecents() {
  try {
    const input: unknown = JSON.parse(readSource(recentsFile()));
    return parseRecents(input);
  } catch {
    return [];
  }
}

function writeRecents(list: readonly RecentProject[]) {
  try {
    fs.writeFileSync(recentsFile(), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }
}

ipcMain.handle('recents:list', async () => {
  // Drop entries whose folder is gone or no longer looks like an Astro project.
  const list = readRecents().filter((recent) => {
    try {
      return fs.existsSync(recent.path) && isAstroProject(recent.path);
    } catch {
      return false;
    }
  });
  const userData = app.getPath('userData');
  return list.map((recent) => {
    // `stale` compares the picture against the files it was taken from, so a
    // project edited in another editor — or by a teammate, through git — says
    // so on the card instead of showing last month's homepage as if it were
    // today's.
    let stale = true;
    let thumb: string | undefined = undefined;
    try {
      thumb = thumbs.readThumb(userData, recent.path) ?? undefined;
      stale = thumbs.isStale(userData, recent.path);
    } catch {
      /* card renders a placeholder */
    }
    return { ...recent, thumb, stale: !!stale, canRefresh: hasDependencies(recent.path) };
  });
});

ipcMain.handle('recents:add', async (_event, projectPath) => {
  const list = readRecents().filter((recent) => !sameFilesystemPath(recent.path, projectPath));
  list.unshift({
    path: projectPath,
    name: path.basename(projectPath),
    openedAt: Date.now(),
  });
  writeRecents(list.slice(0, 12));
  return { ok: true as const };
});

ipcMain.handle('recents:remove', async (_event, projectPath) => {
  writeRecents(readRecents().filter((recent) => !sameFilesystemPath(recent.path, projectPath)));
  // The picture and the note about when it was taken both go.
  thumbs.forget(app.getPath('userData'), projectPath);
  return { ok: true as const };
});

// ---------------------------------------------------------------------------
// File watching — reflect external edits back into the app
// ---------------------------------------------------------------------------

let watcher: ReturnType<typeof watchProject> | undefined;

// A compile error replaces the site with the dev server's own error screen, and
// that screen carries no HMR client — so when the mistake is fixed, nothing in
// the preview hears about it and it sits on the error until someone presses
// refresh. The app's own writes are deliberately invisible to the watcher
// below, so this is the one place that sees every one of them: say that the
// site may have changed, and let the renderer go and ask (see `dev:probe`).
// `external` — the change came from outside the app: an editor, a script, a
// git checkout. The canvas hears about the app's own writes through the dev
// server's HMR socket and patches itself; an outside change reaches it the
// same way, when that socket is still listening. This flag is what lets the
// app tell the canvas directly as well, so a socket that has gone quiet is no
// longer the difference between seeing your edit and pressing refresh.
let pageChangeTimer: ReturnType<typeof setTimeout> | undefined;
let pageChangeExternal = false;
function notePageMayHaveChanged(external = false) {
  pageChangeExternal = pageChangeExternal || external;
  clearTimeout(pageChangeTimer);
  pageChangeTimer = setTimeout(() => {
    const wasExternal = pageChangeExternal;
    pageChangeExternal = false;
    send('page:maybe-changed', { external: wasExternal });
  }, 200);
}

// The app changed a project file: its own text write (through the file's
// actor), or a move, rename or delete. The canvas may need to hear of it.
function noteAppWrite(): void {
  notePageMayHaveChanged();
}

// The main process's document actors (plan §2 layer 2): from step 5 every
// write of project text goes through them (documentWrites.ts). Telemetry (plan
// §9a) is one structured line per outcome on stdout, with hashed paths.
installDocumentHost({
  documents: createNodeDocumentActors({
    log: (line) => console.info(line),
    schedule: (task) => setImmediate(task),
  }),
  noteWrite: noteAppWrite,
});
const documents = documentHost().documents;

// Whether a watcher event is the app hearing its own write come back (plan
// §11.9): the file holds exactly the bytes its actor last wrote. That is a
// question about bytes, never about elapsed time — an editor's save a moment
// after the app's holds other bytes, and is heard. A save's temporary file and
// its lock file (atomicWrite.ts) are the app's own too: they exist only while
// the actor writes. A move, rename or delete is heard like an outside change;
// the one read each listener then makes finds what the app already has.
const isSelfWrite = (full: string): boolean => {
  if (isAtomicTemporary(full)) {
    return true;
  }
  return documents.echoes(path.resolve(full));
};

ipcMain.handle('watch:start', async (_event, projectPath) => {
  stopWatchingProject();
  noteProjectRoot(projectPath);
  if (!fs.existsSync(path.join(projectPath, 'src'))) {
    return { ok: false as const };
  }
  watcher = watchProject({
    projectPath,
    send,
    isSelfWrite,
    noteExternalChange: (changed) => documents.noteExternalChange(changed),
    notePageMayHaveChanged,
    scheduleThumb: (projectPath, delayMs) => thumbnails.schedule(projectPath, delayMs),
    mediaPattern: MEDIA_EXT,
  });
  noteUsageActivity();
  return { ok: true as const };
});

function stopWatchingProject() {
  watcher?.close();
  watcher = undefined;
  clearTimeout(pageChangeTimer);
  pageChangeTimer = undefined;
  pageChangeExternal = false;
  thumbnails.stop();
  documents.clear();
}

function buildViewMenu(): MenuItemConstructorOptions {
  return isDev
    ? {
        label: 'View',
        submenu: [
          { label: 'Reload All Code', accelerator: 'CmdOrCtrl+R', click: () => relaunchApp() },
          {
            label: 'Reload Window Only',
            accelerator: 'Shift+CmdOrCtrl+R',
            click: () => mainWindow?.webContents.reload(),
          },
          { type: 'separator' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      }
    : { role: 'viewMenu' };
}

// ---------------------------------------------------------------------------
// IPC handler modules
//
// Each module registers its channels with what it uses of this file, a Pick
// of one host (handlers/mainHost.ts). Registration runs when this file loads,
// before the window can invoke anything.
// ---------------------------------------------------------------------------

const host: MainHost = {
  ipcMain,
  assertInProject,
  clipboard,
  documents,
  noteAppWrite,
  noteProjectRoot,
  readTrailingSlash: (projectPath) => devServers.readTrailingSlash(projectPath),
  send,
  shell,
  showOpenDialog,
};
registerAssetHandlers(host);
registerCmsHandlers(host);
registerComponentHandlers(host);
registerFeedbackHandlers(host);
registerContentHandlers(host);
registerCssVariableHandlers(host);
registerGitHandlers(host);
registerGitRepositoryHandlers(host);
registerImageConversionHandler(host);
registerPageHandlers(host);
registerPreviewHandlers(host);
registerProjectHandlers(host);
registerProjectMetadataHandlers(host);
registerPublishHandlers(host);
registerStudioHandlers(
  host,
  app.isPackaged ? { kind: 'packaged' } : { kind: 'development', appPath: app.getAppPath() },
  () => app.getVersion(),
);
registerProjectScanHandlers(host);
registerStyleSourceHandlers(host);
registerDevServerHandlers({ ipcMain, devServers, thumbnails });
registerThumbnailHandlers({ ipcMain, thumbnails, userDataPath: () => app.getPath('userData') });
