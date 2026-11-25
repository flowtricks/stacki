// Goal: in the "Pick frames" sheet the playhead's white triangle sits in its own row directly ABOVE the filmstrip,
// pointing down at the playhead line, and never over a thumbnail. At every dialog width from 340 to 640 px and at
// the first, a middle and the last frame it must: end at or above the strip's top edge, be centred on the line,
// stay inside the sheet (not clipped at either end of the timeline), leave every thumbnail the topmost element at
// its centre, reserve its row so the strip does not move when the playhead does, and still scrub when it is
// pressed and dragged.
//
//   node test/renderer/ai/framePickerPlayheadChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out the strip, the clip-path and the
// transform. A harness bundles the real FramePicker and styles.css and mounts it over a fake preload (window.avb)
// with 24 frames. The window is hidden and offscreen. The probe sets the content width, then polls (bounded, no fixed
// pauses) until the strip is laid out; it moves the playhead with the Home, End and arrow keys and polls aria-valuenow,
// and presses the triangle with real mouse input and polls for the frame the drag ends on. The geometry of the
// triangle is read from its pseudo-element's computed box (the element's own box plus the ::after offsets).
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { runElectronProbe } = require('../../helpers/electronProbe.js');

const WIDTHS_PX = [340, 420, 520, 640];
const FRAME_COUNT = 24;
// Sub-pixel layout rounds; edges within this distance are the same edge.
const EDGE_TOLERANCE_PX = 1;
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/ai/screenshot/screenshot.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FramePicker } from ${JSON.stringify(repoPath('src/features/ai/screenshot/FramePicker.tsx'))};

