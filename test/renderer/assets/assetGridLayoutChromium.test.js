// Goal: whatever pictures a folder holds, the Assets panel draws every view as a clean grid of equal
// cells: in Grid every tile is the same square, in the lists every row the same height; no tile
// overlaps another, none leaves the panel, row N sits exactly N row-heights down, and a thumbnail
// never grows past its box. The bug this holds: a tall picture (a phone screenshot) has an intrinsic
// height, and a box sized by `aspect-ratio` grows to fit its content, so the tile ran past its fixed
// row in the windowed grid and drew over the rows under it, in strips.
//
//   node test/renderer/assets/assetGridLayoutChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out the grid and decodes the
// pictures. A harness bundles the real AssetsPanel and styles.css over a fake bridge whose folder holds
// 60 mixed-aspect pictures with real intrinsic sizes (tall, wide, tiny, huge, sizeless transparent SVG)
// and other files, served by a `stacki-asset:` handler as Desktop serves them. For each panel width
// (260, 340, 600 px) and view (Grid, List, List - Small) it scrolls to the top, the middle and the end,
// waits (frame by frame, bounded, never a fixed time) until every drawn picture has loaded, and measures
// every drawn tile, thumbnail and picture. Screenshots go to node_modules/.stacki-test/asset-grid-layout/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const WIDTHS = [260, 340, 600];
const VIEWS = ['grid', 'list', 'compact'];
const HEIGHT_PX = 700;
const FILE_COUNT = 60;

// Pictures with the intrinsic sizes a real folder has: what grows a box that is sized by its content.
const PICTURES = [
  { name: 'phone', width: 1170, height: 2532, colour: '#0090ff' },
  { name: 'wide', width: 4000, height: 1200, colour: '#30a46c' },
  { name: 'icon', width: 16, height: 16, colour: '#e5484d' },
  { name: 'huge', width: 8000, height: 8000, colour: '#8e4ec6' },
  { name: 'portrait', width: 900, height: 1600, colour: '#f76b15' },
  { name: 'sizeless', width: undefined, height: undefined, colour: '#ffc53d' },
];

// A folder of real pictures (a scratch copy, never a live project) can stand in for the generated ones:
// STACKI_ASSET_LAYOUT_IMAGES=<folder> lists its files under their own names.
function realFixture(folder) {
  const entries = fixture(folder).entries.filter((entry) => entry.isDir);
  const names = fs
    .readdirSync(folder)
    .filter((name) => /\.(png|jpe?g|webp|avif|svg|gif)$/i.test(name))
    .slice(0, FILE_COUNT);
  names.forEach((name, index) => {
    entries.push({
      rel: `src/assets/images/${name}`,
      name,
      parent: 'src/assets/images',
      root: 'src',
      isDir: false,
      abs: path.join(folder, name),
      size: fs.statSync(path.join(folder, name)).size,
      modifiedMs: 1_700_000_000_000 + index * 1000,
    });
  });
  return { entries, missing: false };
}

// Camera-sized raster pictures, written by the probe with Electron's own encoder: what a real folder
// holds, and what a 72px tile must never decode at full size.
const RASTERS = [
  { name: 'photo', width: 4000, height: 2667 },
  { name: 'screenshot', width: 1170, height: 2532 },
  { name: 'tiny', width: 16, height: 16 },
];
const THUMBNAIL_WIDTH_PX_MAX = 256;

