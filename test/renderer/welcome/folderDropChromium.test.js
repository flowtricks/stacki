// Goal: dragging a folder from outside the app over the window shows the full-window "Drop a folder to open it"
// fill, and nothing else does: a drag from inside the app (text, a component), a typed file (an image the media
// browser takes), and any drag over a drop target that takes it first leave the window as it is. The fill goes
// once the drag leaves, and a dropped file that is not a folder is one toast, never a call to open it. Folders
// the app's icon handed over before and while the window listens reach the screen, in order.
//
//   node test/renderer/welcome/folderDropChromium.test.js
//
// Method: run under the Electron binary, because only Chromium dispatches drag events with a real DataTransfer.
// A harness bundles the real FolderDropHost with the app's stylesheet over a fake preload bridge (never a real
// project) beside a stand-in drop target that calls preventDefault, as the media browser does. Each drag is a
// synthetic DragEvent whose DataTransfer holds what Finder's or the app's own drag would: an untyped file for a
// folder, a typed file, a string. A synthetic drop has no file-system entries, so no item reads as a folder:
// what a real Finder folder drop does is left to a person (the report says so). Waits are for a condition,
// polled once per animation frame and bounded.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FolderDropHost } from ${JSON.stringify(repoPath('src/features/welcome/FolderDropHost.tsx'))};

