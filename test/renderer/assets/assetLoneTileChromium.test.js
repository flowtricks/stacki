// Goal: a folder holding one picture draws it as the same small grid tile a folder of several does, and only once,
// also when the Assets panel is reopened over a listing it remembers. The bug this holds: on that reopen the panel
// body and the item list mount in one commit, and the list's measuring layout effect ran before React attached the
// body's ref (an ancestor's ref attaches after its children's layout effects). The effect found no scroller, gave up
// without a ResizeObserver or scroll listener, and nothing re-ran it, so the list kept its unmeasured layout: one
// column as wide as the panel and an 18px row. A lone SVG then filled the panel as a square (231 x 231 in a 260px
// panel) and ran out of its row; with several files a later listing change re-ran the effect and hid the bug.
//
//   node test/renderer/assets/assetLoneTileChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out the grid. A harness bundles the real
// AssetsPanel and styles.css over a fake bridge. For each panel width and each folder (one sizeless SVG, which
// scales to whatever box it is given, and three files) it mounts the panel, waits for its tiles, unmounts it and
// mounts it again so the second mount starts from the remembered listing, as reopening the tab does. Then it measures
// the tiles: the lone tile must be as wide and tall as a tile among three at the same width, the grid must have more
// than one column, and there must be one tile and one thumbnail per file. Every wait is bounded and polled per frame.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const WIDTHS = [280, 480];
const FOLDERS = { one: 1, three: 3 };
const HEIGHT_PX = 600;
const TOLERANCE_PX = 1;

function fixture(directory, count) {
  // A background with a viewBox and no size of its own: an <img> of it takes whatever width its box allows.
  const file = path.join(directory, 'background.svg');
  fs.writeFileSync(
    file,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900"><rect x="40" y="40" width="1360" height="820" rx="40" fill="none" stroke="#888" stroke-width="8"/></svg>',
  );
  const folder = (rel, isRoot) => ({
    rel,
    name: rel.split('/').at(-1),
    parent: rel.split('/').slice(0, -1).join('/'),
    root: rel.split('/')[0],
    isDir: true,
    ...(isRoot ? { isRoot: true } : {}),
  });
  const entries = [folder('public', true), folder('src', true), folder('src/assets')];
  for (let index = 0; index < count; index += 1) {
    const name = index === 0 ? 'background.svg' : `background-${index}.svg`;
    entries.push({
      rel: `src/assets/${name}`,
      name,
      parent: 'src/assets',
      root: 'src',
      isDir: false,
      abs: file,
      size: 400,
      modifiedMs: 1_700_000_000_000 + index,
    });
  }
  return { entries, missing: false };
}

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import AssetsPanel from ${JSON.stringify(repoPath('src/features/assets/AssetsPanel.tsx'))};

