// Goal: in the browser Desktop ships, the real Assets panel draws the same files in its three views
// (Grid, List, List - Small), sorts them as its footer says, remembers both choices per project
// before its first frame, and stays as cheap with 5,000 files as with 60.
//
//   node test/renderer/assets/assetViewsChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out the grid, the middle ellipsis
// and the scroll window. A harness bundles the real AssetsPanel and styles.css into a 260 x 700 pane
// (the left panel's default width) over a fake bridge: the listing comes from a fixture written here,
// pictures are SVG files served by a `stacki-asset:` handler as Desktop serves them, and the dimension
// reader answers from the fixture while counting its calls. Every wait is for a condition, polled once
// per animation frame and bounded; nothing waits a fixed time. A choice in a menu is checked in the
// frame that follows the click. "Fast" is held as DOM size, never milliseconds: the 5,000-file folder
// must draw no more nodes than a 60-file one that also fills the pane, at the top and through a full
// scroll. Screenshots of the three views and both menus are written to
// node_modules/.stacki-test/asset-views-chromium/. The probe is cut into five jobs run side by side, one
// Electron process each (a probe mostly waits for drawn frames): the main run, and the grid's long scroll and List -
// Small's, each in two consecutive ranges of steps. Each step is logged with the seconds since its job began.
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { runElectronProbesTogether } = require('../../helpers/electronProbe.js');
const { repoPath } = require('../../helpers/sources.js');

const PANE = { width: 260, height: 700 };
const BIG_COUNT = 5000;
// The two long scrolls. Grid steps 2,400 px a time; List - Small draws all 5,000 files one per row and steps four
// times as far (b30d098f). Each scroll is split into SCROLL_PARTS consecutive ranges, one Electron process each.
const SCROLL_STEP_PX = { grid: 2400, compact: 9600 };
const SCROLL_PARTS = 2;
// 65 leaves the same remainder as 5,000 by 7 (the fixture's kinds), so both lists start with the same kinds of tile.
const BASELINE_COUNT = 65;
const LONG_NAME = 'lumos-placeholder-landscape-wide.webp';
const DIMENSIONS = { widthPx: 1920, heightPx: 1080 };
const HERO_SIZE_BYTES = 7680;

// The fixture: files in src/assets/images (where the panel opens), one subfolder holding three files,
// modified times all distinct so Newest first has one answer, and names chosen so A to Z differs from it.
function fixture(directory, count) {
  const pictures = ['#e5484d', '#30a46c', '#0090ff', '#f76b15', '#8e4ec6', '#ffc53d'].map((colour, index) => {
    const file = path.join(directory, `picture-${index}.svg`);
    const wide = index % 2 === 0;
    fs.writeFileSync(
      file,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${wide ? 160 : 90} ${wide ? 90 : 160}"><rect width="100%" height="100%" fill="${colour}"/><circle cx="50%" cy="50%" r="20" fill="#fff" fill-opacity="0.6"/></svg>`,
    );
    return file;
  });
  const folder = (rel, isRoot) => ({
    rel,
    name: rel.split('/').at(-1),
    parent: rel.split('/').slice(0, -1).join('/'),
    root: rel.split('/')[0],
    isDir: true,
    ...(isRoot ? { isRoot: true } : {}),
  });
  const entries = [
    folder('public', true),
    folder('src', true),
    folder('src/assets'),
    folder('src/assets/images'),
    folder('src/assets/images/zebra-icons'),
    folder('src/assets/images/backgrounds'),
  ];
  const extensions = ['png', 'svg', 'webp', 'jpg', 'mp4', 'woff2', 'pdf'];
  const dimensions = {};
  for (let index = 0; index < count; index += 1) {
    const extension = extensions[index % extensions.length];
    const name = index === count - 1 ? LONG_NAME : `asset-${String((index * 7919) % count).padStart(4, '0')}-${index}.${extension}`;
    const rel = `src/assets/images/${name}`;
    entries.push({
      rel,
      name,
      parent: 'src/assets/images',
      root: 'src',
      isDir: false,
      abs: pictures[index % pictures.length],
      size: index === count - 1 ? HERO_SIZE_BYTES : 1000 + index,
      modifiedMs: 1_700_000_000_000 + index * 1000,
    });
    dimensions[rel] = index === count - 1 ? DIMENSIONS : { widthPx: 160 + index, heightPx: 90 };
  }
  for (const name of ['wave.svg', 'grain.png', 'dots.svg']) {
    const rel = `src/assets/images/backgrounds/${name}`;
    entries.push({ rel, name, parent: 'src/assets/images/backgrounds', root: 'src', isDir: false, abs: pictures[0], size: 100, modifiedMs: 1_600_000_000_000 });
    dimensions[rel] = { widthPx: 160, heightPx: 90 };
  }
  return { listing: { entries, missing: false }, dimensions };
}