window.choices = [];
window.toasts = [];
window.inspected = [];
window.pushFolder = undefined;
window.avb = {
  getFilePath: () => '/Users/me/Sites/blog',
  inspectFolder: async (folderPath) => { window.inspected.push(folderPath); return { kind: 'astro', projectPath: folderPath }; },
  takeOpenedFolders: async () => [{ kind: 'astro', projectPath: '/Users/me/Sites/early' }],
  onFolderOpened: (callback) => { window.pushFolder = callback; return () => {}; },
};
window.until = (condition, framesMax = 600) =>
  new Promise((resolve) => {
    let frames = 0;
    const tick = () => {
      let value;
      try { value = condition(); } catch { value = undefined; }
      if (value) { resolve(value); return; }
      frames += 1;
      if (frames > framesMax) { resolve(false); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
window.mount = () => {
  const taker = document.getElementById('taker');
  taker.addEventListener('dragover', (event) => event.preventDefault());
  taker.addEventListener('drop', (event) => event.preventDefault());
  createRoot(document.getElementById('host')).render(
    React.createElement(FolderDropHost, {
      onChoice: (choice) => window.choices.push(choice),
      showToast: (message, kind) => window.toasts.push({ message, kind }),
    }),
  );
};
`;

const STEPS = `
window.steps = (() => {
  const overlay = () => document.querySelector('.folder-drop-overlay');
  const transfer = (kind) => {
    const data = new DataTransfer();
    if (kind === 'folder') { data.items.add(new File([], 'blog', { type: '' })); }
    if (kind === 'image') { data.items.add(new File(['x'], 'photo.png', { type: 'image/png' })); }
    if (kind === 'text') { data.setData('text/plain', 'Hello'); }
    if (kind === 'component') { data.setData('application/x-stacki-component', 'Card'); }
    return data;
  };
  const fire = (type, kind, target) => {
    const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer(kind) });
    (target ?? document.getElementById('open')).dispatchEvent(event);
    return event.defaultPrevented;
  };
  const shown = async () => Boolean(await window.until(() => overlay() !== null, 30));
  const gone = () => window.until(() => overlay() === null, 120);
  return {
    async run() {
      const report = {};
      report.inbox = await window.until(() => window.choices.length >= 1, 120) ? window.choices.slice() : [];
      window.pushFolder({ kind: 'rejected', reason: 'missing' });
      report.pushed = window.choices.slice(1);

      report.folderTaken = fire('dragover', 'folder');
      report.folderShows = await shown();
      report.rootMarked = document.documentElement.classList.contains('folder-drag-active');
      const box = overlay()?.getBoundingClientRect();
      report.fillsWindow = box !== undefined && box.width >= innerWidth - 1 && box.height >= innerHeight - 1;
      report.overlayTakesPointer = overlay() === null ? undefined : getComputedStyle(overlay()).pointerEvents;
      report.overlayBorder = overlay() === null ? undefined : getComputedStyle(overlay()).borderTopWidth;
      report.title = overlay()?.textContent ?? '';
      report.leaves = Boolean(await gone());
      report.rootCleared = !document.documentElement.classList.contains('folder-drag-active');

      for (const kind of ['text', 'component', 'image']) {
        report[kind + 'Taken'] = fire('dragover', kind);
        report[kind + 'Shows'] = await shown();
      }
      report.takerShows = (fire('dragover', 'folder', document.getElementById('taker')), await shown());

      fire('dragover', 'folder');
      await shown();
      report.dropTaken = fire('drop', 'folder');
      report.dropHides = overlay() === null || Boolean(await gone());
      await window.until(() => window.toasts.length >= 1, 60);
      report.toasts = window.toasts.slice();
      report.inspected = window.inspected.slice();
      report.textDropTaken = fire('drop', 'text');
      return report;
    },
  };
})();
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#161616;height:100%}#taker{position:absolute;right:0;top:0;width:120px;height:120px}#open{position:absolute;left:0;top:0;width:120px;height:120px}</style></head>' +
  '<body><div id="open"></div><div id="taker"></div><div id="host"></div><script src="/harness.js"></script><script src="/steps.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 800, height: 600, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { report: undefined, error: undefined };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await host('window.mount()');
    output.report = await host('window.steps.run()');
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

function check(report) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  expect('a folder the icon handed over before the window listened reaches the screen', report.inbox[0]?.projectPath === '/Users/me/Sites/early', report.inbox);
  expect('a folder handed over while it listens reaches the screen next', report.pushed[0]?.kind === 'rejected', report.pushed);
  expect('a folder drag is taken by the window', report.folderTaken === true);
  expect('a folder drag shows the fill', report.folderShows === true);
  expect('the frames stop taking the pointer while it shows', report.rootMarked === true);
  expect('the fill covers the whole window', report.fillsWindow === true);
  expect('the fill never takes the pointer from the drop targets under it', report.overlayTakesPointer === 'none', report.overlayTakesPointer);
  expect('the fill has no border', report.overlayBorder === '0px', report.overlayBorder);
  expect('the fill says what to do', report.title.includes('Drop a folder to open it'), report.title);
  expect('the fill goes once the drag leaves', report.leaves === true);
  expect('the frames take the pointer again after', report.rootCleared === true);
  for (const kind of ['text', 'component', 'image']) {
    expect(`a ${kind} drag is left to the app`, report[kind + 'Taken'] === false);
    expect(`a ${kind} drag shows no fill`, report[kind + 'Shows'] === false);
  }
  expect('a drag over a drop target that takes it shows no fill', report.takerShows === false);
  expect('a folder-like drop is taken', report.dropTaken === true);
  expect('the fill goes on drop', report.dropHides === true);
  expect('a dropped item that is not a folder is one error toast', report.toasts.length === 1 && report.toasts[0].kind === 'error', report.toasts);
  expect('the toast says to drop a folder', report.toasts[0]?.message === 'Drop a folder, not a file.', report.toasts);
  expect('nothing that is not a folder is sent to main to open', report.inspected.length === 0, report.inspected);
  expect('a text drop is left to the app', report.textDropTaken === false);
  return failures;
}

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('folder-drop-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/folder-drop-chromium');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  buildSync({
    stdin: { contents: HARNESS, resolveDir: repoPath('.'), loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    outfile: path.join(directory, 'harness.js'),
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(path.join(directory, 'steps.js'), STEPS);
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment, maxBuffer: 64 * 1024 * 1024 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line.slice('RESULT '.length));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    } else {
      failures.push(...check(output.report));
    }
  }
  if (failures.length > 0) {
    console.error(`folder-drop-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('folder-drop-chromium: passed  [a real Finder or Explorer folder drop is left to a person]');
  }
})();
