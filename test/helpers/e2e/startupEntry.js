// Goal: the Electron side of the startup timeline (test/integration/startupTimeline.js). It starts
// the built app the way a packaged one starts (the bundled renderer loaded from a file, not a Vite
// server), with a fixture project reopened or on the start screen, and writes where the time went
// to a JSON file: the main process's milestones, the renderer's marks and resources, every IPC
// handler's start and end, the slowest `require`s of the main process, the frames the canvas loaded,
// and the long tasks of the renderer's main thread.
//
// Method: an isolated user-data directory, set before the app is ready, so nothing of a person's
// own Stacki is read or written. `ipcMain.handle` and `Module.prototype.require` are wrapped before
// main.js is loaded, so the wrapping sees every handler and every module. Everything is bounded:
// each table has a maximum, and the wait for the run to settle is a stated number of polls.

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const electron = require('electron');

const SETTLE_POLL_MS = 50;
const SETTLE_POLLS_MAX = 1200;
const QUIET_POLLS = 20;
const TABLE_ROWS_MAX = 400;
const REQUIRE_ROWS_MAX = 25;

const { app, BrowserWindow, ipcMain } = electron;
const distRoot = process.env.STACKI_START_DIST ?? '';
const project = process.env.STACKI_START_PROJECT ?? '';
const userData = process.env.STACKI_START_USER_DATA ?? '';
const outFile = process.env.STACKI_START_OUT ?? '';
if (distRoot.length === 0 || userData.length === 0 || outFile.length === 0) {
  throw new Error('startupEntry: STACKI_START_DIST, STACKI_START_USER_DATA and STACKI_START_OUT are required');
}

const processStartEpochMs = Date.now() - process.uptime() * 1000;
const sinceStartMs = () => Date.now() - processStartEpochMs;
app.setPath('userData', userData);
// A test run never touches the person's login keychain.
app.commandLine.appendSwitch('use-mock-keychain');
if (project.length > 0) {
  fs.writeFileSync(path.join(userData, 'dev-reopen.json'), JSON.stringify({ path: project }), 'utf8');
}

const handlerRows = [];
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, async (...args) => {
    const startMs = sinceStartMs();
    try {
      return await listener(...args);
    } finally {
      if (handlerRows.length < TABLE_ROWS_MAX) {
        handlerRows.push({ channel, startMs: Math.round(startMs), endMs: Math.round(sinceStartMs()) });
      }
    }
  });

const requireStack = [];
const requireRows = [];
const originalRequire = Module.prototype.require;
Module.prototype.require = function timedRequire(id) {
  const frame = { id, childMs: 0 };
  requireStack.push(frame);
  const began = performance.now();
  try {
    return originalRequire.call(this, id);
  } finally {
    const totalMs = performance.now() - began;
    requireStack.pop();
    const parent = requireStack[requireStack.length - 1];
    if (parent !== undefined) {
      parent.childMs += totalMs;
    }
    if (totalMs >= 3) {
      requireRows.push({ id: String(id).slice(-80), totalMs: Math.round(totalMs), selfMs: Math.round(totalMs - frame.childMs) });
    }
  }
};

const mainMarks = require(path.join(distRoot, 'dist/electron/app/startupTiming.js'));
require(path.join(distRoot, 'dist/electron/main.js'));
Module.prototype.require = originalRequire;

const pause = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

async function mainWindow() {
  for (let poll = 0; poll < SETTLE_POLLS_MAX; poll += 1) {
    const window = BrowserWindow.getAllWindows()[0];
    if (window !== undefined) {
      return window;
    }
    await pause(SETTLE_POLL_MS);
  }
  throw new Error('startupEntry: the main window never opened');
}