function fixture(directory) {
  const rasters = RASTERS.map((raster) => ({ file: path.join(directory, `${raster.name}.png`), extension: 'png' }));
  const vectors = PICTURES.map((picture) => {
    const file = path.join(directory, `${picture.name}.svg`);
    const size = picture.width === undefined ? '' : ` width="${picture.width}" height="${picture.height}"`;
    const box = picture.width === undefined ? '0 0 100 60' : `0 0 ${picture.width} ${picture.height}`;
    // Half transparent, so the checkerboard behind a picture is visible and must stay in its box.
    fs.writeFileSync(
      file,
      `<svg xmlns="http://www.w3.org/2000/svg"${size} viewBox="${box}"><rect x="10%" y="10%" width="80%" height="80%" rx="4%" fill="${picture.colour}"/></svg>`,
    );
    return { file, extension: 'svg' };
  });
  const sources = [...rasters, ...vectors];
  const folder = (rel, isRoot) => ({
    rel,
    name: rel.split('/').at(-1),
    parent: rel.split('/').slice(0, -1).join('/'),
    root: rel.split('/')[0],
    isDir: true,
    ...(isRoot ? { isRoot: true } : {}),
  });
  const entries = [folder('public', true), folder('src', true), folder('src/assets'), folder('src/assets/images'), folder('src/assets/images/depth-map')];
  const others = ['mp4', 'woff2', 'pdf'];
  for (let index = 0; index < FILE_COUNT; index += 1) {
    // Every fourth file is not a picture; the rest cycle through the rasters and the vectors.
    const source = sources[index % sources.length];
    const stem = path.basename(source.file, path.extname(source.file));
    const name = index % 4 === 3 ? `${stem}-${index}.${others[index % others.length]}` : `${stem}-${index}.${source.extension}`;
    entries.push({
      rel: `src/assets/images/${name}`,
      name,
      parent: 'src/assets/images',
      root: 'src',
      isDir: false,
      abs: source.file,
      size: 1000 * (index + 1),
      modifiedMs: 1_700_000_000_000 + index * 1000,
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
const project = '/layout-' + params.get('view');
// The view is chosen as a person's earlier choice would be: remembered for the project before it opens.
localStorage.setItem('stacki.assetsPanel.views', JSON.stringify([[project, { view: params.get('view'), sort: 'newest' }]]));
document.getElementById('root').style.width = params.get('width') + 'px';
window.avb = {
  mediaConnections: async () => ({ encryption: 'available', connections: [] }),
  listAssets: async () => (await fetch('/fixture.json')).json(),
  onAssetsChanged: () => () => {},
  getFilePath: () => '',
  assetDimensions: async () => ({ dims: { w: 1170, h: 2532 } }),
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
const pictures = () => [...document.querySelectorAll('.asset-items img')];
// Scrolls the panel to a share of its range, waits for the window to draw there and every picture to load, then measures.
window.measureAt = async (share) => {
  const scroller = document.querySelector('.asset-body');
  scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * share);
  await window.until(() => document.querySelectorAll('.asset-items .asset-tile').length > 0);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const loaded = await window.until(() => document.querySelector('.asset-items .ui-skeleton') === null && pictures().every((image) => image.complete && image.naturalWidth > 0));
  const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const items = document.querySelector('.asset-items');
  return {
    loaded: Boolean(loaded),
    scrollTop: scroller.scrollTop,
    columns: getComputedStyle(document.querySelector('.asset-items-window')).gridTemplateColumns.split(' ').length,
    panel: box(document.getElementById('root')),
    list: box(items),
    tiles: [...document.querySelectorAll('.asset-items .asset-tile')].map((tile) => {
      const thumb = tile.querySelector('.asset-thumb');
      const image = tile.querySelector('.asset-thumb img');
      return {
        index: Number(tile.getAttribute('data-asset-index')),
        rect: box(tile),
        thumb: box(thumb),
        thumbBackground: getComputedStyle(thumb).backgroundImage,
        image: image ? box(image) : undefined,
        natural: image ? { width: image.naturalWidth, height: image.naturalHeight } : undefined,
        imageBackground: image ? getComputedStyle(image).backgroundImage : undefined,
        name: tile.querySelector('.asset-name').textContent,
      };
    }),
  };
};
createRoot(document.getElementById('root')).render(React.createElement(AssetsPanel, { project: { path: project }, showToast: () => {} }));
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#111}' +
  `#root{position:relative;height:${HEIGHT_PX}px;display:flex;flex-direction:column;overflow:hidden;background:var(--bg-panel)}</style></head>` +
  '<body><div id="root"></div><script src="/harness.js"></script></body></html>';

const PROBE = (directory, shots, pictures) => `
const { app, BrowserWindow, session, nativeImage } = require('electron');
const { protocol } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const SHOTS = ${JSON.stringify(shots)};
const PICTURES = ${JSON.stringify(pictures)};
const PICTURE_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif' };
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
protocol.registerSchemesAsPrivileged([{ scheme: 'stacki-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const partition = 'asset-grid-layout-' + process.pid;
  session.fromPartition(partition).protocol.handle('stacki-asset', (request) => {
    let file = decodeURIComponent(new URL(request.url).pathname);
    if (process.platform === 'win32') { file = file.replace(/^[/]/, ''); }
    file = path.resolve(file);
    if (!file.startsWith(PICTURES) || !fs.existsSync(file)) { return new Response('', { status: 404 }); }
    return new Response(fs.readFileSync(file), { headers: { 'content-type': PICTURE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  });
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // The rasters: an opaque band across a transparent field, encoded as PNG.
  for (const raster of ${JSON.stringify(RASTERS)}) {
    const pixels = Buffer.alloc(raster.width * raster.height * 4);
    for (let y = Math.floor(raster.height / 4); y < Math.floor((raster.height * 3) / 4); y += 1) {
      pixels.fill(Buffer.from([200, 120, 40, 255]), y * raster.width * 4, (y + 1) * raster.width * 4);
    }
    fs.writeFileSync(path.join(DIRECTORY, raster.name + '.png'), nativeImage.createFromBitmap(pixels, { width: raster.width, height: raster.height }).toPNG());
  }
  const win = new BrowserWindow({ show: false, width: 640, height: ${HEIGHT_PX}, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, partition } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { runs: [], error: undefined };
  try {
    for (const width of ${JSON.stringify(WIDTHS)}) {
      for (const view of ${JSON.stringify(VIEWS)}) {
        await win.loadURL('http://127.0.0.1:' + server.address().port + '/?width=' + width + '&view=' + view);
        const ready = await host('window.until(() => document.querySelector(".asset-items-" + ' + JSON.stringify(view) + ' + " .asset-tile")).then(Boolean)');
        for (const share of [0, 0.5, 1]) {
          const measure = await host('window.measureAt(' + share + ')');
          output.runs.push({ width, view, share, ready: Boolean(ready), ...measure });
          if (share === 0) {
            const image = await win.webContents.capturePage({ x: 0, y: 0, width, height: ${HEIGHT_PX} });
            fs.writeFileSync(path.join(SHOTS, view + '-' + width + '.png'), image.toPNG());
          }
        }
      }
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  // A file, not stdout: a long line from Electron's stdout can arrive broken.
  fs.writeFileSync(path.join(DIRECTORY, 'result.json'), JSON.stringify(output));
  console.log('RESULT written');
  win.destroy(); server.close(); app.quit();
});
`;

const TOLERANCE_PX = 1;

// The checks over one measurement, as failure lines.
function checkRun(run) {
  const failures = [];
  const where = `${run.view} at ${run.width}px, scrolled ${run.share * 100}%`;
  const expect = (what, condition, detail) => {
    if (!condition) {
      failures.push(`${where}: ${what}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
    }
  };
  expect('the view drew its tiles', run.ready && run.tiles.length > 0, run.tiles.length);
  expect('every drawn picture loaded', run.loaded);
  if (run.tiles.length === 0) {
    return failures;
  }
  const first = run.tiles[0];
  for (const tile of run.tiles) {
    const name = tile.name;
    expect(`${name} is as wide as every other tile`, Math.abs(tile.rect.width - first.rect.width) <= TOLERANCE_PX, [tile.rect.width, first.rect.width]);
    expect(`${name} is as tall as every other tile`, Math.abs(tile.rect.height - first.rect.height) <= TOLERANCE_PX, [tile.rect.height, first.rect.height]);
    expect(`${name} stays inside the panel`, tile.rect.left >= run.panel.left - TOLERANCE_PX && tile.rect.right <= run.panel.right + TOLERANCE_PX, [
      tile.rect,
      run.panel,
    ]);
    expect(`${name} stays inside the list`, tile.rect.left >= run.list.left - TOLERANCE_PX && tile.rect.right <= run.list.right + TOLERANCE_PX, [
      tile.rect,
      run.list,
    ]);
    expect(`${name}'s thumbnail stays inside its tile`, inside(tile.thumb, tile.rect), [tile.thumb, tile.rect]);
    if (tile.image !== undefined) {
      expect(`${name}'s picture stays inside its thumbnail`, inside(tile.image, tile.thumb), [tile.image, tile.thumb]);
      // The checkerboard says "transparent here": behind the picture only, never across the box.
      expect(`${name}'s checkerboard is behind the picture only`, tile.thumbBackground === 'none' && /gradient/.test(tile.imageBackground), [
        tile.thumbBackground,
        tile.imageBackground,
      ]);
      if (/^(photo|screenshot)-/.test(name)) {
        expect(`${name} draws a small copy, not the full-size picture`, tile.natural.width <= THUMBNAIL_WIDTH_PX_MAX, tile.natural);
      }
    }
    if (run.view === 'grid') {
      expect(`${name}'s thumbnail is square`, Math.abs(tile.thumb.width - tile.thumb.height) <= TOLERANCE_PX, tile.thumb);
      expect(`${name}'s thumbnail fills its column`, Math.abs(tile.thumb.width - tile.rect.width) <= TOLERANCE_PX, [tile.thumb.width, tile.rect.width]);
    }
  }
  for (let index = 0; index < run.tiles.length; index += 1) {
    for (let other = index + 1; other < run.tiles.length; other += 1) {
      const left = run.tiles[index].rect;
      const right = run.tiles[other].rect;
      const overlapX = Math.min(left.right, right.right) - Math.max(left.left, right.left);
      const overlapY = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      expect(`${run.tiles[index].name} and ${run.tiles[other].name} do not overlap`, overlapX <= TOLERANCE_PX || overlapY <= TOLERANCE_PX, [left, right]);
    }
  }
  // Row N is exactly N row-heights below row 0 of the list, and a row is at least a tile tall.
  const rowOf = (tile) => Math.floor(tile.index / run.columns);
  const rows = [...new Set(run.tiles.map(rowOf))].sort((left, right) => left - right);
  const topOf = (row) => Math.min(...run.tiles.filter((tile) => rowOf(tile) === row).map((tile) => tile.rect.top));
  if (rows.length >= 2) {
    const pitch = (topOf(rows.at(-1)) - topOf(rows[0])) / (rows.at(-1) - rows[0]);
    expect('a row is at least as tall as its tiles', pitch >= first.rect.height - TOLERANCE_PX, [pitch, first.rect.height]);
    for (const row of rows) {
      expect(`row ${row} sits ${row} row-heights down the list`, Math.abs(topOf(row) - run.list.top - row * pitch) <= TOLERANCE_PX, [
        topOf(row) - run.list.top,
        row * pitch,
      ]);
      expect(
        `row ${row}'s tiles share one top`,
        run.tiles.filter((tile) => rowOf(tile) === row).every((tile) => Math.abs(tile.rect.top - topOf(row)) <= TOLERANCE_PX),
      );
    }
  }
  return failures;
}

function inside(inner, outer) {
  return (
    inner.left >= outer.left - TOLERANCE_PX &&
    inner.right <= outer.right + TOLERANCE_PX &&
    inner.top >= outer.top - TOLERANCE_PX &&
    inner.bottom <= outer.bottom + TOLERANCE_PX
  );
}

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('asset-grid-layout: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/asset-grid-layout');
  const shots = process.env.STACKI_ASSET_LAYOUT_SHOTS ?? directory;
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  const realImages = process.env.STACKI_ASSET_LAYOUT_IMAGES;
  fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify(realImages === undefined ? fixture(directory) : realFixture(path.resolve(realImages))));
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
  fs.writeFileSync(probe, PROBE(directory, shots, realImages === undefined ? directory : path.resolve(realImages)));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 240_000, env: environment, maxBuffer: 64 * 1024 * 1024 });
  const resultFile = path.join(directory, 'result.json');
  const failures = [];
  if (!fs.existsSync(resultFile)) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    }
    if (output.runs.length !== WIDTHS.length * VIEWS.length * 3) {
      failures.push(`every width, view and scroll offset was measured (${output.runs.length})`);
    }
    for (const measured of output.runs) {
      failures.push(...checkRun(measured));
    }
  }
  if (failures.length > 0) {
    console.error(`asset-grid-layout: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`asset-grid-layout: passed  [screenshots in ${shots}]`);
  }
})();