// The import paths are JSON-quoted: a Windows path's `\` inside a plain quoted string is an escape.
const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import AssetsPanel from ${JSON.stringify(repoPath('src/features/assets/AssetsPanel.tsx'))};

const params = new URLSearchParams(location.search);
const project = params.get('project');
const count = params.get('count');
window.dimensionReads = [];
window.opened = [];
window.itemClassesSeen = [];
let fixture;
window.avb = {
  mediaConnections: async () => ({ encryption: 'available', connections: [] }),
  listAssets: async () => {
    fixture = fixture || (await (await fetch('/fixture-' + count + '.json')).json());
    return fixture.listing;
  },
  onAssetsChanged: () => () => {},
  getFilePath: () => '',
  assetDimensions: async ({ rel }) => {
    window.dimensionReads.push(rel);
    const size = fixture.dimensions[rel];
    return { dims: size === undefined ? undefined : { w: size.widthPx, h: size.heightPx } };
  },
};
// Every class the item list has ever had, from the first frame it exists: a remembered view must be
// the first one drawn, never the default first.
new MutationObserver(() => {
  const items = document.querySelector('.asset-items');
  if (items && window.itemClassesSeen.at(-1) !== items.className) {
    window.itemClassesSeen.push(items.className);
  }
}).observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
// Bounded by the clock as well as by frames: a hidden window on a CI runner can draw a frame a second
// or less, and 600 frames then outlasted the probe's 240 s bound (Check on 010980b8, Linux and Windows).
// A timer ticks beside the frames, so the wait ends within 15 s however slowly the window draws.
window.until = (condition, framesMax = 600) =>
  new Promise((resolve) => {
    const deadlineMs = performance.now() + 15000;
    let frames = 0;
    let done = false;
    // Only a drawn frame counts against framesMax (callers time hover delays in frames); the timer
    // only re-checks the condition and the clock.
    const check = () => {
      let value;
      try { value = condition(); } catch { value = undefined; }
      if (value) { done = true; resolve(value); return true; }
      if (performance.now() > deadlineMs) { done = true; resolve(false); return true; }
      return false;
    };
    const frame = () => {
      if (done || check()) { return; }
      frames += 1;
      if (frames > framesMax) { done = true; resolve(false); return; }
      requestAnimationFrame(frame);
    };
    const timer = setInterval(() => { if (done) { clearInterval(timer); return; } check(); }, 50);
    frame();
  });
