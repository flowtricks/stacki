// Goal: a capture of the canvas stage (what the AI screenshot and recording photograph) contains the editor's own marks: the
// selected node's outline in the right colour (blue for a plain element, green for a component), its name tag, and a pinned
// hover outline; and it contains nothing of the app around the stage (a toolbar beside it). The owner's report: captures were
// clean pages with no outline, no tag and no text marks.
//
//   node test/renderer/preview/canvasCaptureOutlinesChromium.test.js
//
// Method: run under the Electron binary, because only Chromium's compositor output shows what a capture holds. A harness bundles
// the real PreviewOverlays with the real styles.css over a white stage, next to a magenta "toolbar" that stands for app chrome.
// For each scenario the probe photographs the stage rect with `webContents.capturePage` (as ai:screenshot does, in a window that
// was never shown, so the hidden-window case is the default), reads the BGRA pixels, and counts those equal to the colour the page
// itself computed for the outline and for the tag. Negative space: a stage with no outline (nothing selected) holds no outline
// pixels, the stage capture holds no magenta while a capture of the whole window does (so the check can fail), and an empty
// rect is pinned to Electron's answer (the whole window), which is why the renderer never sends one.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const STAGE = { x: 120, y: 60, width: 600, height: 420 };

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewOverlays } from ${JSON.stringify(repoPath('src/features/preview/PreviewOverlays.tsx'))};

