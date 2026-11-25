// Goal: the device keys 1 to 9 pick the toolbar's breakpoints in the preview mode (the play
// button in the title bar) exactly as on the canvas, though the preview draws no toolbar: from
// the editor and from inside the running site alike. A digit typed into a field of the site
// stays the site's, a modified digit (Cmd+3, Ctrl+3) is not a device key, and the device picked
// in the preview is the one the canvas shows on return.
//
//   node test/renderer/preview/previewDeviceKeysChromium.test.js
//
// Method: run under the Electron binary, because focus moving into a frame, real key input and
// a page's own media queries only happen in Chromium. A harness bundles the real styles.css,
// SizedFrame, PreviewModeStage and usePreviewSizing, wired as Desktop's AppShell wires them:
// one window state holds the device and the custom size; the canvas (a SizedFrame that listens
// for the device keys) stays mounted, and the preview mode's stage lies over it without
// listening. The site in the preview is a page that runs the real frame preload listener
// (electron/preload/frameDesign.ts listenForDesign), and the host replays its forwarded keys
// through the real parseShortcutMessage as appNodeEdits.ts does; a source check pins that
// replay. The breakpoints are one `up` and the three built-in `down` ones, so the bar has six
// positions. Keys are sent with webContents.sendInputEvent; after each, the probe reads the
// device, the preview frame's width and the site's own innerWidth and media query. A screenshot
// of the preview at the tablet width is written to node_modules/.stacki-test/preview-device-keys/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const AREA = { width: 1800, height: 900 };
// Bar order (breakpointDevices.ts barDevices): the `up` one, Desktop, the three `down` ones, the all-breakpoints canvas.
const EXPECTED = [
  { key: '1', device: 'wide', widthPx: 1600 },
  { key: '2', device: 'desktop', widthPx: 1599 },
  { key: '3', device: 'laptop', widthPx: 1023 },
  { key: '4', device: 'tablet', widthPx: 767 },
  { key: '5', device: 'phone', widthPx: 479 },
  { key: '6', device: 'canvas', widthPx: undefined },
];
const MODIFIER = process.platform === 'darwin' ? 'meta' : 'control';

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SizedFrame, PreviewModeStage } from ${JSON.stringify(repoPath('src/features/preview/SizedFrame.tsx'))};
import { usePreviewSizing, usePreviewDimensions } from ${JSON.stringify(repoPath('src/features/preview/usePreviewSizing.ts'))};
import { parseShortcutMessage } from ${JSON.stringify(repoPath('src/features/preview/previewMessages.ts'))};
import { resolveBreakpoints } from ${JSON.stringify(repoPath('shared/properties/projectBreakpoints.ts'))};

const BREAKPOINTS = resolveBreakpoints([
  { id: 'wide', name: 'Wide', direction: 'up', setting: { value: 100, unit: 'rem' } },
  { id: 'laptop', name: undefined, direction: 'down', setting: { value: 64, unit: 'rem' } },
  { id: 'tablet', name: undefined, direction: 'down', setting: { value: 48, unit: 'rem' } },
  { id: 'phone', name: undefined, direction: 'down', setting: { value: 30, unit: 'rem' } },
]);

// The stage is wide enough to reach the wide breakpoint, so Desktop stops one pixel short of it (1599px), centred.

// The forwarded key, replayed on the document as appNodeEdits.ts replays it.
window.addEventListener('message', (event) => {
  const message = parseShortcutMessage(event.data);
  if (message === undefined || message.name !== 'key') {
    return;
  }
  window.harness.forwarded += 1;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: message.key, metaKey: message.meta, ctrlKey: message.meta, bubbles: true, cancelable: true }));
});

