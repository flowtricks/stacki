// Goal: in the floating code window (the `<style>` CSS editor), hovering a row of the variable picker a
// chip opens changes the canvas element's computed style at once, and leaving puts it back. Reported:
// hovering rows did nothing, because the picker a code chip opens was given no preview handlers and a
// code window has no Style card to carry the canvas preview channel.
//
// Checks, on a canvas element whose own style is `padding: 10px`, with a chip for
// `padding: 0 var(--accent) 2rem` in the code window:
// - hovering the `brand` row (30px) makes the element's computed padding-right 30px, and moving to
//   `wide` (50px) makes it 50px: the preview is the declaration with that variable in the chip's place;
// - the code window's text is untouched while hovering;
// - moving the pointer off the list puts the element's own 10px back;
// - Escape mid-hover puts it back and the picker closes with the code unchanged;
// - a click on a row writes that reference into the code (only the chip's range changes), and no
//   preview is left on the element once the frame has settled it.
//
// Method: run under the Electron binary in a hidden window (only Chromium computes the style and lays
// the picker out). A harness bundles the app's styles, the real CodeWindow with the real useCodeChips,
// and the real frame half of the hover preview (electron/preload/frameLiveRules.ts) registered as the
// canvas frame, so a hover travels the same message path as in the app. The project's variables are a
// stub of three sizes. The probe drives real mouse and key events (sendInputEvent) and polls page state
// with test/helpers/waitFor.js: no fixed pauses.
//
// Run it with `node test/renderer/code/codeWindowHoverPreviewChromium.test.js`.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build } = require('esbuild');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const SOURCE = 'a {\n\tpadding: 0 var(--accent) 2rem;\n}';

