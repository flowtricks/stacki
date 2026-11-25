// Goal: the "Make an Astro copy" dialog lays out whole at a wide window and at a narrow one: it fits the
// window, nothing is drawn past its edge or scrolls sideways, the location row stays one line with its
// "Choose…" button whole while a long location truncates with an ellipsis, the name field fills the body, the
// footer's buttons share one row, "Create copy" is the blue primary button once the values are checked, and a
// refused name or location takes the error fill (a background, never a border) with no row added under it.
//
//   node test/renderer/welcome/astroCopyDialogChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out flex, ellipsis and overflow. A harness
// bundles the real AstroCopyDialog with the app's stylesheets and mounts it over a fake preload bridge (never
// a real project) in a hidden window, at each width, with a short and a long location. Every wait is for a
// condition, polled once per animation frame and bounded; screenshots land in
// node_modules/.stacki-test/astro-copy-dialog-chromium/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { MOTION_SETTLED_EXPRESSION } = require('../../helpers/waitFor.js');

const VIEWPORT_WIDTHS_PX = [1000, 420];
const VIEWPORT_HEIGHT_PX = 700;
const LOCATIONS = [
  ['short', '/Users/me/Sites'],
  ['long', '/Volumes/Work/clients/acme-corporation-international/websites-for-the-spring-campaign-2026'],
];
// Sub-pixel layout rounds; an element this far past an edge is not overflowing.
const EDGE_TOLERANCE_PX = 1;

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/style/tokens.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import AstroCopyDialog from ${JSON.stringify(repoPath('src/features/welcome/AstroCopyDialog.tsx'))};