function Canvas({ device, setDevice, dimensions }) {
  const sizing = usePreviewSizing(device, dimensions, BREAKPOINTS, { deviceShortcuts: true, desktopFramePx: 1440 }, setDevice);
  window.harness.canvasWidth = sizing.viewport.width;
  return React.createElement('div', { className: 'preview-frame-wrap', ref: sizing.wrapRef, style: { position: 'absolute', inset: 0 } },
    React.createElement(SizedFrame, { sizing }, React.createElement('div', { className: 'canvas-page' })));
}
function PreviewMode({ device, setDevice, dimensions }) {
  const sizing = usePreviewSizing(device, dimensions, BREAKPOINTS, { deviceShortcuts: false, desktopFramePx: 1440 }, setDevice);
  window.harness.previewWidth = sizing.viewport.width;
  return React.createElement(PreviewModeStage, { sizing }, React.createElement('iframe', { title: 'Site', src: '/site.html' }));
}
function Harness() {
  const [device, setDevice] = useState('desktop');
  const [mode, setMode] = useState('preview');
  const dimensions = usePreviewDimensions();
  window.harness.device = device;
  window.harness.setMode = setMode;
  return React.createElement(React.Fragment, undefined,
    React.createElement(Canvas, { device, setDevice, dimensions }),
    mode === 'preview' ? React.createElement(PreviewMode, { device, setDevice, dimensions }) : undefined);
}
window.harness = { forwarded: 0 };
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;

const FRAME = `
import { listenForDesign, markFrameMode } from ${JSON.stringify(repoPath('electron/preload/frameDesign.ts'))};
markFrameMode();
listenForDesign();
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#1e1e1e}' +
  `#root{position:relative;width:${AREA.width}px;height:${AREA.height}px;overflow:hidden}</style></head>` +
  '<body><div id="root"></div><script src="/harness.js"></script></body></html>';

