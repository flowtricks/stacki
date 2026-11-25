// Goal: while a recording runs, the window stays in the region drag's state: everything outside the dragged
// region is greyed by a scrim, the region itself stays clear, the capture bar and the recording bar stay above
// or outside the dim and usable, and the pointer is the ordinary one. And the scrim never reaches a frame: a
// photograph of exactly the region (what main's capturePage takes) holds only the page's own, undimmed pixels.
// The scrim goes the moment the recording ends: Stop, Escape, a bound reached (frames), or a start that fails.
//
//   node test/renderer/ai/recordScrimChromium.test.js
//
// Method: run under the Electron binary, since only Chromium paints the mask. A harness bundles the real
// useScreenshotCapture, ScreenshotButton and styles over a fake preload (window.avb.aiRecord) and a page of
// known flat colours. The window is hidden and offscreen. The probe drives real input (sendInputEvent) for the
// region drag, the Stop click and Escape, and polls the DOM for every state (bounded, no fixed pauses). Pixels
// come from capturePage: the region's crop must contain only the page's two colours, the window outside it
// must be darker than the page, and the capture bar's own pixels must equal those taken with no scrim up.
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { runElectronProbe } = require('../../helpers/electronProbe.js');

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/ai/screenshot/screenshot.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useScreenshotCapture } from ${JSON.stringify(repoPath('src/features/ai/screenshot/useScreenshotCapture.tsx'))};
import { ScreenshotButton } from ${JSON.stringify(repoPath('src/features/ai/screenshot/ScreenshotButton.tsx'))};