const RENDERER_REPORT = `(() => {
  const entry = (name) => performance.getEntriesByName(name)[0];
  const resources = performance.getEntriesByType('resource').map((resource) => ({
    name: resource.name.split('/').slice(-2).join('/'),
    startMs: Math.round(resource.startTime),
    endMs: Math.round(resource.responseEnd),
    bytes: resource.decodedBodySize,
  }));
  return {
    timeOrigin: performance.timeOrigin,
    marks: performance.getEntriesByType('mark').map((mark) => [mark.name, Math.round(mark.startTime)]),
    paints: performance.getEntriesByType('paint').map((paint) => [paint.name, Math.round(paint.startTime)]),
    navigation: performance.getEntriesByType('navigation').map((nav) => ({
      domInteractive: Math.round(nav.domInteractive), domComplete: Math.round(nav.domComplete), loadEnd: Math.round(nav.loadEventEnd),
    })),
    resources,
    longTasks: (window.__longTasks ?? []),
    domNodes: document.getElementsByTagName('*').length,
    skeletons: document.querySelectorAll('[aria-busy="true"], .skeleton, #boot-spinner').length,
    probe: window.__bootProbe ?? {},
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0,
    html: Boolean(entry('stacki:html-parsed')),
  };
})()`;

// Installed at dom-ready of every load: long tasks and the moments the real content showed up.
const OBSERVE = `(() => {
  if (window.__bootProbe) { return; }
  window.__longTasks = [];
  window.__bootProbe = {};
  try {
    new PerformanceObserver((list) => {
      for (const task of list.getEntries()) {
        if (window.__longTasks.length < 200) { window.__longTasks.push([Math.round(task.startTime), Math.round(task.duration)]); }
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  const seen = (name, test) => {
    if (window.__bootProbe[name] === undefined && test()) { window.__bootProbe[name] = Math.round(performance.now()); }
  };
  const look = () => {
    seen('railReal', () => document.querySelectorAll('.app .rail button').length > 0 && document.querySelector('.rail [aria-hidden="true"].skeleton') === null);
    seen('welcome', () => document.querySelector('.welcome-mode') !== null);
    seen('titlebar', () => document.querySelector('.titlebar') !== null);
    seen('navigatorRows', () => document.querySelectorAll('[data-node-id], .navigator-row, .nav-row, [role="treeitem"]').length > 0);
    seen('canvasIframe', () => document.querySelector('iframe') !== null);
  };
  new MutationObserver(look).observe(document, { childList: true, subtree: true });
  look();
})()`;

(async () => {
  await app.whenReady();
  const events = [];
  let window;
  try {
    window = await mainWindow();
    events.push(['windowCreated', Math.round(sinceStartMs())]);
    window.on('show', () => events.push(['windowShow', Math.round(sinceStartMs())]));
    window.webContents.on('dom-ready', () => {
      events.push(['domReady', Math.round(sinceStartMs())]);
      void window.webContents.executeJavaScript(OBSERVE).catch(() => undefined);
    });
    window.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
      events.push([isMainFrame ? 'mainFrameLoaded' : 'subFrameLoaded', Math.round(sinceStartMs())]);
    });
    let quiet = 0;
    let lastSignature = '';
    for (let poll = 0; poll < SETTLE_POLLS_MAX && quiet < QUIET_POLLS; poll += 1) {
      await pause(SETTLE_POLL_MS);
      const marks = mainMarks.startupMarks().length;
      const frames = events.filter(([name]) => name === 'subFrameLoaded').length;
      const wantsCanvas = project.length > 0;
      const ready = marks >= 5 && (!wantsCanvas || frames > 0);
      const signature = `${marks}/${frames}/${handlerRows.length}`;
      quiet = ready && signature === lastSignature ? quiet + 1 : 0;
      lastSignature = signature;
    }
    await pause(500);
    const renderer = await window.webContents.executeJavaScript(RENDERER_REPORT);
    const report = {
      project: project.length > 0,
      platform: process.platform,
      electron: process.versions.electron,
      main: mainMarks.startupMarks(),
      events,
      rendererOriginMs: Math.round(renderer.timeOrigin - processStartEpochMs),
      renderer,
      handlers: handlerRows,
      requires: requireRows.sort((left, right) => right.selfMs - left.selfMs).slice(0, REQUIRE_ROWS_MAX),
    };
    fs.writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');
    app.exit(0);
  } catch (error) {
    console.error('[startup] the run failed:', error);
    app.exit(1);
  }
})();