// The site: fields to type in, and a media query that names the width it sees.
const SITE =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'body{margin:0;font:16px system-ui;background:#fff}header{height:64px;background:#111;color:#fff;display:flex;align-items:center;padding:0 24px}' +
  '.band{margin:24px;height:160px;border-radius:12px;background:#dfe7ff}#size::after{content:"desktop"}' +
  '@media (width < 64rem){.band{background:#ffe3c7}#size::after{content:"laptop"}}' +
  '@media (width < 48rem){.band{background:#d3f5dc}#size::after{content:"tablet"}}' +
  '@media (width < 30rem){.band{background:#f6d4f0}#size::after{content:"phone"}}' +
  '</style></head><body><header>Site</header><h1 style="margin:24px">A page in the preview</h1><p id="size" style="margin:0 24px"></p>' +
  '<div class="band"></div><input id="field" style="margin:0 24px"><textarea id="area" style="margin:0 24px"></textarea>' +
  '<div id="editable" contenteditable="true" style="margin:24px;height:40px;background:#eee"></div>' +
  '<script src="/frame.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const EXPECTED = ${JSON.stringify(EXPECTED)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const READ = \`(() => {
  const site = document.querySelector('.preview-mode-stage iframe');
  const siteWindow = site === null ? undefined : site.contentWindow;
  const sizeText = siteWindow === undefined ? '' : siteWindow.getComputedStyle(siteWindow.document.getElementById('size'), '::after').content;
  return {
    device: window.harness.device,
    previewWidth: window.harness.previewWidth,
    canvasWidth: window.harness.canvasWidth,
    stageWidth: document.querySelector('.preview-mode-stage') === null ? undefined : document.querySelector('.preview-mode-stage').clientWidth,
    siteWidth: siteWindow === undefined ? undefined : siteWindow.innerWidth,
    siteQuery: sizeText,
    forwarded: window.harness.forwarded,
    hostFocus: document.activeElement === null ? '' : document.activeElement.tagName,
  };
})()\`;
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: ${AREA.width}, height: ${AREA.height}, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const site = (code) => host('document.querySelector(".preview-mode-stage iframe").contentWindow.eval(' + JSON.stringify(code) + ')');
  const click = (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  };
  const press = async (key, modifiers) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    win.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    await sleep(250);
  };
  // A click on an element of the site, by its box in the host's coordinates.
  const clickInSite = async (selector) => {
    const box = await host('(() => { const frame = document.querySelector(".preview-mode-stage iframe"); const outer = frame.getBoundingClientRect(); const scale = outer.width / frame.offsetWidth; const inner = frame.contentDocument.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect(); return { x: outer.left + (inner.left + inner.width / 2) * scale, y: outer.top + (inner.top + Math.min(inner.height / 2, 12)) * scale }; })()');
    click(box.x, box.y);
    await sleep(200);
  };
  const output = { fromSite: [], fromHost: [], fields: [], modified: undefined, extra: undefined, design: undefined, error: undefined };
  try {
    win.webContents.focus();
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    for (let spin = 0; spin < 200 && !(await host('document.querySelector(".preview-mode-stage iframe") !== null && document.querySelector(".preview-mode-stage iframe").contentDocument.readyState === "complete"')); spin += 1) { await sleep(20); }
    await sleep(500);
    // Focus in the site: a click on its heading.
    await clickInSite('h1');
    for (const expected of EXPECTED) {
      await press(expected.key, []);
      const read = await host(READ);
      output.fromSite.push({ key: expected.key, ...read });
      if (expected.device === 'tablet') {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(DIRECTORY, 'preview-tablet.png'), image.toPNG());
      }
    }
    // Past the bar's six positions: no device.
    await press('2', []);
    const beforeExtra = await host(READ);
    await press('7', []);
    await press('9', []);
    output.extra = { before: beforeExtra, after: await host(READ) };
    // A modified digit is not a device key.
    await press('4', [${JSON.stringify(MODIFIER)}]);
    output.modified = await host(READ);
    // Digits typed in the site's fields stay there.
    for (const selector of ['#field', '#area', '#editable']) {
      await clickInSite(selector);
      const before = await host(READ);
      await press('4', []);
      const after = await host(READ);
      const text = await site('(() => { const element = document.querySelector(' + JSON.stringify(selector) + '); return element.value === undefined ? element.textContent : element.value; })()');
      output.fields.push({ selector, before, after, text });
    }
    // Focus in the editor (as after a click on the play button): the canvas listener reads the key itself.
    await host('document.activeElement && document.activeElement.blur && document.activeElement.blur(), document.body.focus(), true');
    await sleep(100);
    const forwardedBefore = (await host(READ)).forwarded;
    await press('4', []);
    output.fromHost.push({ key: '4', forwardedBefore, ...(await host(READ)) });
    // Leave the preview: the canvas keeps the device, and its own keys still work there.
    await host('window.harness.setMode("design"), true');
    await sleep(300);
    const kept = await host(READ);
    await press('3', []);
    output.design = { kept, afterKey: await host(READ) };
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log(JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

// The checks over what the probe read, as failure lines.
function check(output) {
  const failures = [];
  if (output.fromSite.length !== EXPECTED.length) {
    return [`every device key was pressed in the site (${output.fromSite.length} of ${EXPECTED.length})`];
  }
  EXPECTED.forEach((expected, index) => {
    const read = output.fromSite[index];
    if (read.device !== expected.device) {
      failures.push(`key ${expected.key} in the site picked ${expected.device} (got ${read.device})`);
    }
    // A full-width device (Desktop, the canvas) is drawn by the shared sizing, so the preview matches the canvas.
    const width = expected.widthPx === undefined ? Math.round(read.canvasWidth) : expected.widthPx;
    if (Math.round(read.previewWidth) !== width) {
      failures.push(`key ${expected.key}: the preview frame is ${width}px wide (got ${read.previewWidth})`);
    }
    if (read.siteWidth !== width) {
      failures.push(`key ${expected.key}: the site sees a ${width}px viewport (got ${read.siteWidth})`);
    }
    if (read.forwarded !== index + 1) {
      failures.push(`key ${expected.key} came from the site's frame (forwarded ${read.forwarded}, expected ${index + 1})`);
    }
  });
  const tablet = output.fromSite.find((read) => read.key === '4');
  if (tablet === undefined || tablet.siteQuery !== '"tablet"') {
    failures.push(`the site's own media query matched tablet at 767px (got ${tablet === undefined ? 'nothing' : tablet.siteQuery})`);
  }
  if (output.extra === undefined) {
    failures.push('the keys past the bar were pressed');
  } else {
    if (output.extra.after.device !== output.extra.before.device) {
      failures.push(`a key past the bar left the device at ${output.extra.before.device} (got ${output.extra.after.device})`);
    }
  }
  if (output.modified === undefined) {
    failures.push('the modified key was pressed');
  } else {
    if (output.modified.device !== 'desktop') {
      failures.push(`${MODIFIER}+4 left the device at desktop (got ${output.modified.device})`);
    }
  }
  if (output.fields.length !== 3) {
    failures.push(`every field was typed in (${output.fields.length} of 3)`);
  }
  for (const field of output.fields) {
    if (field.after.device !== field.before.device) {
      failures.push(`a 4 typed in ${field.selector} left the device at ${field.before.device} (got ${field.after.device})`);
    }
    if (field.after.forwarded !== field.before.forwarded) {
      failures.push(`a 4 typed in ${field.selector} was not forwarded`);
    }
    if (!String(field.text).includes('4')) {
      failures.push(`the 4 typed in ${field.selector} reached the field (text "${field.text}")`);
    }
  }
  const fromHost = output.fromHost[0];
  if (fromHost === undefined) {
    failures.push('a key was pressed with the editor focused');
  } else {
    if (fromHost.device !== 'tablet') {
      failures.push(`key 4 with the editor focused picked tablet (got ${fromHost.device})`);
    }
    if (fromHost.forwarded !== fromHost.forwardedBefore) {
      failures.push('a key pressed in the editor was not also forwarded from the site');
    }
  }
  if (output.design === undefined) {
    failures.push('the probe left the preview');
  } else {
    if (output.design.kept.device !== 'tablet') {
      failures.push(`the canvas kept the preview's device on return (got ${output.design.kept.device})`);
    }
    if (Math.round(output.design.kept.canvasWidth) !== 767) {
      failures.push(`the canvas kept the tablet width on return (got ${output.design.kept.canvasWidth})`);
    }
    if (output.design.afterKey.device !== 'laptop') {
      failures.push(`key 3 on the canvas picked laptop (got ${output.design.afterKey.device})`);
    }
  }
  return failures;
}