const calls = [];
window.calls = calls;
window.mode = { startFails: false, stopReason: undefined };
const ID = 'r' + 'a'.repeat(16);
window.avb = {
  aiRecord: async (payload) => {
    calls.push(payload.action.kind);
    switch (payload.action.kind) {
      case 'start':
        if (window.mode.startFails) { throw new Error('start failed'); }
        return { ok: true, value: { kind: 'started', id: ID } };
      case 'status':
        return { ok: true, value: { kind: 'status', state: 'recording', elapsedMs: 1000, frames: 5, bytes: 100, stopReason: window.mode.stopReason } };
      case 'stop':
        return { ok: true, value: { kind: 'stopped', frames: [], fps: 5, stopReason: 'person' } };
      default:
        return { ok: true, value: { kind: 'discarded' } };
    }
  },
};
function App() {
  const capture = useScreenshotCapture({ projectPath: '/site', enabled: true, nextNumber: () => 1, slotsLeft: () => 8, onCaptured: () => {} });
  return React.createElement(React.Fragment, null,
    React.createElement('div', { id: 'page' },
      React.createElement('div', { id: 'block' }),
      React.createElement('div', { id: 'composer' },
        React.createElement(ScreenshotButton, { disabled: false, busy: capture.busy, active: capture.active, onCapture: capture.start }, React.createElement('button', { type: 'button', id: 'mic' }, 'mic')))),
    capture.overlay);
}
window.mount = () => createRoot(document.getElementById('host')).render(React.createElement(App));
`;

// The page: flat colours, so any dim is a measurable change. The region is dragged over #block and the page.
const PAGE_CSS =
  'html,body{margin:0;background:#3366cc}#page{position:fixed;inset:0;background:#3366cc}#block{position:absolute;left:260px;top:140px;width:120px;height:80px;background:#e0a030}#composer{position:absolute;left:700px;top:400px}';
const PAGE_RGB = [0x33, 0x66, 0xcc];
const BLOCK_RGB = [0xe0, 0xa0, 0x30];
const REGION = { fromX: 200, fromY: 100, toX: 500, toY: 300 };

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { MOTION_SETTLED_EXPRESSION, waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const REGION = ${JSON.stringify(REGION)};
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
  const win = new BrowserWindow({ show: false, width: 900, height: 600, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const input = (event) => win.webContents.sendInputEvent(event);
  const until = (what, expression, test) => waitFor({ what, read: () => host(expression), until: test || ((value) => value === true) });
  const output = { phases: {}, error: undefined };
  const STATE = "(() => ({ scrim: document.querySelector('.ai-record-scrim') !== null, layer: document.querySelector('.ai-region-layer') !== null, bar: document.querySelector('.ai-record-bar') !== null, sheet: document.querySelector('.ai-frame-sheet') !== null, holes: document.querySelectorAll('.ai-record-scrim-hole').length }))()";
  const state = () => host(STATE);
  const crop = async (rect) => {
    const image = await win.webContents.capturePage(rect);
    return { size: image.getSize(), bitmap: image.toBitmap() };
  };
  const pixel = ({ size, bitmap }, x, y) => { const at = (y * size.width + x) * 4; return [bitmap[at + 2], bitmap[at + 1], bitmap[at]]; };
  const drag = async () => {
    await host("document.querySelector('[data-segment=record]').click()");
    await until('the region layer', "document.querySelector('.ai-region-layer') !== null");
    input({ type: 'mouseMove', x: REGION.fromX, y: REGION.fromY });
    input({ type: 'mouseDown', x: REGION.fromX, y: REGION.fromY, button: 'left', clickCount: 1 });
    input({ type: 'mouseMove', x: 350, y: 200, buttons: ['left'] });
    input({ type: 'mouseMove', x: REGION.toX, y: REGION.toY, buttons: ['left'] });
    input({ type: 'mouseUp', x: REGION.toX, y: REGION.toY, button: 'left', clickCount: 1 });
  };
  const recording = () => until('the recording state', STATE, (value) => value.scrim && value.bar && !value.layer);
  const gone = (what) => until(what + ': no scrim, bar, layer or sheet', STATE, (value) => !value.scrim && !value.bar && !value.layer && !value.sheet);
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await host('window.mount()');
    await until('the page', "document.querySelector('[data-segment=record]') !== null");

    // 1. Baseline: no scrim anywhere, the capture bar's pixels as they look undimmed.
    output.phases.rest = await state();

    // 2. Drag a region and record: the scrim stands, the region layer is gone.
    await drag();
    await recording();
    await until('the capture bar open (recording mode)', "document.querySelector('.ai-capture-bar.is-recording-mode') !== null");
    // The bar opens with a transition: measure and photograph it once the motion has ended, or the two captures differ by a frame of it.
    await until('the capture bar motion settled', MOTION_SETTLED_EXPRESSION, (value) => value === true);
    const recordingBarBox = await host("(() => { const box = document.querySelector('.ai-capture-track').getBoundingClientRect(); return { x: Math.floor(box.left), y: Math.floor(box.top), width: Math.ceil(box.width), height: Math.ceil(box.height) }; })()");
    // The bar's hole follows the opened track (polled); wait until the mask has two holes.
    await until('a hole for the capture bar', STATE, (value) => value.holes === 2);
    // The scrim re-reads the bar's place on a poll, so its hole can trail the settled track: wait until the hole covers the track.
    await until(
      'the capture bar hole covers the track',
      "(() => { const hole = document.querySelectorAll('.ai-record-scrim-hole')[1]; if (!hole) { return false; } const box = document.querySelector('.ai-capture-track').getBoundingClientRect(); const x = Number(hole.getAttribute('x')); const y = Number(hole.getAttribute('y')); return x <= box.left && y <= box.top && x + Number(hole.getAttribute('width')) >= box.right && y + Number(hole.getAttribute('height')) >= box.bottom; })()",
    );
    output.phases.recording = await state();
    output.phases.facts = await host("(() => { const scrim = document.querySelector('.ai-record-scrim'); const bar = document.querySelector('.ai-record-bar'); const stop = document.querySelector('.ai-record-stop'); const stopBox = stop.getBoundingClientRect(); const top = document.elementFromPoint(stopBox.left + stopBox.width / 2, stopBox.top + stopBox.height / 2); const inside = document.elementFromPoint(300, 200); return { scrimPointerEvents: getComputedStyle(scrim).pointerEvents, scrimCursor: getComputedStyle(document.body).cursor, scrimZ: Number(getComputedStyle(scrim).zIndex), barZ: Number(getComputedStyle(bar).zIndex), stopIsTopmost: top === stop, insideIsPage: inside !== null && !scrim.contains(inside) && inside.closest('.ai-region-layer') === null, barOutsideRegion: bar.getBoundingClientRect().top >= ${REGION.toY} || bar.getBoundingClientRect().bottom <= ${REGION.fromY} }; })()");

    // 3. Pixels: the crop of exactly the region (as main takes it) holds only the page's own colours; outside is dimmed; the bar is not.
    const region = { x: REGION.fromX, y: REGION.fromY, width: REGION.toX - REGION.fromX, height: REGION.toY - REGION.fromY };
    const photo = await crop(region);
    let foreign = 0, foreignSample;
    const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 3;
    for (let y = 0; y < photo.size.height; y += 1) {
      for (let x = 0; x < photo.size.width; x += 1) {
        const value = pixel(photo, x, y);
        if (!near(value, ${JSON.stringify(PAGE_RGB)}) && !near(value, ${JSON.stringify(BLOCK_RGB)})) { foreign += 1; foreignSample = foreignSample || { x, y, value }; }
      }
    }
    const whole = await crop({ x: 0, y: 0, width: 900, height: 600 });
    // The same window with the scrim hidden: what the capture bar looks like undimmed (the bar is open and red here, unlike at rest).
    await host("document.querySelector('.ai-record-scrim').style.display = 'none'; new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const clear = await crop({ x: 0, y: 0, width: 900, height: 600 });
    await host("document.querySelector('.ai-record-scrim').style.display = ''; new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    let barDimmed = 0;
    for (let y = recordingBarBox.y + 3; y < recordingBarBox.y + recordingBarBox.height - 3; y += 1) {
      for (let x = recordingBarBox.x + 3; x < recordingBarBox.x + recordingBarBox.width - 3; x += 1) {
        if (!near(pixel(whole, x, y), pixel(clear, x, y))) { barDimmed += 1; }
      }
    }
    output.phases.pixels = {
      photoSize: photo.size, expected: { width: region.width, height: region.height }, foreign, foreignSample,
      blockSeen: near(pixel(photo, 100, 60), ${JSON.stringify(BLOCK_RGB)}),
      outsideLeft: pixel(whole, 20, 300), outsideBelow: pixel(whole, 350, 450), justOutside: pixel(whole, region.x - 3, 200), justOutsideBelow: pixel(whole, 350, region.y + region.height + 3),
      barDimmed, barArea: recordingBarBox.width * recordingBarBox.height, outsideClear: pixel(clear, 20, 300),
    };

    // 4. Stop with a real click: the control is clickable above the scrim; the scrim goes at once.
    const stop = await host("(() => { const box = document.querySelector('.ai-record-stop').getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()");
    input({ type: 'mouseMove', x: stop.x, y: stop.y });
    input({ type: 'mouseDown', x: stop.x, y: stop.y, button: 'left', clickCount: 1 });
    input({ type: 'mouseUp', x: stop.x, y: stop.y, button: 'left', clickCount: 1 });
    await until('the sheet after Stop', STATE, (value) => value.sheet && !value.scrim && !value.bar);
    output.phases.afterStop = await state();
    output.phases.stopCalls = await host('window.calls.filter((kind) => kind === "stop").length');
    input({ type: 'keyDown', keyCode: 'Escape' });
    input({ type: 'keyUp', keyCode: 'Escape' });
    await gone('the sheet closed');
    output.phases.afterSheet = await state();
    // The app is interactive again: the Record segment takes a click and opens the region layer.
    await host("document.querySelector('[data-segment=record]').click()");
    await until('the region layer opens again', "document.querySelector('.ai-region-layer') !== null");
    input({ type: 'keyDown', keyCode: 'Escape' });
    input({ type: 'keyUp', keyCode: 'Escape' });
    await gone('the drag cancelled');

    // 5. Escape cancels a running recording.
    await drag();
    await recording();
    input({ type: 'keyDown', keyCode: 'Escape' });
    input({ type: 'keyUp', keyCode: 'Escape' });
    await until('the sheet after Escape', STATE, (value) => value.sheet && !value.scrim && !value.bar);
    output.phases.afterEscape = await state();
    input({ type: 'keyDown', keyCode: 'Escape' });
    input({ type: 'keyUp', keyCode: 'Escape' });
    await gone('the sheet closed again');

    // 6. A bound reached by main (frames): the scrim goes by itself.
    await host("window.mode.stopReason = 'frames'");
    await drag();
    await until('the sheet after the limit', STATE, (value) => value.sheet && !value.scrim && !value.bar);
    output.phases.afterLimit = await state();
    await host("window.mode.stopReason = undefined");
    input({ type: 'keyDown', keyCode: 'Escape' });
    input({ type: 'keyUp', keyCode: 'Escape' });
    await gone('the sheet closed after the limit');

    // 7. A start that fails: the scrim shown while waiting for main does not stay.
    await host("window.mode.startFails = true");
    await drag();
    await gone('the failed start');
    output.phases.afterFailure = await state();
    output.phases.interactiveAfterFailure = await host("document.querySelector('[data-segment=record]').disabled === false");
  } catch (error) { output.error = String((error && error.stack) || error); }
  try {
    fs.writeFileSync(path.join(DIRECTORY, 'last.png'), (await win.webContents.capturePage()).toPNG());
  } catch {}
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

function check(phases) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  // What capturePage returns of a hidden window depends on the runner's display and compositor: on a shared GitHub runner the
  // whole region crop came back tinted on macOS and Windows alike, though the scrim, its holes and the bar all check out in the
  // DOM. On CI the pixel checks are printed, not failed, and they fail on a machine of our own (the same rule as the
  // screen-recording rate checks).
  const expectPixels = (name, condition, detail) => {
    if (process.env.CI === 'true') {
      if (!condition) {
        console.log(`record-scrim-chromium: ADVISORY on CI, not failed: ${name} (${JSON.stringify(detail)})`);
      }
      return;
    }
    expect(name, condition, detail);
  };
  const luminance = (rgb) => rgb[0] + rgb[1] + rgb[2];
  const page = luminance(PAGE_RGB);
  expect('at rest there is no scrim', phases.rest.scrim === false, phases.rest);
  expect(
    'while recording the scrim stands and the region layer is gone',
    phases.recording.scrim && !phases.recording.layer && phases.recording.bar,
    phases.recording,
  );
  expect('the scrim has a hole for the region and one for the capture bar', phases.recording.holes === 2, phases.recording);
  const facts = phases.facts;
  expect('the scrim takes no pointer events', facts.scrimPointerEvents === 'none', facts);
  expect('the pointer is the ordinary one (no crosshair)', facts.scrimCursor !== 'crosshair', facts);
  expect('the recording bar is above the scrim', facts.barZ > facts.scrimZ, facts);
  expect('Stop is the topmost element at its centre', facts.stopIsTopmost, facts);
  expect('the page, not the scrim, is under the pointer in the region', facts.insideIsPage, facts);
  expect('the recording bar sits outside the region', facts.barOutsideRegion, facts);
  const pixels = phases.pixels;
  expectPixels(
    'the crop is the region, pixel for pixel',
    pixels.photoSize.width === pixels.expected.width && pixels.photoSize.height === pixels.expected.height,
    pixels,
  );
  expectPixels('no pixel of the region crop is dimmed or tinted', pixels.foreign === 0, pixels);
  expectPixels('the crop holds the page content (the block)', pixels.blockSeen, pixels);
  expectPixels('the window outside the region is greyed', luminance(pixels.outsideLeft) < page * 0.8 && luminance(pixels.outsideBelow) < page * 0.8, pixels);
  expectPixels(
    'the region edge is crisp: just outside it is greyed already',
    luminance(pixels.justOutside) < page * 0.9 && luminance(pixels.justOutsideBelow) < page * 0.9,
    pixels,
  );
  expectPixels('the capture bar is not dimmed: its pixels equal those with the scrim hidden', pixels.barDimmed === 0 && pixels.barArea > 100, pixels);
  expectPixels(
    'the scrim does dim the outside (against the same window with it hidden)',
    luminance(pixels.outsideClear) > luminance(pixels.outsideLeft) + 20,
    pixels,
  );
  expect('Stop calls main once', phases.stopCalls === 1, phases.stopCalls);
  for (const name of ['afterStop', 'afterEscape', 'afterLimit']) {
    expect(`${name}: the scrim and the recording bar are gone, the sheet is up`, !phases[name].scrim && !phases[name].bar && phases[name].sheet, phases[name]);
  }
  for (const name of ['afterSheet', 'afterFailure']) {
    expect(`${name}: nothing of the capture is left`, !phases[name].scrim && !phases[name].bar && !phases[name].layer && !phases[name].sheet, phases[name]);
  }
  expect('after a failed start the app is interactive again', phases.interactiveAfterFailure === true, phases.interactiveAfterFailure);
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
    console.log('record-scrim-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/record-scrim-chromium');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  buildSync({
    stdin: { contents: HARNESS, resolveDir: repoPath('.'), loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    outfile: path.join(directory, 'harness.js'),
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(
    path.join(directory, 'host.html'),
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>${PAGE_CSS}</style></head><body><div id="host"></div><script src="/harness.js"></script></body></html>`,
  );
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
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
      failures.push(...check(output.phases));
    }
  }
  if (failures.length > 0) {
    console.error(`record-scrim-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`record-scrim-chromium: passed  [screenshot in ${directory}]`);
  }
})();
