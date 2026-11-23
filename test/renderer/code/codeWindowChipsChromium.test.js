// Goal: a chip pressed inside the floating code window (the `<style>` CSS editor) opens its editor
// as a real, sized popup beside the chip, never a hairline. Reported: pressing the ease chip of
// `transition: opacity 200ms ease` drew a 2px dark line down the canvas and no editor. The cause was
// the easing sheet's `max-width: var(--style-panel-width, 100vw)`: with the Style panel collapsed or
// not drawn the variable is published as 0px, and a sheet capped at 0px keeps only its borders and
// shadow. A sheet given its own frame (a code chip's) owns its width, so the panel's cap must not apply.
//
// Checks, per chip (the easing chip, the transition's time chip, a transform chip):
// - the popup is visible, inside the viewport, wide (easing > 300px, layer popover > 200px) and tall,
//   and sits near the chip, with `--style-panel-width: 0px` published (the collapsed panel) and without it;
// - no stray element: the popup is the only new `[data-popup]` surface, and no other node is a thin
//   (< 8px wide, > 100px tall) visible box;
// - a press outside closes only that popup, the code window stays open;
// - Escape closes the popup first, the window on the second Escape;
// - picking another easing writes it into the code (and only the value the gesture owns changes).
//
// Method: run under the Electron binary in a hidden window (only Chromium lays out the sheet, its
// z-index and its clipping). A harness bundles the app's styles and the real CodeWindow with the real
// useCodeChips, as CodeWindowHost wires them. The probe drives real mouse and key events
// (sendInputEvent) and polls page state with test/helpers/waitFor.js: no fixed pauses.
//
// Run it with `node test/renderer/code/codeWindowChipsChromium.test.js`.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const SOURCE = 'a {\n  transition: opacity 200ms ease, padding 569ms ease-in-out;\n  transform: translate3d(4rem, 3rem, 0rem);\n}';

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/style/tokens.css'))};
import ${JSON.stringify(repoPath('src/features/style/utilities.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import CodeWindow from ${JSON.stringify(repoPath('src/features/code/CodeWindow.tsx'))};
import { useCodeChips } from ${JSON.stringify(repoPath('src/features/style/codeChips/CodeChips.tsx'))};

let controls;
function Shell() {
  const [open, setOpen] = React.useState(true);
  const [text, setText] = React.useState(${JSON.stringify(SOURCE)});
  const chips = useCodeChips('stylesheet');
  controls = { text };
  return React.createElement('div', { id: 'canvas', style: { height: '100vh', background: '#333' } },
    open && React.createElement(CodeWindow, { title: '<style>', language: 'css', indentation: 'block', value: text, editorKey: 's1',
      onChange: setText, onClose: () => setOpen(false), extensions: chips.extension, overlay: chips.overlay }));
}
window.mount = () => { createRoot(document.getElementById('root')).render(React.createElement(Shell)); };
window.collapsePanel = (collapsed) => {
  // A panel that reports no width (collapsed) must not cap a sheet that carries its own frame.
  const style = document.documentElement.style;
  if (collapsed) {
    style.setProperty('--style-panel-width', '0px');
  } else {
    style.removeProperty('--style-panel-width');
  }
};
window.text = () => controls.text;
window.chipCenter = (selector, index) => {
  const box = document.querySelectorAll(selector)[index].getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
};
window.pointOf = (selector) => {
  const box = document.querySelector(selector).getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
};
const visibleBox = (element) => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
};
window.read = () => {
  const windowNode = document.querySelector('.code-window');
  const surfaces = [...document.querySelectorAll('[data-popup="popover"]')].filter((node) => !node.classList.contains('code-window') && !node.closest('.code-window'));
  const popup = surfaces[0];
  const box = popup ? popup.getBoundingClientRect() : undefined;
  const thin = [...document.body.querySelectorAll('*')].filter((node) => {
    if (!visibleBox(node) || node.closest('.code-window') || node.closest('[data-popup]')) { return false; }
    const rect = node.getBoundingClientRect();
    return rect.width < 8 && rect.height > 100 && getComputedStyle(node).display !== 'none' && node.id !== 'root';
  }).map((node) => node.className || node.tagName);
  return {
    windowOpen: !!windowNode,
    popupCount: surfaces.length,
    surfaceNames: surfaces.map((node) => node.className + '|' + Math.round(node.getBoundingClientRect().width)),
    popup: box && { left: box.left, top: box.top, width: box.width, height: box.height, phase: popup.getAttribute('data-popup-phase'), z: getComputedStyle(popup).zIndex },
    viewport: { width: innerWidth, height: innerHeight },
    thin,
    text: controls.text,
  };
};
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#161616}</style></head>' +
  '<body><div id="root"></div><script src="/harness.js"></script></body></html>';

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
  const output = { cases: [], error: undefined };
  const until = (what, expression, test) => waitFor({ what, read: () => host(expression), until: test });
  const click = async (point) => {
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
      win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
  };
  const escape = () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  };
  const popupDrawn = (state) => state.popupCount >= 1 && state.popup && state.popup.phase === 'open';
  const popupGone = (state) => state.popupCount === 0;
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await host('window.mount()');
    await until('the code window and its chips', 'window.read().windowOpen && document.querySelectorAll("[data-code-chip]").length', (value) => value);
    await waitForSteady({ what: 'the window at rest', read: () => host('window.read()'), until: (state) => state.windowOpen });
    const scenarios = [
      { name: 'easing chip, panel collapsed', chip: 'easing', index: 0, collapsed: true },
      { name: 'easing chip, no panel variables', chip: 'easing', index: 0, collapsed: false },
      { name: 'time (layers) chip', chip: 'layers', index: 0, collapsed: true },
      { name: 'transform chip', chip: 'layers', index: 1, collapsed: true },
    ];
    for (const scenario of scenarios) {
      await host('window.collapsePanel(' + scenario.collapsed + ')');
      const selector = '[data-code-chip="' + scenario.chip + '"]';
      const before = await host('window.read()');
      const chip = await host('window.chipCenter(' + JSON.stringify(selector) + ', ' + scenario.index + ')');
      await click(chip);
      const shown = await waitForSteady({ what: scenario.name + ' drawn', read: () => host('window.read()'), until: popupDrawn });
      const record = { name: scenario.name, chip, shown, before };
      await click({ x: 5, y: 690 });
      record.afterOutside = await waitForSteady({ what: scenario.name + ' closed by an outside press', read: () => host('window.read()'), until: popupGone });
      await click(chip);
      await waitForSteady({ what: scenario.name + ' drawn again', read: () => host('window.read()'), until: popupDrawn });
      // A transform's popover opens its one layer's editor above it: Escape peels one popup at a time.
      let state = await host('window.read()');
      for (let presses = 0; presses < 3 && state.popupCount > 0; presses += 1) {
        const countBefore = state.popupCount;
        escape();
        state = await waitForSteady({ what: scenario.name + ' one popup closed by Escape', read: () => host('window.read()'), until: (next) => next.popupCount < countBefore });
        if (state.popupCount > 0) {
          state.windowStillOpen = state.windowOpen;
        }
      }
      record.afterEscape = state;
      output.cases.push(record);
    }
    // Picking another easing writes it into the code.
    await host('window.collapsePanel(true)');
    await click(await host('window.chipCenter("[data-code-chip=easing]", 0)'));
    await waitForSteady({ what: 'the easing editor', read: () => host('window.read()'), until: popupDrawn });
    output.presetCount = await host('document.querySelectorAll(".embed-editor_ease-preset").length');
    await click(await host('window.pointOf(".embed-editor_ease-preset:nth-of-type(3)")'));
    output.picked = await waitForSteady({ what: 'the picked easing in the code', read: () => host('window.read()'), until: (state) => state.text !== ${JSON.stringify(SOURCE)} });
    escape();
    await waitForSteady({ what: 'the editor closed', read: () => host('window.read()'), until: popupGone });
    // The window closes on the second Escape.
    await host('document.querySelector(".cm-content").focus()');
    escape();
    output.afterWindowEscape = await waitForSteady({ what: 'the window closed', read: () => host('window.read()'), until: (state) => state.windowOpen === false });
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

const NEAR_PX = 400;

function check(output) {
  const failures = [];
  if (process.env.DEBUG_CHIPS) {
    console.log(JSON.stringify(output.cases.map((entry) => [entry.name, entry.shown.surfaceNames])));
  }
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  if (output.error !== undefined) {
    failures.push(output.error);
    return failures;
  }
  for (const record of output.cases) {
    const { name, shown, chip } = record;
    const popup = shown.popup;
    const widthMin = name.startsWith('easing') ? 300 : 200;
    expect(`${name}: the popup is wide enough`, popup.width > widthMin, popup);
    expect(`${name}: the popup is tall enough`, popup.height > 50, popup);
    expect(
      `${name}: the popup is inside the window`,
      popup.left >= -1 && popup.top >= -1 && popup.left + popup.width <= shown.viewport.width + 1 && popup.top + popup.height <= shown.viewport.height + 1,
      popup,
    );
    expect(`${name}: the popup is near the chip`, Math.abs(popup.left - chip.x) < NEAR_PX && Math.abs(popup.top + popup.height / 2 - chip.y) < 700, {
      popup,
      chip,
    });
    expect(`${name}: no stray thin element`, shown.thin.length === 0, shown.thin);
    expect(`${name}: an outside press closed only the popup`, record.afterOutside.popupCount === 0 && record.afterOutside.windowOpen === true);
    expect(`${name}: Escape closed only the popup`, record.afterEscape.popupCount === 0 && record.afterEscape.windowOpen === true);
  }
  expect('the easing editor offers presets', output.presetCount > 3, output.presetCount);
  // The third preset is Ease In Out: the one value the gesture owns changes, and nothing else in the code.
  expect('picking an easing writes it into the code', output.picked.text === SOURCE.replace('200ms ease,', '200ms ease-in-out,'), output.picked.text);
  expect('the second Escape closes the window', output.afterWindowEscape.windowOpen === false);
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
    console.log('code-window-chips-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/code-window-chips-chromium');
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
    console.error(`code-window-chips-chromium: ${failures.length} failure(s)`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log('code-window-chips-chromium: ok');
})();