const VARIABLES_STUB = {
  'src/features/style/model/webflow.ts': () => ({
    contents: `
      export async function getProjectFontFamilies() { return []; }
      export async function getImageAssets() { return []; }
      export async function streamProjectVariables(onAdd) {
        onAdd({ name: 'accent', collection: 'Sizes', group: '', value: '1rem', binding: 'var(--accent)', type: 'Size' });
        onAdd({ name: 'brand', collection: 'Sizes', group: '', value: '30px', binding: 'var(--brand)', type: 'Size' });
        onAdd({ name: 'wide', collection: 'Sizes', group: '', value: '50px', binding: 'var(--wide)', type: 'Size' });
        return [];
      }
    `,
    loader: 'js',
  }),
};

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/style/tokens.css'))};
import ${JSON.stringify(repoPath('src/features/style/utilities.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import CodeWindow from ${JSON.stringify(repoPath('src/features/code/CodeWindow.tsx'))};
import { useCodeChips } from ${JSON.stringify(repoPath('src/features/style/codeChips/CodeChips.tsx'))};
import { getHost, setHost } from ${JSON.stringify(repoPath('src/features/style/model/host.ts'))};
import { setCanvasFrame } from ${JSON.stringify(repoPath('src/editor/canvasQuery.ts'))};
import { receiveLiveRules } from ${JSON.stringify(repoPath('electron/preload/frameLiveRules.ts'))};
import { ensureSharedVars } from ${JSON.stringify(repoPath('src/features/style/sharedVars.ts'))};

let controls;
function Shell() {
  const [text, setText] = React.useState(${JSON.stringify(SOURCE)});
  const chips = useCodeChips('stylesheet');
  controls = { text };
  return React.createElement(CodeWindow, { title: '<style>', language: 'css', indentation: 'block', value: text, editorKey: 's1',
    onChange: setText, onClose: () => undefined, extensions: chips.extension, overlay: chips.overlay });
}
window.mount = () => {
  ensureSharedVars();
  // The selected element, and the canvas frame the app would talk to: the real frame half of the hover preview.
  setHost({ ...getHost(), selectedId: 'n1', pathOf: () => '0.0' });
  setCanvasFrame({ postMessage: (message) => { receiveLiveRules(message); } });
  createRoot(document.getElementById('root')).render(React.createElement(Shell));
};
window.text = () => controls.text;
window.pointOf = (selector) => {
  const box = document.querySelector(selector).getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
};
window.chipCenter = (selector) => window.pointOf(selector);
window.read = () => {
  const picker = document.querySelector('.embed-editor_varpicker');
  const target = document.getElementById('canvas-target');
  return {
    pickerOpen: !!picker && getComputedStyle(picker).visibility === 'visible' && document.querySelectorAll('.embed-editor_varpicker-item').length > 0,
    paddingRight: getComputedStyle(target).paddingRight,
    inlineStyle: target.getAttribute('style'),
    text: controls.text,
  };
};
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css">' +
  '<style>html,body{margin:0;background:#161616}:root{--accent:1rem;--brand:30px;--wide:50px}</style></head>' +
  '<body><div id="canvas-target" data-avb-p="0.0" style="position:fixed;right:20px;bottom:20px;width:80px;height:40px;padding:10px;background:#888"></div>' +
  '<div id="root"></div><script src="/harness.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { waitFor, waitForSteady } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
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
  const win = new BrowserWindow({ show: false, width: 1100, height: 700, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { steps: {}, error: undefined };
  const until = (what, test) => waitForSteady({ what, read: () => host('window.read()'), until: test });
  const move = (point) => win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  const click = (point) => {
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
      win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
  };
  const escape = () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  };
  const rowPoint = (name) => host('window.pointOf(' + JSON.stringify('.embed-editor_varpicker-item[data-binding="var(--' + name + ')"]') + ')');
  const OUTSIDE = { x: 5, y: 690 };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await host('window.mount()');
    await waitFor({ what: 'the chip', read: () => host('document.querySelectorAll("[data-code-chip=variable]").length'), until: (count) => count > 0 });
    output.steps.start = await host('window.read()');
    const chip = await host('window.chipCenter("[data-code-chip=variable]")');
    await click(chip);
    await until('the picker is open', (state) => state.pickerOpen);

    // Hover: the declaration with the hovered variable in the chip's place shows on the element.
    move(await rowPoint('brand'));
    output.steps.brand = await until('the element shows brand', (state) => state.paddingRight === '30px');
    move(await rowPoint('wide'));
    output.steps.wide = await until('the element shows wide', (state) => state.paddingRight === '50px');
    // Leave: the element's own style is back.
    move(OUTSIDE);
    output.steps.left = await until('the element is restored on leave', (state) => state.paddingRight === '10px');

    // Escape mid-hover.
    move(await rowPoint('brand'));
    await until('the element shows brand again', (state) => state.paddingRight === '30px');
    escape();
    output.steps.escaped = await until('the element is restored on Escape and the picker closed', (state) => state.paddingRight === '10px' && !state.pickerOpen);

    // A click commits the reference and leaves no preview behind.
    await click(await host('window.chipCenter("[data-code-chip=variable]")'));
    await until('the picker is open again', (state) => state.pickerOpen);
    const brand = await rowPoint('brand');
    move(brand);
    await until('the element shows brand before the pick', (state) => state.paddingRight === '30px');
    click(brand);
    output.steps.picked = await until('the pick is in the code', (state) => state.text.includes('var(--brand)') && !state.pickerOpen);
    output.steps.settled = await until('no preview is left on the element', (state) => state.paddingRight === '10px');
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

function check(output) {
  const failures = [];
  if (output.error !== undefined) {
    failures.push(output.error);
    return failures;
  }
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  const { steps } = output;
  expect('the element starts at its own padding', steps.start.paddingRight === '10px', steps.start);
  expect('hovering brand shows 30px', steps.brand.paddingRight === '30px', steps.brand);
  expect('hovering brand leaves the code as written', steps.brand.text === SOURCE, steps.brand.text);
  expect('hovering wide shows 50px', steps.wide.paddingRight === '50px', steps.wide);
  expect('hovering wide leaves the code as written', steps.wide.text === SOURCE, steps.wide.text);
  expect('leaving the list restores the element', steps.left.paddingRight === '10px', steps.left);
  expect('leaving the list leaves no previewed variable in its inline style', !steps.left.inlineStyle.includes('var('), steps.left.inlineStyle);
  expect(
    'Escape restores the element, closes the picker and leaves the code',
    steps.escaped.paddingRight === '10px' && steps.escaped.text === SOURCE,
    steps.escaped,
  );
  expect('a click writes only the chip into the code', steps.picked.text === SOURCE.replace('var(--accent)', 'var(--brand)'), steps.picked.text);
  expect('no preview is left on the element after a pick', steps.settled.paddingRight === '10px' && !steps.settled.inlineStyle.includes('var('), steps.settled);
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
    console.log('code-window-hover-preview-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/code-window-hover-preview-chromium');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  await build({
    stdin: { contents: HARNESS, resolveDir: repoPath('.'), loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    outfile: path.join(directory, 'harness.js'),
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [stubSources('stub-variables', VARIABLES_STUB)],
  });
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment, maxBuffer: 64 * 1024 * 1024 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures =
    line === undefined ? [`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`] : check(JSON.parse(line.slice('RESULT '.length)));
  if (failures.length > 0) {
    console.error(`code-window-hover-preview-chromium: ${failures.length} failure(s)`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log('code-window-hover-preview-chromium: ok');
})();
