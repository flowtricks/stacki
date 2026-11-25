// Goal: in the browser Desktop ships, the Desktop device in a narrow pane draws the page at the pane's own width less
// the scrollbar's two 9px gutters, never scaled or shrunk: an 882px pane lays the page out at 864px, so its `(width < 64rem)` rules (Laptop's)
// apply, as in a browser window that size, and the toolbar says Laptop rather than Desktop. Switching devices
// never draws a frame of the page at a width other than the old or the new device's (no flicker through the pane
// width).
//
//   node test/renderer/preview/desktopDeviceChromium.test.js
//
// Method: run under the Electron binary, because only Chromium's own layout answers matchMedia inside
// the frame. A harness bundles the real SizedFrame and usePreviewSizing with the real styles.css in an
// 882 x 700 pane; the page is an iframe whose stylesheet paints Laptop red (`width < 64rem`) and Base blue.
// The probe reads, inside the frame, matchMedia('(width < 64rem)'), innerWidth, the frame's transform and the
// painted colour, in two modes: `before` is the all-breakpoints device (fluid by CSS), `after` picks Desktop;
// the two must agree. Then, with a requestAnimationFrame recorder running, it switches Laptop, Desktop,
// Tablet, Desktop, Phone, Desktop and checks every recorded frame. Screenshots of both modes are written to
// node_modules/.stacki-test/desktop-device-chromium/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const PANE = { width: 882, height: 700 };
// The fluid frame leaves a 9px gutter on each side for the canvas's scrollbar (previewViewport.ts `FLUID_GUTTER_PX`).
const FLUID_PAGE_WIDTH_PX = PANE.width - 18;
const SWITCHES = ['laptop', 'desktop', 'tablet', 'desktop', 'phone', 'desktop'];
const DEVICE_WIDTH_PX = { laptop: 1023, tablet: 767, phone: 479, desktop: FLUID_PAGE_WIDTH_PX };

// The import paths are JSON-quoted: a Windows path's `\` inside a plain quoted string is an
// escape, so a quoted literal only works on POSIX.
const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SizedFrame } from ${JSON.stringify(repoPath('src/features/preview/SizedFrame.tsx'))};
import { usePreviewSizing, usePreviewDimensions } from ${JSON.stringify(repoPath('src/features/preview/usePreviewSizing.ts'))};
import { BREAKPOINT_DEFAULTS } from ${JSON.stringify(repoPath('shared/properties/projectBreakpoints.ts'))};

const mode = new URLSearchParams(location.search).get('mode');
const PAGE = '<!doctype html><html><head><style>' +
  'body{margin:0;font:32px system-ui;color:#fff;background:rgb(0, 0, 255)}' +
  '.label::after{content:"Base"}' +
  '@media (width < 64rem){body{background:rgb(255, 0, 0)}.label::after{content:"Laptop: width < 64rem"}}' +
  '</style></head><body><h1 style="margin:0;padding:48px" class="label"></h1></body></html>';
