// Goal: in the browser Desktop ships, the preview mode draws the canvas's width and height handles
// exactly as the design canvas does (same size, shape, colour, cursor and place), they sit in the
// gutter outside the page so they never cover it, and a drag on the preview's right handle widens
// the page there as on the canvas.
//
//   node test/renderer/preview/resizeHandlesChromium.test.js
//
// Method: run under the Electron binary, because the handles' look and place come from the real
// styles.css (hover opacity, offsets, the frame's scale) and only Chromium's own layout shows
// them. A harness bundles the real SizedFrame, PreviewModeStage and usePreviewSizing with the
// real styles.css. The design canvas is a `.preview-frame-wrap` holding SizedFrame; the preview
// is the PreviewModeStage, both at the tablet width over the same 1000 × 640 area, and an
// iframe page stands in for the site. With the pointer over each, the probe reads every
// handle's box and computed style, captures a screenshot of each mode, then drags the
// preview's right handle 60px with real input events and reads the frame's width again.
// The screenshots are written to node_modules/.stacki-test/resize-handles-chromium/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const AREA = { width: 1000, height: 640 };
const DRAG_PX = 60;

// The import paths are JSON-quoted: a Windows path's `\` inside a plain quoted string is an
// escape, so a quoted literal only works on POSIX.
const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SizedFrame, PreviewModeStage } from ${JSON.stringify(repoPath('src/features/preview/SizedFrame.tsx'))};
import { usePreviewSizing, usePreviewDimensions } from ${JSON.stringify(repoPath('src/features/preview/usePreviewSizing.ts'))};
import { BREAKPOINT_DEFAULTS } from ${JSON.stringify(repoPath('shared/properties/projectBreakpoints.ts'))};

const mode = new URLSearchParams(location.search).get('mode');
const PAGE = '<!doctype html><body style="margin:0;font:16px system-ui;background:#fff">' +
  '<header style="height:64px;background:#111;color:#fff;display:flex;align-items:center;padding:0 24px">Site</header>' +
  '<h1 style="margin:32px 24px">A page at the canvas size</h1>' +
  '<div style="margin:0 24px;height:220px;background:#dfe7ff;border-radius:12px"></div></body>';
