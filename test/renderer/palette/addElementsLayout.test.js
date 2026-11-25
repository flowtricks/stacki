// Goal: the Add elements panel's tiles all look alike. Every English name fits ONE line at the panel's narrowest
// width (en/elements.ts gives long names a short tile name), every icon sits at the same offset from its tile's top,
// so icons line up across each row and the whole grid, and every tile is the same height. The grid's edges are the
// search box's edges, and each group header has its name at the grid's start edge and its chevron at the grid's end
// edge, in both reading directions.
// Method: bundle the real panel and the app's stylesheets with esbuild into one page, draw it in a `.panel.left` of
// 260px (the left panel's minimum) and 600px, left to right and right to left, in Electron's Chromium (only a real
// layout engine wraps text and places boxes), and read every tile's, icon's and name's box back. A word is broken
// in the middle when a range over it has rects on two lines.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { runElectronProbe } = require('../../helpers/electronProbe.js');

const CASES = [
  { width: 260, direction: 'ltr' },
  { width: 600, direction: 'ltr' },
  { width: 260, direction: 'rtl' },
];
// Whether a name fits one line depends on the font. The app's stack (-apple-system, Inter, Segoe UI) exists on
// macOS and Windows; a Linux runner has none of it and falls back to a wider face, so there the line checks (and
// the equal tile heights that follow from them) are not about our layout and are left out.
const FONT_CHECKS = process.platform !== 'linux';
// Sub-pixel layout rounds; boxes this close are at the same place.
const TOLERANCE_PX = 0.5;

// Runs in the page: waits for the tiles, then reads every tile's box, its icon's top, its name's line count and
// whether a word of the name was split across lines. Edges are read as start and end, so the same check holds
// right to left.
const READ_LAYOUT = `(async () => {
  await new Promise((resolve) => {
    const present = () => document.querySelector('.add-elements-tile') !== null;
    if (present()) {
      resolve();
      return;
    }
    const observer = new MutationObserver(() => {
      if (present()) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
  await document.fonts.ready;
  const rtl = document.documentElement.dir === 'rtl';
  const start = (box) => (rtl ? -box.right : box.left);
  const end = (box) => (rtl ? -box.left : box.right);
  const lineTops = (range) => new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  const tiles = [...document.querySelectorAll('.add-elements-tile')].map((tile) => {
    const box = tile.getBoundingClientRect();
    const label = tile.querySelector('.add-elements-label');
    const text = label.firstChild;
    const whole = document.createRange();
    whole.selectNodeContents(label);
    let brokenWord = false;
    let offset = 0;
    for (const word of text.textContent.split(' ')) {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + word.length);
      offset += word.length + 1;
      if (lineTops(range) > 1) {
        brokenWord = true;
      }
    }
    const labelBox = label.getBoundingClientRect();
    return {
      name: text.textContent,
      top: box.top,
      height: box.height,
      iconTop: tile.querySelector('.add-elements-icon').getBoundingClientRect().top,
      lines: lineTops(whole),
      brokenWord,
      overflows: labelBox.bottom > box.bottom + 0.5 || label.scrollWidth > label.clientWidth + 0.5,
    };
  });
  const grids = [...document.querySelectorAll('.add-elements-grid')].map((grid) => grid.getBoundingClientRect());
  const search = document.querySelector('.panel-search input').getBoundingClientRect();
  return {
    tiles,
    gridStart: Math.min(...grids.map(start)),
    gridEnd: Math.max(...grids.map(end)),
    searchStart: start(search),
    searchEnd: end(search),
    toggles: [...document.querySelectorAll('.add-elements-toggle')].map((toggle) => {
      const chevron = toggle.querySelector('.add-elements-chevron').getBoundingClientRect();
      const name = toggle.querySelector('.add-elements-group-name');
      return { name: name.textContent, chevronStart: start(chevron), chevronEnd: end(chevron), nameStart: start(name.getBoundingClientRect()) };
    }),
  };
})()`;