function Harness() {
  const [device, setDevice] = useState(mode === 'before' ? 'canvas' : 'desktop');
  const dimensions = usePreviewDimensions();
  const sizing = usePreviewSizing(device, dimensions, BREAKPOINT_DEFAULTS, { deviceShortcuts: false }, setDevice);
  window.harness = { device, setDevice, width: sizing.viewport.width, scale: sizing.viewport.scale, active: sizing.activeDevice };
  return React.createElement('div', { className: 'preview-frame-wrap', ref: sizing.wrapRef, style: { position: 'absolute', inset: 0 } },
    React.createElement(SizedFrame, { sizing }, React.createElement('iframe', { title: 'Site', srcDoc: PAGE })));
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#1e1e1e}' +
  `#root{position:relative;width:${PANE.width}px;height:${PANE.height}px;overflow:hidden}</style></head>` +
  '<body><div id="root"></div><script src="/harness.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const READ = \`(() => {
  const page = document.querySelector('.frame-clip iframe').contentWindow;
  return {
    device: window.harness.device,
    active: window.harness.active,
    width: window.harness.width,
    scale: window.harness.scale,
    transform: document.querySelector('.frame-sized').style.transform === '' ? 'none' : getComputedStyle(document.querySelector('.frame-sized')).transform,
    laptop: page.matchMedia('(width < 64rem)').matches,
    innerWidth: page.innerWidth,
    background: page.getComputedStyle(page.document.body).backgroundColor,
  };
})()\`;
// Each animation frame: the device React committed and the width the page is laid out at.
const RECORD = \`(() => {
  window.frames_recorded = [];
  const tick = () => {
    const page = document.querySelector('.frame-clip iframe').contentWindow;
    window.frames_recorded.push({ device: window.harness.device, innerWidth: page.innerWidth, laptop: page.matchMedia('(width < 64rem)').matches });
    if (window.frames_recorded.length < 2000) { requestAnimationFrame(tick); }
  };
  requestAnimationFrame(tick);
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
  const win = new BrowserWindow({ show: false, width: ${PANE.width}, height: ${PANE.height}, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { modes: {}, frames: [], error: undefined };
  try {
    for (const mode of ['before', 'after']) {
      await win.loadURL('http://127.0.0.1:' + server.address().port + '/?mode=' + mode);
      for (let spin = 0; spin < 200 && !(await host('window.harness !== undefined && document.querySelector(".frame-clip iframe") !== null && document.querySelector(".frame-clip iframe").contentDocument.readyState === "complete"')); spin += 1) { await sleep(20); }
      await sleep(400);
      output.modes[mode] = await host(READ);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(DIRECTORY, mode + '-desktop-${PANE.width}.png'), image.toPNG());
    }
    await host(RECORD);
    // Each switch waits, bounded, until the recorder has drawn a frame with that device committed.
    // A fixed pause was not enough on the Linux runner, where a hidden window's frames come slowly
    // under load: the Phone switch was undone before any frame saw it (Check on a428bc5a).
    for (const device of ${JSON.stringify(SWITCHES)}) {
      const start = await host('window.frames_recorded.length');
      await host('window.harness.setDevice(' + JSON.stringify(device) + ')');
      const seen = 'window.frames_recorded.slice(' + start + ').some((frame) => frame.device === ' + JSON.stringify(device) + ')';
      for (let spin = 0; spin < 250 && !(await host(seen)); spin += 1) { await sleep(20); }
      await sleep(60);
    }
    output.frames = await host('window.frames_recorded');
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log(JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

// The checks over what the probe read, as failure lines.
function check(output) {
  const failures = [];
  const before = output.modes.before;
  const after = output.modes.after;
  if (before === undefined || after === undefined) {
    return ['both modes were read'];
  }
  // The fluid all-breakpoints frame and Desktop both fill the 882px pane less its gutters, and so agree.
  if (before.innerWidth !== FLUID_PAGE_WIDTH_PX) {
    failures.push(`before: the filling page is the pane's width less its gutters (${before.innerWidth})`);
  }
  if (before.laptop !== true) {
    failures.push('before: the filling page matches (width < 64rem)');
  }
  if (after.device !== 'desktop') {
    failures.push(`after: the device is desktop (${after.device})`);
  }
  if (after.active !== 'laptop') {
    failures.push(`after: the toolbar presses the device the 882px width belongs to, laptop (${after.active})`);
  }
  if (after.laptop !== true) {
    failures.push("after: window.matchMedia('(width < 64rem)').matches is true inside the frame, as in an 882px window");
  }
  if (after.innerWidth !== FLUID_PAGE_WIDTH_PX) {
    failures.push(`after: the page is laid out at the pane's width less its gutters (${after.innerWidth})`);
  }
  if (after.background !== 'rgb(255, 0, 0)') {
    failures.push(`after: the Laptop rule paints the page (${after.background})`);
  }
  if (after.scale !== 1) {
    failures.push(`after: the frame is never scaled (${after.scale})`);
  }
  if (after.transform !== 'translateX(-50%)' && after.transform !== 'none' && !/^matrix\(1, 0, 0, 1,/.test(after.transform)) {
    failures.push(`after: the frame carries no scale (${after.transform})`);
  }
  // No flicker: each frame lays the page out at the committed device's own width, never the pane's.
  if (output.frames.length < SWITCHES.length) {
    failures.push(`the recorder ran (${output.frames.length} frames)`);
  }
  const seen = new Set();
  for (const frame of output.frames) {
    seen.add(frame.device);
    if (frame.innerWidth !== DEVICE_WIDTH_PX[frame.device]) {
      failures.push(`a frame with ${frame.device} committed is laid out at ${frame.innerWidth}, not ${DEVICE_WIDTH_PX[frame.device]}`);
    }
    if (frame.device === 'desktop' && !frame.laptop) {
      failures.push('a Desktop frame in an 882px pane missed (width < 64rem)');
    }
  }
  for (const device of SWITCHES) {
    if (!seen.has(device)) {
      failures.push(`the recorder saw ${device}`);
    }
  }
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
    console.log('desktop-device-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/desktop-device-chromium');
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
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{"modes"'));
  const failures = [];
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
    console.error(`desktop-device-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`desktop-device-chromium: passed  [screenshots in ${directory}]`);
  }
})();