function Page() {
  return React.createElement('iframe', { title: 'Site', srcDoc: PAGE });
}
function Harness() {
  const [device, setDevice] = useState('tablet');
  const dimensions = usePreviewDimensions();
  const sizing = usePreviewSizing(device, dimensions, BREAKPOINT_DEFAULTS, { deviceShortcuts: mode === 'design' }, setDevice);
  window.harness = { device, width: sizing.viewport.width, scale: sizing.viewport.scale };
  if (mode === 'design') {
    return React.createElement('div', { className: 'preview-frame-wrap', ref: sizing.wrapRef, style: { position: 'absolute', inset: 0 } },
      React.createElement(SizedFrame, { sizing }, React.createElement(Page)));
  }
  return React.createElement(PreviewModeStage, { sizing }, React.createElement(Page));
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#1e1e1e}' +
  `#root{position:relative;width:${AREA.width}px;height:${AREA.height}px;overflow:hidden}</style></head>` +
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
  const frame = document.querySelector('.frame-sized');
  const page = frame.querySelector('.frame-clip').getBoundingClientRect();
  const box = (rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
  const handles = {};
  for (const edge of ['w', 'e', 's']) {
    const handle = frame.querySelector('.rz-' + edge);
    const style = getComputedStyle(handle);
    handles[edge] = { className: handle.className, box: box(handle.getBoundingClientRect()), cursor: style.cursor, radius: style.borderRadius, opacity: style.opacity, background: style.backgroundColor };
  }
  return { page: box(page), handles, frameClass: frame.className, width: window.harness.width, device: window.harness.device };
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
  const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  const output = { modes: {}, dragged: undefined, error: undefined };
  try {
    for (const mode of ['design', 'preview']) {
      await win.loadURL('http://127.0.0.1:' + server.address().port + '/?mode=' + mode);
      for (let spin = 0; spin < 200 && !(await host('window.harness !== undefined && document.querySelector(".frame-sized") !== null')); spin += 1) { await sleep(20); }
      await sleep(400);
      // The pointer over the stage shows the handles (they fade in on hover). Wait, bounded, for the
      // fade to finish instead of a fixed pause: on the macOS runner the first mode was read while
      // its handles were still at opacity 0 (Check on a428bc5a). The move is repeated, since a hover
      // can be missed while the page is still settling; one that never arrives fails at the bound.
      const shown = 'Array.from(document.querySelectorAll(".frame-sized .rz-w, .frame-sized .rz-e, .frame-sized .rz-s")).every((handle) => getComputedStyle(handle).opacity === "1")';
      for (let spin = 0; spin < 100 && !(await host(shown)); spin += 1) {
        if (spin % 10 === 0) { mouse('mouseMove', 40 + (spin % 20), 40); }
        await sleep(30);
      }
      output.modes[mode] = await host(READ);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(DIRECTORY, mode + '.png'), image.toPNG());
    }
    // Drag the preview's right handle outward with real input.
    const handle = output.modes.preview.handles.e.box;
    const x = handle.left + handle.width / 2;
    const y = handle.top + handle.height / 2;
    mouse('mouseMove', x, y);
    await sleep(100);
    mouse('mouseDown', x, y);
    for (let step = 1; step <= 6; step += 1) {
      mouse('mouseMove', x + (${DRAG_PX} * step) / 6, y);
      await sleep(40);
    }
    await sleep(100);
    const during = await win.webContents.capturePage();
    fs.writeFileSync(path.join(DIRECTORY, 'preview-drag.png'), during.toPNG());
    const readout = await host('document.querySelector(".rz-readout") === null ? "" : document.querySelector(".rz-readout").textContent');
    mouse('mouseUp', x + ${DRAG_PX}, y);
    await sleep(300);
    output.dragged = { ...(await host(READ)), readout };
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log(JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

// The checks over what the probe read, as failure lines.
function check(output) {
  const failures = [];
  const design = output.modes.design;
  const preview = output.modes.preview;
  if (design === undefined || preview === undefined) {
    return ['both modes were read'];
  }
  for (const edge of ['w', 'e', 's']) {
    const designHandle = design.handles[edge];
    const previewHandle = preview.handles[edge];
    for (const property of ['className', 'cursor', 'radius', 'opacity', 'background']) {
      if (designHandle[property] !== previewHandle[property]) {
        failures.push(`${edge} handle ${property}: design ${designHandle[property]}, preview ${previewHandle[property]}`);
      }
    }
    for (const property of ['width', 'height', 'left', 'top']) {
      if (Math.abs(designHandle.box[property] - previewHandle.box[property]) > 0.5) {
        failures.push(`${edge} handle ${property}: design ${designHandle.box[property]}, preview ${previewHandle.box[property]}`);
      }
    }
    if (previewHandle.opacity !== '1') {
      failures.push(`${edge} handle is visible under the pointer (opacity ${previewHandle.opacity})`);
    }
  }
  // The handles sit in the gutter, clear of the page.
  if (preview.handles.e.box.left < preview.page.right) {
    failures.push(`the right handle starts at ${preview.handles.e.box.left}, inside the page ending at ${preview.page.right}`);
  }
  if (preview.handles.w.box.right > preview.page.left) {
    failures.push(`the left handle ends at ${preview.handles.w.box.right}, inside the page starting at ${preview.page.left}`);
  }
  if (preview.handles.s.box.top < preview.page.bottom) {
    failures.push(`the bottom handle starts at ${preview.handles.s.box.top}, inside the page ending at ${preview.page.bottom}`);
  }
  const dragged = output.dragged;
  if (dragged === undefined) {
    failures.push('the preview drag was read');
  } else {
    if (dragged.device !== 'custom') {
      failures.push(`the drag made the device custom (was ${dragged.device})`);
    }
    if (!(dragged.width > preview.width)) {
      failures.push(`the drag widened the page: ${preview.width} → ${dragged.width}`);
    }
    if (!/^\d+ × \d+$/.test(dragged.readout)) {
      failures.push(`the readout showed the size during the drag: "${dragged.readout}"`);
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
    console.log('resize-handles-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/resize-handles-chromium');
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
    console.error(`resize-handles-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`resize-handles-chromium: passed  [screenshots in ${directory}]`);
  }
})();
