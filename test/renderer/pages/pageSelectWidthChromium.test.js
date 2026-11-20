// Goal: the Pages panel in Select mode fits a narrow panel. At 260px (the narrowest the sidebar goes) every row keeps its
// checkbox, the page name truncates instead of pushing the row wider, the header's Select button and the action bar's
// Cancel and Delete are all fully visible, and nothing scrolls sideways.
//
//   node test/renderer/pages/pageSelectWidthChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays the panel out. A harness bundles the real
// PagesPanel with styles.css and mounts it in a container of the width under test, with pages whose names are far too
// long for it. The probe presses Select, ticks rows through the page's own clicks, then polls once per animation frame
// (bounded) until the layout holds still, and reads the panel's scrollWidth against its clientWidth and every
// descendant's right edge against the panel's. Nothing waits a fixed time. Screenshots go to
// node_modules/.stacki-test/page-select-width/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const WIDTHS_PX = [260, 320, 480];

const HARNESS = `
import { createRoot } from 'react-dom/client';
import './src/app/styles.css';
import PagesPanel from './src/features/pages/PagesPanel';

const page = (name, route) => ({ path: '/site/src/pages/' + name, name, route });
const LONG = 'a-page-with-a-very-long-name-that-cannot-possibly-fit-in-two-hundred-and-sixty-pixels';
const pages = [
  page('index.astro', '/'),
  page('example-components.astro', '/example-components'),
  page('404.astro', '/404'),
  page(LONG + '.astro', '/' + LONG),
  page('blog/first-post.md', '/blog/first-post'),
  page('blog/' + LONG + '.md', '/blog/' + LONG),
];
const none = async () => undefined;
const host = { plan: async () => ({ ok: false, error: { code: 'x', message: 'x' } }), apply: async () => ({ ok: true, value: undefined }), fail: () => {} };
createRoot(document.getElementById('root')).render(
  <div id="harness-panel" style={{ width: __WIDTH__, height: 600, display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)' }}>
    <PagesPanel scan={{ pages, pageFolders: ['blog', 'empty'], layouts: [] }} currentPage={pages[1]} onSelect={() => {}} onCreate={() => {}}
      onCreateTemplate={none} connectSanity={() => null} onMovePage={() => {}} onCreateFolder={none} onRename={none} onRenameFolder={() => {}} bulkRemove={host} />
  </div>,
);
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css">' +
  '<style>html,body{margin:0;background:#111}</style></head><body><div id="root"></div>' +
  '<script>window.avb=new Proxy({},{get:()=>async()=>({ok:false,error:{code:"x",message:"x"}})});</script><script src="harness.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const WIDTHS = ${JSON.stringify(WIDTHS_PX)};
const SETTLE = \`new Promise((resolve) => {
  let frames = 0;
  let last = '';
  const step = () => {
    frames += 1;
    const panel = document.querySelector('.panel-section');
    const shape = panel === null ? '' : panel.scrollWidth + 'x' + panel.scrollHeight + ':' + panel.clientWidth + ':' + document.querySelectorAll('.list-item').length;
    if (panel !== null && shape === last && document.fonts.status === 'loaded') {
      resolve(true);
      return;
    }
    last = shape;
    if (frames > 600) {
      resolve(false);
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})\`;
const SELECT = \`document.querySelector('.panel-header .asset-select-link').click()\`;
const TICK = \`(() => {
  const rows = [...document.querySelectorAll('.panel-body .list-item')];
  rows.filter((row, index) => index % 2 === 1).forEach((row) => row.click());
  return rows.length;
})()\`;
const MEASURE = \`(() => {
  const panel = document.querySelector('.panel-section');
  const limit = panel.getBoundingClientRect().right;
  const inside = (element) => element.getBoundingClientRect().right <= limit + 0.5;
  const wide = [...panel.querySelectorAll('*')].filter((element) => !inside(element)).slice(0, 10).map((element) => element.tagName.toLowerCase() + '.' + String(element.className).split(' ').join('.'));
  const bar = document.querySelector('.page-select-bar');
  const buttons = bar === null ? [] : [...bar.querySelectorAll('button')].map((button) => ({ text: button.textContent, visible: inside(button) && button.getBoundingClientRect().width > 20 }));
  const header = document.querySelector('.panel-header .asset-select-link');
  const rows = [...document.querySelectorAll('.panel-body .list-item')];
  const boxes = rows.filter((row) => row.querySelector('input[type=checkbox]') !== null).length;
  const gutters = [...panel.querySelectorAll('*')].filter((element) => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY)).map((element) => getComputedStyle(element).scrollbarGutter);
  return { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth, wide, buttons, headerVisible: header !== null && inside(header), headerText: header && header.textContent, rows: rows.length, boxes, gutters };
})()\`;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const results = [];
  try {
    for (const width of WIDTHS) {
      const win = new BrowserWindow({ show: false, width, height: 700, useContentSize: true, webPreferences: { backgroundThrottling: false } });
      await win.loadFile(path.join(DIRECTORY, 'host-' + width + '.html'));
      const settled = await win.webContents.executeJavaScript(SETTLE);
      // React draws the mode on the next frame, so the rows are ticked once they have their checkboxes.
      await win.webContents.executeJavaScript(SELECT);
      await win.webContents.executeJavaScript(SETTLE);
      await win.webContents.executeJavaScript(TICK);
      const stillSettled = settled && (await win.webContents.executeJavaScript(SETTLE));
      const measured = await win.webContents.executeJavaScript(MEASURE);
      fs.writeFileSync(path.join(DIRECTORY, 'width-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      results.push({ width, settled: stillSettled, ...measured });
      win.destroy();
    }
    console.log('RESULT ' + JSON.stringify({ results }));
  } catch (error) {
    console.log('RESULT ' + JSON.stringify({ error: String(error && error.stack || error) }));
  }
  app.exit(0);
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
    console.log('page-select-width: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/page-select-width');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  for (const width of WIDTHS_PX) {
    buildSync({
      stdin: { contents: HARNESS.replace('__WIDTH__', String(width)), resolveDir: repoPath('.'), loader: 'tsx', sourcefile: 'harness.tsx' },
      bundle: true,
      outfile: path.join(directory, `harness-${width}.js`),
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      logLevel: 'silent',
      loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    fs.writeFileSync(
      path.join(directory, `host-${width}.html`),
      HOST.replace('harness.css', `harness-${width}.css`).replace('harness.js', `harness-${width}.js`),
    );
  }
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment, maxBuffer: 16 * 1024 * 1024 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line.slice('RESULT '.length));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    } else {
      for (const result of output.results) {
        const at = `${result.width}px`;
        if (!result.settled) {
          failures.push(`${at}: the panel did not settle`);
          continue;
        }
        if (result.scrollWidth > result.clientWidth) {
          failures.push(`${at}: the panel scrolls sideways (scrollWidth ${result.scrollWidth} > clientWidth ${result.clientWidth})`);
        }
        if (result.wide.length > 0) {
          failures.push(`${at}: wider than the panel: ${result.wide.join(', ')}`);
        }
        if (result.headerText !== 'Done' || !result.headerVisible) {
          failures.push(`${at}: the header's Select/Done button is visible (it reads ${result.headerText})`);
        }
        if (result.buttons.map((button) => button.text).join() !== 'Cancel,Delete' || result.buttons.some((button) => !button.visible)) {
          failures.push(`${at}: the action bar shows Cancel and Delete in full (${JSON.stringify(result.buttons)})`);
        }
        if (result.rows === 0 || result.boxes !== result.rows) {
          failures.push(`${at}: every row has its checkbox (${result.boxes} of ${result.rows})`);
        }
        if (result.gutters.some((gutter) => gutter !== 'stable')) {
          failures.push(`${at}: every scroll container keeps scrollbar-gutter: stable (${result.gutters.join(', ')})`);
        }
      }
    }
  }
  if (failures.length > 0) {
    console.error(`page-select-width: ${failures.length} checks failed\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`page-select-width: passed  [screenshots in ${directory}]`);
  }
})();