const params = new URLSearchParams(location.search);
const folder = params.get('folder');
const project = '/lone-tile-' + folder;
localStorage.setItem('stacki.assetsPanel.views', JSON.stringify([[project, { view: 'grid', sort: 'newest' }]]));
const host = document.getElementById('root');
host.style.width = params.get('width') + 'px';
window.avb = {
  mediaConnections: async () => ({ encryption: 'available', connections: [] }),
  listAssets: async () => (await fetch('/fixture-' + folder + '.json')).json(),
  onAssetsChanged: () => () => {},
  getFilePath: () => '',
  assetDimensions: async () => ({ dims: { w: 1440, h: 900 } }),
};
const until = (condition, framesMax = 600) =>
  new Promise((resolve) => {
    const deadlineMs = performance.now() + 15000;
    let frames = 0;
    const tick = () => {
      let value;
      try { value = condition(); } catch { value = undefined; }
      if (value) { resolve(value); return; }
      frames += 1;
      if (frames > framesMax || performance.now() > deadlineMs) { resolve(false); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const mount = () => {
  const target = document.createElement('div');
  target.style.cssText = 'display:flex;flex-direction:column;height:100%';
  host.replaceChildren(target);
  const root = createRoot(target);
  root.render(React.createElement(AssetsPanel, { project: { path: project }, showToast: () => {} }));
  return root;
};
window.measure = async () => {
  // The first mount fetches the listing; the second starts from it, as reopening the Assets tab does.
  const first = mount();
  const listed = await until(() => document.querySelector('.asset-items .asset-tile'));
  first.unmount();
  mount();
  const drawn = await until(() => document.querySelector('.asset-items .asset-tile'));
  await frames();
  const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  return {
    listed: Boolean(listed),
    drawn: Boolean(drawn),
    columns: getComputedStyle(document.querySelector('.asset-items-window')).gridTemplateColumns.split(' ').length,
    tileCount: document.querySelectorAll('.asset-tile').length,
    thumbCount: document.querySelectorAll('.asset-thumb').length,
    tiles: [...document.querySelectorAll('.asset-items .asset-tile')].map((tile) => ({ rect: box(tile), thumb: box(tile.querySelector('.asset-thumb')) })),
  };
};
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#111}' +
  `#root{position:relative;height:${HEIGHT_PX}px;display:flex;flex-direction:column;overflow:hidden;background:var(--bg-panel)}</style></head>` +
  '<body><div id="root"></div><script src="/harness.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow, session, protocol } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
protocol.registerSchemesAsPrivileged([{ scheme: 'stacki-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const partition = 'asset-lone-tile-' + process.pid;
  session.fromPartition(partition).protocol.handle('stacki-asset', (request) => {
    let file = decodeURIComponent(new URL(request.url).pathname);
    if (process.platform === 'win32') { file = file.replace(/^[/]/, ''); }
    file = path.resolve(file);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { return new Response('', { status: 404 }); }
    return new Response(fs.readFileSync(file), { headers: { 'content-type': 'image/svg+xml' } });
  });
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 640, height: ${HEIGHT_PX}, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, partition } });
  const output = { runs: [], error: undefined };
  try {
    for (const width of ${JSON.stringify(WIDTHS)}) {
      for (const folder of ${JSON.stringify(Object.keys(FOLDERS))}) {
        await win.loadURL('http://127.0.0.1:' + server.address().port + '/?width=' + width + '&folder=' + folder);
        output.runs.push({ width, folder, ...(await win.webContents.executeJavaScript('window.measure()')) });
      }
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  fs.writeFileSync(path.join(DIRECTORY, 'result.json'), JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

// The checks over the runs, as failure lines.
function check(runs) {
  const failures = [];
  const expect = (what, condition, detail) => {
    if (!condition) {
      failures.push(`${what}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
    }
  };
  for (const run of runs) {
    const where = `${run.folder} at ${run.width}px`;
    expect(`${where}: the panel listed and drew the folder twice`, run.listed && run.drawn);
    expect(`${where}: one tile per file`, run.tileCount === FOLDERS[run.folder], run.tileCount);
    expect(`${where}: one thumbnail per file`, run.thumbCount === FOLDERS[run.folder], run.thumbCount);
    expect(`${where}: the reopened grid was measured into more than one column`, run.columns > 1, run.columns);
    for (const tile of run.tiles) {
      expect(`${where}: the thumbnail stays inside its tile`, tile.thumb.bottom <= tile.rect.bottom + TOLERANCE_PX, [tile.thumb, tile.rect]);
    }
  }
  for (const width of WIDTHS) {
    const lone = runs.find((run) => run.width === width && run.folder === 'one');
    const many = runs.find((run) => run.width === width && run.folder === 'three');
    if (lone === undefined || many === undefined || lone.tiles.length === 0 || many.tiles.length === 0) {
      failures.push(`at ${width}px: both folders were measured`);
      continue;
    }
    const [loneTile] = lone.tiles;
    const [manyTile] = many.tiles;
    expect(`at ${width}px: a lone tile is as wide as one among three`, Math.abs(loneTile.rect.width - manyTile.rect.width) <= TOLERANCE_PX, [
      loneTile.rect.width,
      manyTile.rect.width,
    ]);
    expect(`at ${width}px: a lone tile is as tall as one among three`, Math.abs(loneTile.rect.height - manyTile.rect.height) <= TOLERANCE_PX, [
      loneTile.rect.height,
      manyTile.rect.height,
    ]);
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
    console.log('asset-lone-tile: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/asset-lone-tile');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  for (const [folder, count] of Object.entries(FOLDERS)) {
    fs.writeFileSync(path.join(directory, `fixture-${folder}.json`), JSON.stringify(fixture(directory, count)));
  }
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
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment, maxBuffer: 16 * 1024 * 1024 });
  const resultFile = path.join(directory, 'result.json');
  const failures = [];
  if (!fs.existsSync(resultFile)) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    }
    if (output.runs.length !== WIDTHS.length * Object.keys(FOLDERS).length) {
      failures.push(`every width and folder was measured (${output.runs.length})`);
    }
    failures.push(...check(output.runs));
  }
  if (failures.length > 0) {
    console.error(`asset-lone-tile: ${failures.length} checks failed\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('asset-lone-tile: passed');
  }
})();