const frames = Array.from({ length: ${FRAME_COUNT} }, (_, index) => ({ index, atMs: index * 200, width: 800, height: 600, thumb: '${PIXEL}' }));
window.avb = {
  aiRecord: async (payload) => ({ ok: true, value: { kind: 'frame', image: { mimeType: 'image/png', data: '${PIXEL}', width: 800, height: 600 } } }),
};
window.mount = () => {
  window.root = createRoot(document.getElementById('host'));
  window.root.render(React.createElement(FramePicker, { projectPath: '/site', id: 'r' + 'a'.repeat(16), frames, fps: 5, cap: 8, onAdd: () => {}, onGone: () => {}, onDiscard: () => {} }));
};
`;

// Everything the probe reads from the page, in one expression: geometry in CSS pixels.
const MEASURE = `(() => {
  const strip = document.querySelector('.ai-frame-strip');
  const track = document.querySelector('.ai-frame-track');
  const playhead = document.querySelector('.ai-frame-playhead');
  const sheet = document.querySelector('.ai-frame-sheet');
  if (strip === null || track === null || playhead === null || sheet === null || strip.clientWidth === 0) { return undefined; }
  const tiles = [...strip.querySelectorAll('.ai-frame-tile')];
  if (tiles.length === 0) { return undefined; }
  const stripBox = strip.getBoundingClientRect();
  const trackBox = track.getBoundingClientRect();
  const sheetBox = sheet.getBoundingClientRect();
  const headBox = playhead.getBoundingClientRect();
  const after = getComputedStyle(playhead, '::after');
  const before = getComputedStyle(playhead, '::before');
  const rtl = getComputedStyle(playhead).direction === 'rtl';
  const triangleLeft = headBox.left + parseFloat(after.insetInlineStart === 'auto' ? after.left : after.left);
  const triangleWidth = parseFloat(after.width);
  const triangleTop = headBox.top + parseFloat(after.top);
  const triangleHeight = parseFloat(after.height);
  const lineLeft = headBox.left + parseFloat(before.left);
  const lineWidth = parseFloat(before.width);
  const covered = tiles.filter((tile) => {
    const box = tile.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    // Tiles pass pointer events to the strip, so the strip (or a tile) is the topmost thing there when nothing covers it.
    return hit === null || hit === playhead || !strip.contains(hit);
  }).length;
  return {
    stripTop: stripBox.top, stripLeft: stripBox.left, stripRight: stripBox.right, stripHeight: stripBox.height,
    trackTop: trackBox.top, sheetLeft: sheetBox.left, sheetRight: sheetBox.right,
    triangleTop, triangleBottom: triangleTop + triangleHeight, triangleLeft, triangleRight: triangleLeft + triangleWidth,
    triangleCentre: triangleLeft + triangleWidth / 2, lineCentre: lineLeft + lineWidth / 2, lineTop: headBox.top + parseFloat(before.top),
    tileCount: tiles.length, covered, rtl, now: Number(strip.getAttribute('aria-valuenow')),
    clipped: getComputedStyle(playhead).overflow !== 'visible',
  };
})()`;

const PROBE = (directory, widths, frameCount, tolerance) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const MEASURE = ${JSON.stringify(MEASURE)};
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
  const win = new BrowserWindow({ show: false, width: 700, height: 900, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { runs: [], error: undefined };
  const FIRST_FRAME = 0;
  const settled = (expected) => waitFor({ what: 'the strip at frame ' + expected, read: () => host(MEASURE), until: (value) => value !== undefined && value.now === expected + 1 });
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await host('window.mount()');
    for (const width of ${JSON.stringify(widths)}) {
      // The dialog's width is set outright (a hidden window does not grow past its display); wait until the sheet has it.
      await host("(() => { let style = document.getElementById('width'); if (style === null) { style = document.createElement('style'); style.id = 'width'; document.head.append(style); } style.textContent = '.modal.ai-frame-picker { width: ${'$'}{WIDTH}px !important; }'.replace('${'$'}{WIDTH}', '" + width + "'); })()");
      await waitFor({ what: 'the sheet laid out at ' + width, read: () => host(MEASURE), until: (value) => value !== undefined && Math.abs(value.sheetRight - value.sheetLeft - width) <= 4 });
      for (const place of ['first', 'middle', 'last']) {
        const target = place === 'first' ? 0 : place === 'middle' ? Math.floor(${frameCount} / 2) : ${frameCount} - 1;
        await host("document.querySelector('.ai-frame-sheet').focus()");
        const key = place === 'first' ? 'Home' : place === 'last' ? 'End' : null;
        if (key !== null) {
          await host("document.querySelector('.ai-frame-sheet').dispatchEvent(new KeyboardEvent('keydown', { key: '" + key + "', bubbles: true }))");
        } else {
          await host("document.querySelector('.ai-frame-sheet').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
          await settled(FIRST_FRAME);
          for (let step = 0; step < target; step += 1) {
            await host("document.querySelector('.ai-frame-sheet').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
          }
        }
        const measured = await settled(target);
        // Layout must settle to the same row geometry: the strip's offset below the track is the reserved row.
        output.runs.push({ width, place, measured });
      }
      // Press the triangle itself, drag right and let go: the playhead must land on a later frame.
      await host("document.querySelector('.ai-frame-sheet').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
      const start = await settled(FIRST_FRAME);
      const x = Math.round(start.triangleCentre), y = Math.round((start.triangleTop + start.triangleBottom) / 2);
      const toX = Math.round(start.stripRight - 4);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round((x + toX) / 2), y, buttons: ['left'] });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: toX, y, buttons: ['left'] });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: toX, y, button: 'left', clickCount: 1 });
      const dragged = await settled(${frameCount} - 1);
      output.runs.push({ width, place: 'dragged', measured: dragged });
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  try {
    fs.writeFileSync(path.join(DIRECTORY, 'sheet.png'), (await win.webContents.capturePage()).toPNG());
  } catch {}
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

function check(runs) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  expect('the probe measured the sheet', runs.length === WIDTHS_PX.length * 4, runs.length);
  for (const { width, place, measured } of runs) {
    const where = `${width}px, ${place}`;
    expect(`${where}: the triangle's bottom edge is at or above the strip's top edge`, measured.triangleBottom <= measured.stripTop + 0.5, measured);
    expect(`${where}: the triangle has height of its own`, measured.triangleBottom - measured.triangleTop >= 4, measured);
    expect(
      `${where}: the track reserves the triangle's row above the strip`,
      measured.stripTop - measured.trackTop >= measured.triangleBottom - measured.triangleTop - 0.5,
      measured,
    );
    expect(`${where}: the triangle is centred on the playhead line`, Math.abs(measured.triangleCentre - measured.lineCentre) <= EDGE_TOLERANCE_PX, measured);
    expect(`${where}: the line starts at the strip, under the triangle's tip`, Math.abs(measured.lineTop - measured.stripTop) <= EDGE_TOLERANCE_PX, measured);
    expect(
      `${where}: the triangle is not clipped by the sheet`,
      measured.triangleLeft >= measured.sheetLeft - 0.5 && measured.triangleRight <= measured.sheetRight + 0.5,
      measured,
    );
    expect(
      `${where}: the line stays on the strip`,
      measured.lineCentre >= measured.stripLeft - 0.5 && measured.lineCentre <= measured.stripRight + 0.5,
      measured,
    );
    expect(`${where}: no thumbnail is covered`, measured.covered === 0, measured);
    expect(`${where}: the playhead element does not clip its triangle`, measured.clipped === false, measured);
  }
  for (const width of WIDTHS_PX) {
    const rows = runs.filter((run) => run.width === width && run.place !== 'dragged').map((run) => run.measured.stripTop - run.measured.trackTop);
    expect(`${width}px: the strip does not move as the playhead does`, Math.max(...rows) - Math.min(...rows) <= 0.5, rows);
    const first = runs.find((run) => run.width === width && run.place === 'first');
    const last = runs.find((run) => run.width === width && run.place === 'last');
    expect(
      `${width}px: the playhead moves across the strip`,
      first !== undefined && last !== undefined && last.measured.lineCentre > first.measured.lineCentre,
      { first, last },
    );
  }
  return failures;
}

(() => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('frame-picker-playhead-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/frame-picker-playhead-chromium');
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
  fs.writeFileSync(
    path.join(directory, 'host.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#161616}</style></head>' +
      '<body><div id="host"></div><script src="/harness.js"></script></body></html>',
  );
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory, WIDTHS_PX, FRAME_COUNT, EDGE_TOLERANCE_PX));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = runElectronProbe(electronPath, [probe], { env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line.slice('RESULT '.length));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    } else {
      failures.push(...check(output.runs));
    }
  }
  if (failures.length > 0) {
    console.error(`frame-picker-playhead-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`frame-picker-playhead-chromium: passed  [screenshot in ${directory}]`);
  }
})();