window.avb = {
  onCreateLog: () => () => {},
  checkAstroCopy: async (request) =>
    request.name === 'taken' ? { ok: false, error: 'target-exists' } : request.parentPath === '/locked' ? { ok: false, error: 'location-unwritable' } : { ok: true, value: { targetPath: request.parentPath + '/' + request.name } },
  createAstroCopy: () => new Promise(() => {}),
  parentDialog: async () => ({ canceled: true }),
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
window.mount = (parentPath, name) => {
  window.root?.unmount();
  window.root = createRoot(document.getElementById('host'));
  window.root.render(React.createElement(AstroCopyDialog, {
    source: { sourcePath: '/Users/me/Sites/shop', parentPath, name, homePath: '/Users/me' },
    onClose: () => {},
    onDone: () => {},
  }));
};
`;

const STEPS = `
window.steps = (() => {
  const box = (element) => element.getBoundingClientRect();
  const modal = () => document.querySelector('.astro-copy-modal');
  // Drawn past the dialog's edge, unless a box inside the dialog clips it (the location's ellipsis does).
  const clipped = (element) => {
    for (let parent = element.parentElement; parent !== null && parent !== modal(); parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== 'visible') {
        return true;
      }
    }
    return false;
  };
  const past = () => {
    const edge = box(modal()).right;
    return [...modal().querySelectorAll('*')]
      .filter((element) => { const rectangle = box(element); return rectangle.width > 0 && rectangle.height > 0 && rectangle.right > edge + ${EDGE_TOLERANCE_PX} && !clipped(element); })
      .map((element) => element.className + ' +' + Math.round(box(element).right - edge))
      .slice(0, 6);
  };
  // A line that truncates with an ellipsis is wider than its box by design: it clips, it does not scroll.
  const sideways = () => [...modal().querySelectorAll('*')]
    .filter((element) => getComputedStyle(element).overflowX !== 'visible' && getComputedStyle(element).textOverflow !== 'ellipsis' && element.scrollWidth > element.clientWidth + 1)
    .map((element) => element.className).slice(0, 6);
  const settled = () => ${MOTION_SETTLED_EXPRESSION};
  return {
    async ready() {
      return Boolean(await window.until(() => {
        const create = modal()?.querySelector('.modal-footer .primary');
        return create !== undefined && create !== null && !create.disabled && settled();
      }));
    },
    measure() {
      const dialog = modal();
      const body = dialog.querySelector('.modal-body');
      const input = dialog.querySelector('input');
      const row = dialog.querySelector('.astro-copy-location');
      const code = row.querySelector('.code-inline');
      const choose = row.querySelector('button');
      const buttons = [...dialog.querySelectorAll('.modal-footer button')];
      const create = dialog.querySelector('.modal-footer .primary');
      const bodyStyle = getComputedStyle(body);
      const bodyInner = box(body).width - parseFloat(bodyStyle.paddingLeft) - parseFloat(bodyStyle.paddingRight);
      return {
        dialogLeft: box(dialog).left,
        dialogRight: box(dialog).right,
        windowWidth: window.innerWidth,
        past: past(),
        sideways: sideways(),
        inputFills: Math.abs(box(input).width - bodyInner) <= 1.5,
        rowHeight: box(row).height,
        chooseHeight: box(choose).height,
        chooseInside: box(choose).right <= box(row).right + ${EDGE_TOLERANCE_PX} && box(choose).left >= box(code).right - ${EDGE_TOLERANCE_PX},
        chooseWhole: choose.scrollWidth <= choose.clientWidth + 1,
        codeTruncates: code.scrollWidth > code.clientWidth + 1,
        codeEllipsis: getComputedStyle(code).textOverflow,
        codeText: code.textContent,
        footerOneRow: new Set(buttons.map((button) => Math.round(box(button).top))).size === 1,
        createBackground: getComputedStyle(create).backgroundColor,
        createEnabled: !create.disabled,
        rowBackground: getComputedStyle(row).backgroundColor,
        bodyChildren: body.children.length,
        inputBorder: getComputedStyle(input).borderTopWidth + ' ' + getComputedStyle(input).borderTopColor,
        inputBackground: getComputedStyle(input).backgroundColor,
      };
    },
    async refuse(name) {
      const input = modal().querySelector('input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const marked = await window.until(() => input.getAttribute('aria-invalid') === 'true' && modal().querySelector('.modal-footer .primary').disabled);
      await window.until(() => ${MOTION_SETTLED_EXPRESSION});
      const style = getComputedStyle(input);
      return { marked: Boolean(marked), background: style.backgroundColor, border: style.borderTopWidth + ' ' + style.borderTopColor, bodyChildren: modal().querySelector('.modal-body').children.length };
    },
    async refuseLocation() {
      const row = modal().querySelector('.astro-copy-location');
      const marked = await window.until(() => row.getAttribute('aria-invalid') === 'true');
      await window.until(() => ${MOTION_SETTLED_EXPRESSION});
      return { marked: Boolean(marked), background: getComputedStyle(row).backgroundColor };
    },
  };
})();
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#111}</style></head>' +
  '<body><div id="host"></div><script src="/harness.js"></script><script src="/steps.js"></script></body></html>';

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
  const win = new BrowserWindow({ show: false, width: 1000, height: ${VIEWPORT_HEIGHT_PX}, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(DIRECTORY, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const output = { cases: [], error: undefined };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    for (const width of ${JSON.stringify(VIEWPORT_WIDTHS_PX)}) {
      win.setContentSize(width, ${VIEWPORT_HEIGHT_PX});
      await host('window.until(() => window.innerWidth === ' + width + ')');
      for (const [label, location] of ${JSON.stringify(LOCATIONS)}) {
        await host('window.mount(' + JSON.stringify(location) + ', "shop-astro")');
        const ready = await host('window.steps.ready()');
        const item = { width, label, ready, measured: undefined, refused: undefined, location: undefined };
        if (ready) {
          item.measured = await host('window.steps.measure()');
          await shot(label + '-' + width);
          item.refused = await host('window.steps.refuse("a:b")');
          await shot(label + '-' + width + '-refused');
        }
        output.cases.push(item);
      }
      await host('window.mount("/locked", "shop-astro")');
      output.cases.push({ width, label: 'locked', location: await host('window.steps.refuseLocation()') });
      await shot('locked-' + width);
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

// The error fill every refused field takes (styles.css, `.modal-body input[aria-invalid='true']`).
const ERROR_FILL = 'rgba(255, 69, 58, 0.18)';

function check(output) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  expect('every width and location was drawn', output.cases.length === VIEWPORT_WIDTHS_PX.length * (LOCATIONS.length + 1), output.cases.length);
  for (const item of output.cases) {
    const where = `${item.width}px ${item.label}`;
    if (item.label === 'locked') {
      expect(`${where}: a refused location takes the error fill`, item.location?.marked === true && item.location.background === ERROR_FILL, item.location);
      continue;
    }
    expect(`${where}: the dialog drew with its values checked`, item.ready === true);
    const measured = item.measured;
    if (measured === undefined) {
      continue;
    }
    expect(`${where}: the dialog fits the window`, measured.dialogLeft >= 0 && measured.dialogRight <= measured.windowWidth + EDGE_TOLERANCE_PX, measured);
    expect(`${where}: nothing is drawn past the dialog, and nothing scrolls sideways`, measured.past.length === 0 && measured.sideways.length === 0, measured);
    expect(`${where}: the name field fills the body`, measured.inputFills === true);
    expect(`${where}: the location row is one line`, measured.rowHeight < measured.chooseHeight * 1.8, measured);
    expect(`${where}: Choose… sits whole at the row's end`, measured.chooseInside === true && measured.chooseWhole === true, measured);
    expect(`${where}: the location truncates with an ellipsis`, measured.codeEllipsis === 'ellipsis', measured.codeEllipsis);
    if (item.label === 'long' && item.width < 600) {
      expect(`${where}: a long location is cut, not wrapped`, measured.codeTruncates === true, measured);
    }
    expect(`${where}: the footer's buttons share one row`, measured.footerOneRow === true);
    expect(
      `${where}: Create copy is enabled and blue`,
      measured.createEnabled === true && /^rgb\((\d+), (\d+), (\d+)\)$/.test(measured.createBackground) && isBlue(measured.createBackground),
      measured.createBackground,
    );
    expect(`${where}: the location row is a fill, not a border`, measured.rowBackground !== 'rgba(0, 0, 0, 0)', measured.rowBackground);
    const refused = item.refused;
    expect(`${where}: a refused name is marked`, refused?.marked === true, refused);
    if (refused !== undefined) {
      expect(`${where}: it takes the error fill`, refused.background === ERROR_FILL, refused.background);
      expect(`${where}: its border is unchanged`, refused.border === measured.inputBorder, { before: measured.inputBorder, after: refused.border });
      expect(`${where}: and no row is added under it`, refused.bodyChildren === measured.bodyChildren, refused);
    }
  }
  return failures;
}

function isBlue(color) {
  const [red, green, blue] = (color.match(/\d+/g) ?? []).map(Number);
  return blue > red + 40 && blue > green;
}

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('astro-copy-dialog-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/astro-copy-dialog-chromium');
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
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 240_000, env: environment, maxBuffer: 64 * 1024 * 1024 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line.slice('RESULT '.length));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    } else {
      failures.push(...check(output));
    }
  }
  if (failures.length > 0) {
    console.error(`astro-copy-dialog-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`astro-copy-dialog-chromium: passed  [screenshots in ${directory}]`);
  }
})();
