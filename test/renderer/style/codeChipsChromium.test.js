// Goal: the editors a code chip opens are compact in a real browser. The easing editor is never taller
// than min(560px, the window less 24px) at a 900px and a 600px tall window, its curve stays in view at
// the top and only its preset list scrolls; it sits above the layer popover it can be opened from; and
// the gradient editor in a chip's popover is the panel's 340px wide with its bar, angle and colour rows
// inside that width. A layered property's list in a chip's popover (2D & 3D transforms, here) lays
// its rows out as the panel does: icon at the row's start, label after it, rows marked by a fill with
// no border round the list and no divider between rows. The clip-path editor in a chip's popover is
// compact: at most 380px wide and 520px tall, its canvas at most 260px square.
//
//   node test/renderer/style/codeChipsChromium.test.js
//
// Method: run under the Electron binary, because only Chromium applies the stylesheets and lays out
// flex, max-height and scrolling. A harness bundles the app's styles, the panel's tokens and utilities,
// and the real EasingEditor, LayerPopover and GradientEditor, placed as a code chip places them
// (chipPopoverSpan). The window is hidden (offscreen, never shown) and resized from 900 to 600px tall
// between the two measurements. The probe reads boxes, computed z-indexes and scroll sizes; waits are
// for a condition, bounded. Fixtures only: nothing touches a project.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