createRoot(document.getElementById('root')).render(
  React.createElement(AssetsPanel, { project: { path: project }, showToast: () => {}, onOpenFile: (file) => window.opened.push(file.rel) }),
);
`;

// Page-side checks, kept as one script the probe calls into by name.
const STEPS = `
window.steps = (() => {
  const scroller = () => document.querySelector('.asset-body');
  const tiles = () => [...document.querySelectorAll('.asset-items .asset-tile')];
  const names = () => tiles().map((tile) => tile.querySelector('.asset-name').textContent);
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const click = (element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const key = (element, name) => element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  const focusedIndex = () => Number(document.activeElement && document.activeElement.getAttribute('data-asset-index'));
  const menuRows = () => [...document.querySelectorAll('[role="menu"] .menu-row')].map((row) => ({ label: row.querySelector('.menu-label').textContent, checked: row.getAttribute('aria-checked'), checkDrawn: row.querySelector('.menu-check svg') !== null, checkLast: row.lastElementChild && row.lastElementChild.classList.contains('menu-end') }));
  const nodes = () => document.querySelectorAll('#root *').length;
  const openMenuRows = () => document.querySelectorAll('[role="menu"] .menu-row');
  async function openMenu(selector, label) {
    await window.until(() => openMenuRows().length === 0);
    click(document.querySelector(selector));
    await window.until(() => document.querySelector('[role="menu"][aria-label="' + label + '"] .menu-row'));
    return menuRows();
  }
  // Clicks a row and reads the panel in the very next animation frame.
  async function chooseInNextFrame(label) {
    const row = [...document.querySelectorAll('[role="menu"] .menu-row')].find((candidate) => candidate.querySelector('.menu-label').textContent === label);
    if (!row) { return { found: false }; }
    const next = new Promise((resolve) => requestAnimationFrame(() => resolve({
      found: true,
      itemsClass: document.querySelector('.asset-items').className,
      sortLabel: document.querySelector('.asset-footer-sort-label').textContent,
      viewLabel: document.querySelector('.asset-footer-view').getAttribute('aria-label'),
      firstNames: names().slice(0, 4),
      menuOpen: document.querySelector('[role="menu"] .menu-row') !== null,
    })));
    click(row);
    const result = await next;
    // The menu fades out after the choice; the next step waits until it has gone.
    return { ...result, closed: Boolean(await window.until(() => openMenuRows().length === 0)) };
  }
  return {
    async ready(view) {
      return Boolean(await window.until(() => tiles().length > 0 && document.querySelector('.asset-items-' + view)));
    },
    measure() {
      const window_ = document.querySelector('.asset-items-window');
      return {
        nodes: nodes(),
        tiles: tiles().length,
        setSize: Number(tiles()[0] && tiles()[0].getAttribute('aria-setsize')),
        columns: getComputedStyle(window_).gridTemplateColumns.split(' ').length,
        listWidth: document.querySelector('.asset-items').clientWidth,
        firstNames: names().slice(0, 6),
        folders: [...document.querySelectorAll('.asset-folder-name')].map((name) => name.textContent),
        foldersBeforeItems: (() => {
          const folder = document.querySelector('.asset-folder');
          const items = document.querySelector('.asset-items');
          return Boolean(folder && items && folder.compareDocumentPosition(items) & Node.DOCUMENT_POSITION_FOLLOWING);
        })(),
      };
    },
    // Every tile has left its skeleton and every picture drawn has loaded: the resting state of a folder.
    loaded: () => window.until(() => document.querySelector('.asset-items .ui-skeleton') === null && [...document.querySelectorAll('.asset-items img')].every((image) => image.complete)),
    ellipsis(name) {
      const tile = tiles().find((candidate) => candidate.querySelector('.asset-name').textContent === name);
      if (!tile) { return { found: false }; }
      const label = tile.querySelector('.asset-name');
      const head = label.querySelector('.asset-name-head');
      const tail = label.querySelector('.asset-name-tail');
      return { found: true, title: label.getAttribute('title'), text: label.textContent, headCut: head.scrollWidth > head.clientWidth, headOverflow: getComputedStyle(head).textOverflow, tail: tail.textContent, tailWhole: tail.scrollWidth <= tail.clientWidth + 1, oneLine: label.getBoundingClientRect().height <= 17 };
    },
    async resize(widthPx) {
      const before = getComputedStyle(document.querySelector('.asset-items-window')).gridTemplateColumns.split(' ').length;
      document.getElementById('root').style.width = widthPx + 'px';
      await window.until(() => getComputedStyle(document.querySelector('.asset-items-window')).gridTemplateColumns.split(' ').length !== before);
      return { columns: getComputedStyle(document.querySelector('.asset-items-window')).gridTemplateColumns.split(' ').length, listWidth: document.querySelector('.asset-items').clientWidth };
    },
    // Scrolls in steps of stepPx, two frames each, and records what each step drew. Part 'part' of 'parts' covers
    // that share of the steps, in order; parts 0 to parts - 1 together are the whole scroll from top to bottom.
    async scrollThrough(stepPx, part, parts) {
      const box = scroller();
      const frames = [];
      box.scrollTop = 0;
      await frame();
      // The step at which the original, single scroll stopped: the first whose position reaches the bottom.
      const stepsTotal = Math.max(1, Math.ceil((box.scrollHeight - box.clientHeight - 1) / stepPx));
      const firstStep = Math.floor((part * stepsTotal) / parts) + 1;
      const lastStep = Math.floor(((part + 1) * stepsTotal) / parts);
      // A bound on the scroll, as on every loop: more steps than this is a layout gone wrong, not a longer list.
      if (stepsTotal > 2000) { return frames; }
      box.scrollTop = Math.min(box.scrollHeight, (firstStep - 1) * stepPx);
      await frame();
      for (let step = firstStep; step <= lastStep; step += 1) {
        box.scrollTop = Math.min(box.scrollHeight, step * stepPx);
        await frame();
        await frame();
        const viewportTop = box.getBoundingClientRect().top;
        const viewportBottom = viewportTop + box.clientHeight;
        const drawn = tiles();
        const visible = drawn.filter((tile) => { const r = tile.getBoundingClientRect(); return r.bottom > viewportTop && r.top < viewportBottom; });
        const firstDrawn = drawn[0] ? drawn[0].getBoundingClientRect().top : Infinity;
        const lastDrawn = drawn.at(-1) ? drawn.at(-1).getBoundingClientRect().bottom : -Infinity;
        const list = document.querySelector('.asset-items').getBoundingClientRect();
        frames.push({ nodes: nodes(), tiles: drawn.length, visible: visible.length, coversTop: firstDrawn <= Math.max(viewportTop, list.top) + 1, coversBottom: lastDrawn >= Math.min(viewportBottom, list.bottom) - 1 - 120 });
      }
      box.scrollTop = 0;
      await window.until(() => tiles()[0] && tiles()[0].getAttribute('data-asset-index') === '0');
      return frames;
    },
    async keys(columns) {
      const first = tiles()[0];
      first.focus();
      const moves = [];
      for (const [name, expected] of [['ArrowRight', 1], ['ArrowDown', 1 + columns], ['ArrowLeft', columns], ['ArrowUp', 0], ['End', ${BIG_COUNT - 1}], ['Home', 0]]) {
        key(document.activeElement, name);
        const landed = await window.until(() => focusedIndex() === expected);
        // The list scrolls the focused tile into view a frame or more after the focus moves (Home on the
        // macOS runner read it before the scroll, Check on 010980b8): wait for it, bounded.
        const inView = () => {
          const box = scroller().getBoundingClientRect();
          const rect = document.activeElement.getBoundingClientRect();
          return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
        };
        await window.until(() => focusedIndex() === expected && inView());
        moves.push({ name, expected, landed: Boolean(landed), index: focusedIndex(), inView: inView(), tabbable: tiles().filter((tile) => tile.tabIndex === 0).length });
      }
      return moves;
    },
    drag() {
      const tile = tiles()[0];
      const transfer = new DataTransfer();
      tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      return { draggable: tile.draggable, rel: transfer.getData('avb/asset'), expected: 'src/assets/images/' + tile.querySelector('.asset-name').textContent };
    },
    openViewMenu: () => openMenu('.asset-footer-view', 'Asset view'),
    openSortMenu: () => openMenu('.asset-footer-sort', 'Sort assets'),
    chooseInNextFrame,
    async detail(name) {
      const tile = await window.until(() => tiles().find((candidate) => candidate.querySelector('.asset-name').textContent === name));
      if (!tile) { return { found: false }; }
      const line = tile.querySelector('.asset-detail');
      const heightBefore = line.getBoundingClientRect().height;
      const textBefore = line.textContent;
      await window.until(() => /x/.test(tile.querySelector('.asset-detail').textContent));
      return { found: true, textBefore, heightBefore, text: tile.querySelector('.asset-detail').textContent, heightAfter: tile.querySelector('.asset-detail').getBoundingClientRect().height, reads: window.dimensionReads.length, drawn: tiles().length, kinds: tiles().slice(0, 7).map((t) => t.querySelector('.asset-detail').textContent) };
    },
    async folderAndBack() {
      click(document.querySelector('.asset-folder'));
      const inside = await window.until(() => names().length === 3 && names());
      click([...document.querySelectorAll('.asset-crumbs .crumb')].at(-2));
      const back = await window.until(() => names().length > 3 && document.querySelector('.asset-folder'));
      return { inside: inside || names(), back: Boolean(back), view: document.querySelector('.asset-items').className };
    },
    async select() {
      click(document.querySelector('.asset-select-link'));
      const selecting = await window.until(() => document.querySelector('.asset-items .asset-selectable'));
      const tile = document.querySelector('.asset-items .asset-selectable');
      tile.focus();
      key(tile, ' ');
      const ticked = await window.until(() => tile.querySelector('input').checked);
      const view = document.querySelector('.asset-items').className;
      const cancel = [...document.querySelectorAll('.asset-batch-actions button')].find((button) => button.textContent === 'Cancel');
      click(cancel);
      await window.until(() => !document.querySelector('.asset-items .asset-selectable'));
      return { selecting: Boolean(selecting), ticked: Boolean(ticked), view, selectableClass: tile.className };
    },
    seen: () => window.itemClassesSeen,
    // Every animation (a menu's entrance) has finished, so a screenshot shows the resting state.
    settled: () =>
      window.until(
        () =>
          document.querySelector('[data-popup-phase="opening"], [data-popup-phase="closing"]') === null &&
          [...document.querySelectorAll('[role="menu"]')].every((menu) => getComputedStyle(menu).opacity === '1') &&
          document.getAnimations().every((animation) => animation.playState !== 'running'),
      ),
  };
})();
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#111}' +
  `#root{position:relative;width:${PANE.width}px;height:${PANE.height}px;display:flex;flex-direction:column;overflow:hidden;background:var(--bg-panel)}</style></head>` +
  '<body><div id="root"></div><script src="/harness.js"></script><script src="/steps.js"></script></body></html>';

const PROBE = (directory, job) => `
const { app, BrowserWindow, protocol, session } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
protocol.registerSchemesAsPrivileged([{ scheme: 'stacki-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  // A fresh in-memory partition per run, so remembered choices start empty; the handler is the
  // partition's own, as Desktop's is its default session's.
  const partition = 'asset-views-' + process.pid;
  // As Desktop's handler does: the path is the URL's, one encoded segment at a time.
  session.fromPartition(partition).protocol.handle('stacki-asset', (request) => {
    let file = decodeURIComponent(new URL(request.url).pathname);
    if (process.platform === 'win32') { file = file.replace(/^[/]/, ''); }
    file = path.resolve(file);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { return new Response('', { status: 404 }); }
    return new Response(fs.readFileSync(file), { headers: { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' } });
  });
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 520, height: ${PANE.height}, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, partition } });
  // Each step is logged as it starts, so a probe that runs out of time says where it was.
  const startedAt = Date.now();
  const host = (code) => { console.log('STEP +' + Math.round((Date.now() - startedAt) / 1000) + 's ' + code.slice(0, 80).replace(/\\s+/g, ' ')); return win.webContents.executeJavaScript(code); };
  const shot = async (name) => fs.writeFileSync(path.join(DIRECTORY, name + '.png'), (await win.webContents.capturePage({ x: 0, y: 0, width: ${PANE.width}, height: ${PANE.height} })).toPNG());
  const open = async (count, project, view) => {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/?count=' + count + '&project=' + encodeURIComponent(project));
    return host('window.steps.ready(' + JSON.stringify(view) + ')');
  };
  const output = { error: undefined };
  const job = ${JSON.stringify(job)};
  try {
    if (job.kind === 'scroll') {
      // One range of one long scroll, over the 5,000-file folder in the view under test.
      output.scrollReady = await open(${BIG_COUNT}, '/big', 'grid');
      await host('window.steps.loaded()');
      if (job.view === 'compact') {
        await host('window.steps.openViewMenu()');
        await host('window.steps.chooseInNextFrame("List - Small")');
        await host('window.steps.loaded()');
      }
      output.scroll = await host('window.steps.scrollThrough(' + job.stepPx + ', ' + job.part + ', ' + job.parts + ')');
      console.log('RESULT ' + JSON.stringify(output));
      win.destroy(); server.close(); app.quit();
      return;
    }
    output.baselineReady = await open(${BASELINE_COUNT}, '/baseline', 'grid');
    // Both folders are measured once their pictures have loaded: a tile draws a skeleton until its picture is
    // ready, and a loaded one has more nodes. The 60-file baseline was read before its pictures had (520 nodes
    // against the 5,000-file folder's 532, Check on 5893bd58, Windows) while the larger folder was read after;
    // the wait there only saw the three pictures that had drawn, and was true at once.
    await host('window.steps.loaded()');
    output.baseline = await host('window.steps.measure()');
    output.baselineScroll = await host('window.steps.scrollThrough(400, 0, 1)');
    output.bigReady = await open(${BIG_COUNT}, '/big', 'grid');
    await host('window.steps.loaded()');
    output.big = await host('window.steps.measure()');
    output.ellipsis = await host('window.steps.ellipsis(${JSON.stringify(LONG_NAME)})');
    output.drag = await host('window.steps.drag()');
    await shot('grid');
    output.keys = { grid: await host('window.steps.keys(' + output.big.columns + ')') };
    output.folder = { grid: await host('window.steps.folderAndBack()') };
    output.select = { grid: await host('window.steps.select()') };
    output.viewMenu = await host('window.steps.openViewMenu()');
    await host('window.steps.settled()');
    await shot('view-menu');
    output.toList = await host('window.steps.chooseInNextFrame("List")');
    output.detail = await host('window.steps.detail(${JSON.stringify(LONG_NAME)})');
    await host('window.steps.loaded()');
    await shot('list');
    output.keys.list = await host('window.steps.keys(1)');
    output.folder.list = await host('window.steps.folderAndBack()');
    output.select.list = await host('window.steps.select()');
    output.sortMenu = await host('window.steps.openSortMenu()');
    await host('window.steps.settled()');
    await shot('sort-menu');
    output.toAlphabetical = await host('window.steps.chooseInNextFrame("Alphabetical (A-Z)")');
    await host('window.steps.openViewMenu()');
    output.toCompact = await host('window.steps.chooseInNextFrame("List - Small")');
    await host('window.steps.loaded()');
    await shot('compact');
    // The long scrolls of the grid and of List - Small run in their own probes (see JOBS).
    output.keys.compact = await host('window.steps.keys(1)');
    output.folder.compact = await host('window.steps.folderAndBack()');
    output.select.compact = await host('window.steps.select()');
    output.reopenReady = await open(${BIG_COUNT}, '/big', 'compact');
    output.reopen = { seen: await host('window.steps.seen()'), measure: await host('window.steps.measure()'), sortLabel: await host('document.querySelector(".asset-footer-sort-label").textContent') };
    output.otherReady = await open(${BASELINE_COUNT}, '/other', 'grid');
    output.other = { seen: await host('window.steps.seen()'), sortLabel: await host('document.querySelector(".asset-footer-sort-label").textContent') };
    output.resized = await host('window.steps.resize(420)');
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

// The checks over what the probe read, as failure lines.
function check(output, big) {
  const failures = [];
  const expect = (what, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? what : `${what} (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`);
    }
  };
  for (const ready of ['baselineReady', 'bigReady', 'reopenReady', 'otherReady', ...Object.keys(output).filter((key) => /ScrollReady\d+$/.test(key))]) {
    expect(`${ready}: the panel drew its files`, output[ready] === true, output[ready]);
  }
  if (output.big === undefined || output.baseline === undefined) {
    return [...failures, 'the panel was measured'];
  }
  // Newest first by default: the fixture's newest is its last file.
  const files = big.listing.entries.filter((entry) => !entry.isDir && entry.parent === 'src/assets/images');
  const newest = [...files].sort((left, right) => right.modifiedMs - left.modifiedMs).map((entry) => entry.name);
  expect('grid: Newest first is the default order', JSON.stringify(output.big.firstNames) === JSON.stringify(newest.slice(0, 6)), output.big.firstNames);
  expect('grid: three columns at the default panel width', output.big.columns === 3, output.big.columns);
  expect('grid: the list knows every file', output.big.setSize === BIG_COUNT, output.big.setSize);
  expect('folders come first, A to Z', JSON.stringify(output.big.folders) === JSON.stringify(['backgrounds', 'zebra-icons']), output.big.folders);
  expect('folders are drawn above the files', output.big.foldersBeforeItems === true);
  // Bounded DOM: 5,000 files draw what 60 do (both fill the pane), at the top and through a whole scroll.
  expect('5,000 files draw no more tiles than 60', output.big.tiles <= output.baseline.tiles, `${output.big.tiles} vs ${output.baseline.tiles}`);
  expect('5,000 files draw no more nodes than 60', output.big.nodes <= output.baseline.nodes + 4, `${output.big.nodes} vs ${output.baseline.nodes}`);
  // Through a scroll the kinds of tile on screen change (a picture is fewer nodes than a badge), so the
  // node bound allows a quarter more than the 65-file baseline ever drew. The tile bound allows one more
  // grid row (where the rows fall against the viewport's edges varies by one), and List - Small, whose
  // rows are shorter than the baseline grid's, twice the baseline's tiles.
  const scrollNodesMax = Math.ceil(Math.max(...output.baselineScroll.map((frame) => frame.nodes), output.baseline.nodes) * 1.25);
  const scrollTilesMax = Math.max(...output.baselineScroll.map((frame) => frame.tiles), output.baseline.tiles);
  for (const [name, frames] of [
    ['grid', output.bigScroll],
    ['compact', output.compactScroll],
  ]) {
    expect(`${name}: the scroll went through many frames`, Array.isArray(frames) && frames.length > 20, frames && frames.length);
    for (const [index, frame] of (frames || []).entries()) {
      expect(`${name} frame ${index}: tiles cover the top of the viewport`, frame.coversTop, frame);
      expect(`${name} frame ${index}: tiles cover the bottom of the viewport`, frame.coversBottom, frame);
      expect(`${name} frame ${index}: files are visible`, frame.visible > 0, frame);
      expect(`${name} frame ${index}: the DOM stays bounded`, frame.nodes <= scrollNodesMax, `${frame.nodes} > ${scrollNodesMax}`);
      expect(
        `${name} frame ${index}: the drawn tiles stay bounded`,
        frame.tiles <= (name === 'compact' ? 2 * scrollTilesMax : scrollTilesMax + output.big.columns),
        `${frame.tiles} > ${scrollTilesMax}`,
      );
    }
  }
  expect('a long name is cut in the middle', output.ellipsis.headCut === true && output.ellipsis.headOverflow === 'ellipsis', output.ellipsis);
  expect('the cut keeps the end of the name whole', output.ellipsis.tail === '.webp' && output.ellipsis.tailWhole === true, output.ellipsis);
  expect('the full name is the tooltip and the text', output.ellipsis.title === LONG_NAME && output.ellipsis.text === LONG_NAME, output.ellipsis);
  expect('the name is one line', output.ellipsis.oneLine === true, output.ellipsis);
  expect('a drag carries the asset path', output.drag.draggable === true && output.drag.rel === output.drag.expected, output.drag);
  // Menus: the chosen row is checked, its check ends the row, and a choice applies in the next frame.
  const views = ['Grid', 'List', 'List - Small'];
  expect('the view menu lists the three views', JSON.stringify((output.viewMenu || []).map((row) => row.label)) === JSON.stringify(views), output.viewMenu);
  expect(
    'the view menu checks Grid only',
    (output.viewMenu || []).every((row) => (row.label === 'Grid') === (row.checked === 'true') && row.checkDrawn === (row.label === 'Grid')),
    output.viewMenu,
  );
  expect(
    'the view menu check ends the row',
    (output.viewMenu || []).every((row) => row.checkLast),
    output.viewMenu,
  );
  const sorts = ['Newest first', 'Oldest first', 'Alphabetical (A-Z)', 'Alphabetical (Z-A)', 'Largest first', 'Smallest first'];
  expect('the sort menu lists every sort', JSON.stringify((output.sortMenu || []).map((row) => row.label)) === JSON.stringify(sorts), output.sortMenu);
  expect(
    'the sort menu checks Newest first only',
    (output.sortMenu || []).every((row) => (row.label === 'Newest first') === (row.checked === 'true')),
    output.sortMenu,
  );
  expect('List applies in the next frame', output.toList.found && /asset-items-list/.test(output.toList.itemsClass) && output.toList.closed, output.toList);
  expect('the view button names List', output.toList.viewLabel === 'View: List', output.toList.viewLabel);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const alphabetical = [...files].sort((left, right) => collator.compare(left.name, right.name)).map((entry) => entry.name);
  expect(
    'A to Z applies in the next frame',
    JSON.stringify(output.toAlphabetical.firstNames) === JSON.stringify(alphabetical.slice(0, 4)),
    output.toAlphabetical,
  );
  expect('the sort button names A to Z', output.toAlphabetical.sortLabel === 'Alphabetical (A-Z)', output.toAlphabetical.sortLabel);
  expect('List - Small applies in the next frame', /asset-items-compact/.test(output.toCompact.itemsClass), output.toCompact);
  // The List view's second line: size at once, dimensions when read, the height never moving.
  expect(
    'the second line shows the size before the dimensions',
    /^… • 7\.7 kB$/.test(output.detail.textBefore) || /^1920 x 1080 • 7\.7 kB$/.test(output.detail.textBefore),
    output.detail,
  );
  expect('the second line reads dimensions and size', output.detail.text === '1920 x 1080 • 7.7 kB', output.detail.text);
  expect('the second line keeps its height', output.detail.heightBefore > 0 && output.detail.heightBefore === output.detail.heightAfter, output.detail);
  expect('dimensions are read only for drawn rows', output.detail.reads > 0 && output.detail.reads <= output.detail.drawn, output.detail);
  expect(
    'a video, font or document line names its kind',
    ['Video', 'Font', 'File'].every((kind) => output.detail.kinds.some((text) => text.startsWith(`${kind} • `))),
    output.detail.kinds,
  );
  // Folders, selection and the keyboard in every view.
  for (const view of ['grid', 'list', 'compact']) {
    const folder = output.folder[view];
    expect(
      `${view}: a folder opens to its files`,
      JSON.stringify(folder && folder.inside) !== 'false' && Array.isArray(folder.inside) && folder.inside.length === 3,
      folder,
    );
    expect(`${view}: the trail leads back`, folder && folder.back === true && folder.view.includes(`asset-items-${view}`), folder);
    const select = output.select[view];
    expect(`${view}: Select draws tickable tiles in the view`, select && select.selecting && select.view.includes(`asset-items-${view}`), select);
    expect(`${view}: Space ticks the focused tile`, select && select.ticked === true, select);
    for (const move of output.keys[view] || []) {
      expect(`${view}: ${move.name} lands on ${move.expected}`, move.landed && move.index === move.expected, move);
      expect(`${view}: ${move.name} keeps the focus in view`, move.inView, move);
      expect(`${view}: one tile is in the tab order`, move.tabbable === 1, move);
    }
  }
  // Remembered per project, before the first frame; another project keeps the defaults.
  expect(
    'a reopened project draws its remembered view first and only',
    JSON.stringify(output.reopen.seen.map((name) => name.includes('asset-items-compact'))) === '[true]',
    output.reopen.seen,
  );
  expect('a reopened project keeps its sort', output.reopen.sortLabel === 'Alphabetical (A-Z)', output.reopen.sortLabel);
  expect(
    'another project opens on the defaults',
    output.other.seen.every((name) => name.includes('asset-items-grid')) && output.other.sortLabel === 'Newest first',
    output.other,
  );
  const expectedColumns = Math.floor((output.resized.listWidth + 8) / (72 + 8));
  expect('a wider panel holds more columns', output.resized.columns > 3 && output.resized.columns === expectedColumns, output.resized);
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
    console.log('asset-views-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/asset-views-chromium');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const big = fixture(directory, BIG_COUNT);
  fs.writeFileSync(path.join(directory, `fixture-${BIG_COUNT}.json`), JSON.stringify(big));
  fs.writeFileSync(path.join(directory, `fixture-${BASELINE_COUNT}.json`), JSON.stringify(fixture(directory, BASELINE_COUNT)));
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
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // The probe is cut into jobs run side by side, one Electron process each: a probe spends its time waiting for a
  // hidden window to draw frames, which a CI runner draws slowly. In one process the grid's 69 steps and List -
  // Small's 31, two frames each, outlasted the 240 s bound on the Linux and Windows runners (Checks on b6a4a679
  // and 5893bd58); cut into ranges, each job takes the longest range, not the sum. Every step of every scroll
  // still runs and is still checked.
  const jobs = [{ kind: 'main' }];
  for (const [view, stepPx] of Object.entries(SCROLL_STEP_PX)) {
    for (let part = 0; part < SCROLL_PARTS; part += 1) {
      jobs.push({ kind: 'scroll', view, stepPx, part, parts: SCROLL_PARTS });
    }
  }
  const probes = jobs.map((job, index) => {
    const probe = path.join(directory, `probe-${index}.js`);
    fs.writeFileSync(probe, PROBE(directory, job));
    return [probe];
  });
  const runs = await runElectronProbesTogether(electronPath, probes, { env: environment });
  const failures = [];
  const outputs = [];
  for (const [index, run] of runs.entries()) {
    const name = jobs[index].kind === 'main' ? 'main' : `${jobs[index].view} scroll ${jobs[index].part + 1} of ${jobs[index].parts}`;
    const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
    if (line === undefined) {
      const steps = (run.stdout || '').split('\n').filter((text) => text.startsWith('STEP '));
      failures.push(
        `the ${name} browser probe ran (${run.error ? String(run.error.message) : 'exit ' + String(run.status)}; last steps: ${steps.slice(-4).join(' | ')})\n    ${(run.stderr || run.stdout || '').slice(0, 800)}`,
      );
    } else {
      const result = JSON.parse(line.slice('RESULT '.length));
      if (result.error !== undefined) {
        failures.push(`the ${name} probe ran to the end\n    ${result.error}`);
      } else {
        outputs.push({ job: jobs[index], result });
      }
    }
  }
  if (failures.length === 0) {
    const output = outputs.find((entry) => entry.job.kind === 'main').result;
    for (const view of Object.keys(SCROLL_STEP_PX)) {
      const parts = outputs.filter((entry) => entry.job.kind === 'scroll' && entry.job.view === view);
      for (const entry of parts) {
        output[`${entry.job.view}ScrollReady${entry.job.part}`] = entry.result.scrollReady;
      }
      output[view === 'grid' ? 'bigScroll' : 'compactScroll'] = parts
        .sort((left, right) => left.job.part - right.job.part)
        .flatMap((entry) => entry.result.scroll);
    }
    failures.push(...check(output, big));
  }
  if (failures.length > 0) {
    console.error(`asset-views-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`asset-views-chromium: passed  [screenshots in ${directory}]`);
  }
})();