// The replay the harness stands in for: appNodeEdits.ts replays a forwarded key on the document.
function checkReplaySource() {
  const failures = [];
  const edits = fs.readFileSync(repoPath('src/app/state/appNodeEdits.ts'), 'utf8');
  if (
    !/case 'key':\s*document\.dispatchEvent\(\s*new KeyboardEvent\('keydown', \{\s*key: message\.key,\s*metaKey: message\.meta,\s*ctrlKey: message\.meta,/.test(
      edits,
    )
  ) {
    failures.push('appNodeEdits.ts replays a forwarded key on the document, as the harness does');
  }
  const shell = fs.readFileSync(repoPath('src/app/shell/AppShell.tsx'), 'utf8');
  if (!/usePreviewSizing\(app\.device, app\.previewDimensions, breakpoints, \{ deviceShortcuts: false\b[^}]*\}, app\.setDevice\)/.test(shell)) {
    failures.push('AppShell.tsx draws the preview mode on the window device state without its own key listener, as the harness does');
  }
  return failures;
}

function bundle(contents, outfile) {
  buildSync({
    stdin: { contents, resolveDir: repoPath('.'), loader: 'tsx', sourcefile: path.basename(outfile, '.js') + '.tsx' },
    bundle: true,
    outfile,
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
}

(async () => {
  const failures = checkReplaySource();
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('preview-device-keys: skipped  [needs the Electron binary]');
    process.exitCode = failures.length > 0 ? 1 : 0;
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/preview-device-keys');
  fs.mkdirSync(directory, { recursive: true });
  bundle(HARNESS, path.join(directory, 'harness.js'));
  bundle(FRAME, path.join(directory, 'frame.js'));
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  fs.writeFileSync(path.join(directory, 'site.html'), SITE);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{"fromSite"'));
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line);
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    }
    failures.push(...check(output));
  }
  if (failures.length > 0) {
    console.error(`preview-device-keys: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`preview-device-keys: passed  [screenshot in ${directory}]`);
  }
})();