const scenario = new URLSearchParams(location.search).get('scenario');
const BOX = { x: 100, y: 120, w: 320, h: 160 };
const kind = scenario === 'component' ? 'component' : 'element';
const info = { label: kind === 'component' ? 'Card' : 'Heading', kind, tag: 'h2', astroAsset: false, dynamicTag: false, nodeKind: kind, childCount: 0, isLayout: false, bound: false };
const selected = scenario === 'element' || scenario === 'component';
const props = {
  rects: { 0: [BOX] }, spacing: {}, scale: 1, selPath: selected ? '0' : undefined, selOcc: selected ? 0 : undefined,
  hoverPath: scenario === 'hover' ? '0' : undefined, hoverOcc: scenario === 'hover' ? 0 : undefined,
  focusPath: undefined, focusWhole: true, textMarks: { hover: undefined, picked: undefined }, overlayInfo: () => info,
};
window.avb = { onCmsChanged: () => () => {} };
createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'overlay-layer', style: { position: 'fixed', left: ${STAGE.x}, top: ${STAGE.y}, width: ${STAGE.width}, height: ${STAGE.height}, background: '#ffffff', overflow: 'hidden' } },
    React.createElement(PreviewOverlays, props)));
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>body{margin:0;background:#1e1e1e}' +
  '#toolbar{position:fixed;left:0;top:0;width:100px;height:100%;background:#ff00ff}</style></head>' +
  '<body><div id="toolbar"></div><div id="root"></div><script src="/harness.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const STAGE = ${JSON.stringify(STAGE)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
app.on('window-all-closed', () => {});
const { pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
// Pixels of an image within one channel step of the colour, counted over the whole bitmap (BGRA).
function count(image, [red, green, blue]) {
  const bitmap = image.toBitmap();
  let matches = 0;
  for (let at = 0; at + 3 < bitmap.length; at += 4) {
    if (Math.abs(bitmap[at] - blue) <= 2 && Math.abs(bitmap[at + 1] - green) <= 2 && Math.abs(bitmap[at + 2] - red) <= 2) { matches += 1; }
  }
  return matches;
}
// Pixels of the toolbar: clearly magenta, red and blue high and green low. A display's colour conversion moves a channel by a
// few units (a Retina Mac captures #ff00ff as 255, 3, 255), past count()'s step, but never far enough to read as the white
// stage or an outline colour.
function countMagenta(image) {
  const bitmap = image.toBitmap();
  let matches = 0;
  for (let at = 0; at + 3 < bitmap.length; at += 4) {
    if (bitmap[at] >= 200 && bitmap[at + 1] <= 60 && bitmap[at + 2] >= 200) { matches += 1; }
  }
  return matches;
}
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 800, height: 600, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, zoomFactor: 1 } });
  const output = { scenarios: {}, error: undefined };
  try {
    for (const scenario of ['element', 'component', 'hover', 'none']) {
      await win.loadURL('http://127.0.0.1:' + server.address().port + '/?scenario=' + scenario);
      // The page is drawn when it has loaded and, for a scenario that draws an outline, the outline is in it; 'none' draws none,
      // so it waits for the load and one page task.
      await pollUntil({ what: 'the ' + scenario + ' scenario drawn', read: () => win.webContents.executeJavaScript('document.readyState === "complete" && (' + JSON.stringify(scenario === 'none') + ' || document.querySelector(".node-outline") !== null)'), until: Boolean, pollCountMax: 200 });
      await win.webContents.executeJavaScript('new Promise((resolve) => setTimeout(resolve, 0))');
      const colours = await win.webContents.executeJavaScript(\`(() => {
        const rgb = (text) => (text.match(/\\\\d+/g) || []).slice(0, 3).map(Number);
        const outline = document.querySelector('.node-outline');
        const tag = document.querySelector('.node-outline-tag');
        return { outline: outline ? rgb(getComputedStyle(outline).outlineColor) : undefined, tag: tag ? rgb(getComputedStyle(tag).backgroundColor) : undefined };
      })()\`);
      const stage = await win.webContents.capturePage(STAGE);
      const whole = await win.webContents.capturePage();
      const size = stage.getSize();
      const result = { size, colours, magentaInStage: countMagenta(stage), magentaInWindow: countMagenta(whole) };
      if (colours.outline) { result.outlinePixels = count(stage, colours.outline); }
      if (colours.tag) { result.tagPixels = count(stage, colours.tag); }
      output.scenarios[scenario] = result;
    }
    try {
      const empty = await win.webContents.capturePage({ x: 0, y: 0, width: 0, height: 0 });
      output.emptyRect = empty.isEmpty() ? 'empty' : 'image';
    } catch { output.emptyRect = 'refused'; }
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log(JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('canvas-capture-outlines-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/canvas-capture-outlines-chromium');
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
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{"scenarios"'));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line);
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    }
    const blue = (rgb) => rgb !== undefined && rgb[2] > rgb[0] && rgb[2] > rgb[1];
    const green = (rgb) => rgb !== undefined && rgb[1] > rgb[0] && rgb[1] > rgb[2];
    for (const [name, result] of Object.entries(output.scenarios)) {
      if (result.size.width < STAGE.width || result.size.height < STAGE.height) {
        failures.push(`${name}: the capture is ${result.size.width}x${result.size.height}, smaller than the stage`);
      }
      if (result.magentaInStage !== 0) {
        failures.push(`${name}: ${result.magentaInStage} pixels of the app's toolbar are in the stage capture`);
      }
      if (result.magentaInWindow === 0) {
        failures.push(`${name}: a capture of the whole window shows no toolbar, so the exclusion check proves nothing`);
      }
    }
    const { element, component, hover, none } = output.scenarios;
    if (element !== undefined) {
      if (!blue(element.colours.outline)) {
        failures.push(`element: the outline is ${JSON.stringify(element.colours.outline)}, not blue`);
      }
      if (!(element.outlinePixels > 400)) {
        failures.push(`element: only ${element.outlinePixels} outline pixels in the capture`);
      }
      if (!(element.tagPixels > 100)) {
        failures.push(`element: only ${element.tagPixels} name-tag pixels in the capture`);
      }
    }
    if (component !== undefined) {
      if (!green(component.colours.outline)) {
        failures.push(`component: the outline is ${JSON.stringify(component.colours.outline)}, not green`);
      }
      if (!(component.outlinePixels > 400)) {
        failures.push(`component: only ${component.outlinePixels} outline pixels in the capture`);
      }
      if (!(component.tagPixels > 100)) {
        failures.push(`component: only ${component.tagPixels} name-tag pixels in the capture`);
      }
    }
    if (hover !== undefined && !(hover.outlinePixels > 200)) {
      failures.push(`hover: only ${hover.outlinePixels} outline pixels in the capture`);
    }
    if (none !== undefined && (none.colours.outline !== undefined || none.colours.tag !== undefined)) {
      failures.push('none: an outline is drawn with nothing selected or hovered');
    }
    if (output.emptyRect !== 'image') {
      // Electron answers an empty rect with the whole window, so a zero-size stage must never reach capturePage: clampToWindow
      // returns undefined for it (test/renderer/ai/screenshot.test.js) and the payload parser refuses it. If Electron changes
      // this, the guard stays and this line says so.
      failures.push(`an empty rect now answers ${output.emptyRect}; the whole-window answer the guards rely on has changed`);
    }
  }
  if (failures.length > 0) {
    console.error(`canvas-capture-outlines-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('canvas-capture-outlines-chromium: passed');
  }
})();