test('every English name fits one line, icons line up, tiles share one height, and group headers start at the edge', async (context) => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    context.skip('needs a Chromium');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/add-elements-layout');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(
    entry,
    `import { createRoot } from 'react-dom/client';
import AddElementsPanel from ${JSON.stringify(repoPath('src/features/palette/AddElementsPanel.tsx'))};
import ${JSON.stringify(repoPath('src/app/styles.css'))};
const parameters = new URLSearchParams(location.search);
document.documentElement.dir = parameters.get('dir') ?? 'ltr';
createRoot(document.getElementById('root')!).render(
  <div className="panel left" style={{ width: Number(parameters.get('w')), height: 900 }}>
    <AddElementsPanel allowSlot onInsert={() => undefined} onPickComponent={() => undefined} />
  </div>,
);
`,
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    outfile: path.join(directory, 'page.js'),
    jsx: 'automatic',
    nodePaths: [repoPath('node_modules')],
    loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    '<!doctype html><html lang="en" data-platform="darwin"><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body style="margin:0"><div id="root"></div><script src="page.js"></script></body></html>',
  );
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();
const READ = ${JSON.stringify(READ_LAYOUT)};
app.whenReady().then(async () => {
  const seen = [];
  for (const { width, direction } of ${JSON.stringify(CASES)}) {
    const window = new BrowserWindow({ width: 700, height: 950, show: false });
    await window.loadURL('file://' + ${JSON.stringify(path.join(directory, 'index.html'))} + '?w=' + width + '&dir=' + direction);
    seen.push({ width, direction, ...(await window.webContents.executeJavaScript(READ)) });
    window.destroy();
  }
  console.log(JSON.stringify({ seen }));
  app.exit(0);
});
`,
  );
  const run = runElectronProbe(electronPath, [probe]);
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  assert.ok(line, `the browser probe ran: ${(run.stderr || run.stdout || '').slice(0, 400)}`);
  const { seen } = JSON.parse(line);
  assert.equal(seen.length, CASES.length);
  for (const result of seen) {
    const where = `${result.width}px ${result.direction}`;
    assert.ok(result.tiles.length > 100, `every tile is drawn at ${where}`);
    const iconOffsets = result.tiles.map((tile) => tile.iconTop - tile.top);
    const heights = result.tiles.map((tile) => tile.height);
    assert.ok(Math.max(...iconOffsets) - Math.min(...iconOffsets) <= TOLERANCE_PX, `every icon sits at one offset in its tile at ${where}: ${iconOffsets}`);
    if (FONT_CHECKS) {
      assert.ok(Math.max(...heights) - Math.min(...heights) <= TOLERANCE_PX, `every tile is one height at ${where}: ${[...new Set(heights)]}`);
    }
    // Across a row: tiles that share a top share their icons' top.
    const rows = new Map();
    for (const tile of result.tiles) {
      const key = Math.round(tile.top);
      rows.set(key, [...(rows.get(key) ?? []), tile.iconTop]);
    }
    for (const [top, icons] of rows) {
      assert.ok(Math.max(...icons) - Math.min(...icons) <= TOLERANCE_PX, `the row at ${top} has its icons level at ${where}`);
    }
    for (const tile of result.tiles) {
      if (FONT_CHECKS) {
        assert.equal(tile.lines, 1, `${tile.name} fits one line at ${where}`);
        assert.equal(tile.brokenWord, false, `${tile.name} breaks no word in the middle at ${where}`);
      }
      assert.equal(tile.overflows, false, `${tile.name} stays inside its tile at ${where}`);
    }
    assert.ok(
      Math.abs(result.gridStart - result.searchStart) <= TOLERANCE_PX,
      `the grid starts where the search box starts at ${where}: ${JSON.stringify(result)}`.slice(0, 400),
    );
    assert.ok(Math.abs(result.gridEnd - result.searchEnd) <= TOLERANCE_PX, `the grid ends where the search box ends at ${where}`);
    // Group headers, HTML and Astro alike: the name at the grid's start edge, the chevron's far side on its end edge.
    assert.ok(result.toggles.length > 10, `every group has a header at ${where}`);
    for (const toggle of result.toggles) {
      assert.ok(Math.abs(toggle.nameStart - result.gridStart) <= 1, `${toggle.name} starts at the grid's edge at ${where}`);
      assert.ok(Math.abs(toggle.chevronEnd - result.gridEnd) <= 1, `${toggle.name}'s chevron ends at the grid's edge at ${where}`);
      assert.ok(toggle.chevronStart > toggle.nameStart, `${toggle.name}'s chevron comes after its name at ${where}`);
    }
  }
});