// The cap the easing editor's stylesheet states: min(560px, 100vh - 24px).
const EASING_HEIGHT_PX_MAX = 560;
const EASING_WINDOW_MARGIN_PX = 24;
// Sub-pixel layout rounds; boxes within this distance are the same size.
const TOLERANCE_PX = 1;

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/style/tokens.css'))};
import ${JSON.stringify(repoPath('src/features/style/utilities.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import EasingEditor from ${JSON.stringify(repoPath('src/features/style/EasingEditor.tsx'))};
import LayerPopover from ${JSON.stringify(repoPath('src/features/style/LayerPopover.tsx'))};
import GradientEditor from ${JSON.stringify(repoPath('src/features/style/GradientEditor.tsx'))};
import { blankGradientOf } from ${JSON.stringify(repoPath('src/features/style/model/gradient.ts'))};
import { TransformsRow } from ${JSON.stringify(repoPath('src/features/style/TransformsRow.tsx'))};
import { chipPopoverSpan, chipDeclarationProps, ClipPathChipBody, CHIP_POPOVER_WIDTH_PX, CLIP_PATH_POPOVER_WIDTH_PX } from ${JSON.stringify(repoPath('src/features/style/codeChips/CodeChips.tsx'))};

const noop = () => {};
window.mount = () => {
  window.root?.unmount();
  document.getElementById('host').innerHTML =
    '<span id="anchor" style="position:fixed;left:40px;top:60px;width:16px;height:16px"></span>' +
    '<span id="list-anchor" style="position:fixed;left:520px;top:60px;width:16px;height:16px"></span>' +
    '<span id="clip-anchor" style="position:fixed;left:820px;top:20px;width:16px;height:16px"></span><div id="root"></div>';
  window.root = createRoot(document.getElementById('root'));
  const anchor = document.getElementById('anchor');
  const span = chipPopoverSpan(anchor.getBoundingClientRect(), CHIP_POPOVER_WIDTH_PX, window.innerWidth);
  window.root.render(
    React.createElement(React.Fragment, undefined,
      React.createElement(LayerPopover, { anchorEl: anchor, span, onClose: noop, ariaLabel: 'Gradient' },
        React.createElement(GradientEditor, { gradient: blankGradientOf('linear'), busy: false, onChange: noop })),
      React.createElement(LayerPopover, { anchorEl: document.getElementById('list-anchor'), span: { left: 520, width: CHIP_POPOVER_WIDTH_PX }, onClose: noop, ariaLabel: 'Transforms' },
        React.createElement(TransformsRow, { props: chipDeclarationProps({ property: 'transform', value: 'translate3d(4.6875rem, 3rem, 0rem) scale3d(0.9, 0.9, 1) rotateZ(2deg)', original: '' }, noop) })),
      React.createElement(LayerPopover, { anchorEl: document.getElementById('clip-anchor'), span: chipPopoverSpan({ left: 820 }, CLIP_PATH_POPOVER_WIDTH_PX, window.innerWidth), onClose: noop, ariaLabel: 'Clip path' },
        React.createElement(ClipPathChipBody, { initialValue: 'polygon(4.7% 42.5%, 25.7% 15.7%, 67.6% 41.4%, 82.4% 24.7%, 100% 100%, 0% 100%)', onApply: noop, onClear: noop })),
      React.createElement(EasingEditor, { value: 'ease', frame: { left: 40, width: 360 }, onChange: noop, onClose: noop }),
    ),
  );
};
window.until = (condition, framesMax = 300) =>
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
`;

const STEPS = `
window.steps = {
  async measure() {
    const drawn = await window.until(
      () => document.querySelector('.embed-editor_ease-modal') && document.querySelectorAll('.embed-editor_bg-layer-label').length === 3 && document.querySelector('.code-chip-clip .clip-path_canvas') && [...document.querySelectorAll('.embed-editor_layer-popover')].every((popover) => popover.style.visibility === 'visible'),
    );
    if (!drawn) { return { drawn: false }; }
    await window.until(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    const modal = document.querySelector('.embed-editor_ease-modal');
    const curve = document.querySelector('.embed-editor_ease-curve');
    const presets = document.querySelector('.embed-editor_ease-presets');
    const body = document.querySelector('.embed-editor_ease-body');
    const popover = document.querySelector('.embed-editor_layer-popover');
    const list = document.querySelector('.embed-editor_bg-layers');
    const borderOf = (element) => {
      const style = getComputedStyle(element);
      return ['Top', 'Right', 'Bottom', 'Left'].reduce((sum, side) => sum + (style['border' + side + 'Style'] === 'none' ? 0 : parseFloat(style['border' + side + 'Width'])), 0);
    };
    const rows = [...document.querySelectorAll('.embed-editor_bg-layer')].map((row) => {
      const main = row.querySelector('.embed-editor_bg-layer-main');
      const preview = main.firstElementChild.getBoundingClientRect();
      const label = row.querySelector('.embed-editor_bg-layer-label').getBoundingClientRect();
      const box = main.getBoundingClientRect();
      return {
        justify: getComputedStyle(main).justifyContent,
        previewFromStart: Math.round(preview.left - box.left),
        labelAfterPreview: Math.round(label.left - preview.right),
        border: borderOf(row),
        fill: getComputedStyle(row).backgroundColor,
      };
    });
    const popoverBox = document.querySelector('.embed-editor_layer-popover-box');
    const modalBox = modal.getBoundingClientRect();
    const curveBox = curve.getBoundingClientRect();
    const overflowing = [...popoverBox.querySelectorAll('*')].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.right > popoverBox.getBoundingClientRect().right + 1;
    }).length;
    return {
      drawn: true,
      windowHeight: window.innerHeight,
      modalHeight: modalBox.height,
      modalTop: modalBox.top,
      modalBottom: modalBox.bottom,
      curveInView: curveBox.top >= modalBox.top && curveBox.bottom <= modalBox.bottom,
      presetsScroll: getComputedStyle(presets).overflowY,
      presetsOverflow: presets.scrollHeight > presets.clientHeight,
      bodyScrolls: body.scrollHeight > body.clientHeight + 1 && getComputedStyle(body).overflowY !== 'hidden',
      modalZ: Number(getComputedStyle(modal).zIndex),
      popoverZ: Number(getComputedStyle(popover).zIndex),
      popoverWidth: popover.offsetWidth,
      popoverOverflowing: overflowing,
      popoverSideways: popoverBox.scrollWidth > popoverBox.clientWidth + 1,
      listBorder: borderOf(list),
      clip: (() => {
        const clipPopover = document.querySelector('.code-chip-clip').closest('.embed-editor_layer-popover');
        const canvas = document.querySelector('.code-chip-clip .clip-path_canvas');
        return { width: clipPopover.offsetWidth, height: clipPopover.offsetHeight, canvas: canvas.offsetWidth, canvasHeight: canvas.offsetHeight };
      })(),
      rows,
    };
  },
};
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#161616}</style></head>' +
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
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { tall: undefined, short: undefined, error: undefined };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await host('window.mount()');
    output.tall = await host('window.steps.measure()');
    win.setContentSize(1200, 600);
    await host('window.until(() => window.innerHeight === 600)');
    await host('window.mount()');
    output.short = await host('window.steps.measure()');
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

function check(name, measured) {
  const failures = [];
  const expect = (label, condition, detail) => {
    if (!condition) {
      failures.push(`${name}: ${label}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
    }
  };
  expect('the editors drew', measured !== undefined && measured.drawn === true);
  if (measured === undefined || measured.drawn !== true) {
    return failures;
  }
  const cap = Math.min(EASING_HEIGHT_PX_MAX, measured.windowHeight - EASING_WINDOW_MARGIN_PX);
  expect('the easing editor is no taller than its cap', measured.modalHeight <= cap + TOLERANCE_PX, { height: measured.modalHeight, cap });
  expect('the easing editor is inside the window', measured.modalTop >= 0 && measured.modalBottom <= measured.windowHeight + TOLERANCE_PX, measured);
  expect('the curve stays in view at the top', measured.curveInView === true);
  expect('the preset list is what scrolls', measured.presetsScroll === 'auto' && measured.presetsOverflow === true, measured);
  expect('nothing else in the easing editor scrolls', measured.bodyScrolls === false);
  expect('the easing editor sits above the popover it opens from', measured.modalZ > measured.popoverZ, { modal: measured.modalZ, popover: measured.popoverZ });
  expect('the gradient popover is the panel’s width', Math.abs(measured.popoverWidth - 340) <= TOLERANCE_PX, measured.popoverWidth);
  expect('the clip-path popover is compact across', measured.clip.width <= 380, measured.clip);
  expect('the clip-path popover is compact down', measured.clip.height <= Math.min(520, measured.windowHeight - EASING_WINDOW_MARGIN_PX), measured.clip);
  expect(
    'the clip-path canvas is a 220-260px square',
    measured.clip.canvas >= 220 && measured.clip.canvas <= 260 && measured.clip.canvas === measured.clip.canvasHeight,
    measured.clip,
  );
  expect('the list has no border round it', measured.listBorder === 0, measured.listBorder);
  expect('the list shows its three rows', measured.rows.length === 3, measured.rows.length);
  for (const row of measured.rows) {
    expect('a row starts with its icon at the start', row.justify !== 'center' && row.previewFromStart <= TOLERANCE_PX, row);
    expect('a row’s label follows its icon', row.labelAfterPreview >= 0 && row.labelAfterPreview <= 16, row);
    expect('a row has no border or divider', row.border === 0, row);
    expect('a row is marked by a fill', row.fill !== 'rgba(0, 0, 0, 0)', row);
  }
  expect('the gradient rows fit that width', measured.popoverOverflowing === 0 && measured.popoverSideways === false, measured);
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
    console.log('code-chips-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/code-chips-chromium');
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
  fs.writeFileSync(path.join(directory, 'steps.js'), STEPS);
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // As the gate runs every probe: no Dock tile, and every window kept off the screen.
  environment.NODE_OPTIONS = `${environment.NODE_OPTIONS ?? ''} --require ${JSON.stringify(repoPath('test/helpers/hideDockPreload.js'))}`.trim();
  const run = spawnSync(electronPath, [probe], {
    encoding: 'utf8',
    timeout: 120_000,
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line.slice('RESULT '.length));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    } else {
      failures.push(...check('a 900px window', output.tall), ...check('a 600px window', output.short));
    }
  }
  if (failures.length > 0) {
    console.error(`code-chips-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('code-chips-chromium: passed');
  }
})();
