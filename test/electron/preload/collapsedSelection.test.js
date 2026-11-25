// A node selected in the navigator is drawn on the canvas even when it has no size.
//
//   node test/electron/preload/collapsedSelection.test.js
//
// Goal: pin, through the shipped chain, the bug where an empty `div` (0px by 0px) selected from the navigator showed no
// outline and no name tag on the canvas. The chain is: the real preload bundle in the page frame measures the tracked path
// (collapsedRects), posts avb:rects, the real parser accepts it, and the real overlay (NodeOutlines, markerBox) draws it.
//
// Methodology: the preload is bundled fresh from source into a scratch folder, as scripts/build/bundleClients.ts bundles it,
// so a stale dist/ cannot hide a regression. An Electron window (Chromium's own layout) serves a Lumos-like page, a flex
// column ContentWrapper with an icon, heading, eyebrow, image, button and then an empty div, from a local server on
// 127.0.0.1, inside an iframe the preload runs in, under an overflow: hidden ancestor and a zero-height parent. The host
// page (test/helpers/collapsedOutlineHost.tsx) tracks the path as a navigator selection does: no hover, no canvas click. The
// outline and its tag are read back from the overlay's DOM, in the same pixels the user sees. Every wait is a bounded poll.
// Set COLLAPSED_SHOT to a file path to keep a screenshot.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const stamp = `<!--avb-d:${'a'.repeat(64)}:src/pages/index.astro-->`;
const marked = (nodePath, html) => `<!--avb-s:${nodePath}-->${html}<!--avb-e:${nodePath}-->`;
const lumos = (emptyDiv) =>
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;font:16px/1.4 sans-serif}</style></head><body>' +
  marked(
    '0',
    '<section style="overflow:hidden;height:300px"><div style="display:flex;flex-direction:column;align-items:center;gap:16px;padding:40px">' +
      marked('0.0', '<svg width="24" height="24"></svg>') +
      marked('0.1', '<h1>Heading</h1>') +
      marked('0.2', '<p>Eyebrow</p>') +
      marked('0.3', '<img alt="" width="80" height="40">') +
      marked('0.4', '<a href="#">Button</a>') +
      marked('0.5', emptyDiv) +
      '</div></section>',
  ) +
  stamp +
  '</body></html>';

const PAGES = {
  'collapsed-div': lumos('<div></div>'),
  'contents-div': lumos('<div style="display:contents"></div>'),
  'zero-height-parent': lumos('<div style="height:0;overflow:hidden"><div></div></div>'),
};

const PROBE = (directory) => `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
app.on('window-all-closed', () => {});
ipcMain.on('boot:read', (event) => { event.returnValue = undefined; });
const host = (page) => '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}#overlay{position:fixed;inset:0;pointer-events:none}#overlay>*{position:absolute}</style></head><body><iframe src="/pages/' + page + '.html#avb-design"></iframe><div id="overlay"></div><script src="/host.js"></script></body></html>';
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/host/')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(host(url.pathname.slice('/host/'.length)));
      return;
    }
    const file = path.join(DIRECTORY, path.normalize(url.pathname));
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const results = {};
  for (const name of ${JSON.stringify(Object.keys(PAGES))}) {
    // A window per page: each starts from a frame that has never been told what to track.
    const win = new BrowserWindow({ show: false, width: 900, height: 500, webPreferences: { preload: path.join(DIRECTORY, 'preload.js'), contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true } });
    await win.loadURL(origin + '/host/' + name + '?path=0.5');
    let answer;
    for (let attempt = 0; attempt < 100; attempt++) {
      answer = await win.webContents.executeJavaScript('(() => { const o = document.querySelector(".node-outline"); const t = o && o.querySelector(".node-outline-tag"); const b = o && o.getBoundingClientRect(); const g = t && t.getBoundingClientRect(); return { host: window.collapsedHost, outline: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : undefined, tag: g ? { w: g.width, h: g.height, text: t.textContent } : undefined, across: o ? { w: parseFloat(getComputedStyle(o, "::before").width) || 0, h: parseFloat(getComputedStyle(o, "::before").height) || 0 } : undefined, down: o ? { w: parseFloat(getComputedStyle(o, "::after").width) || 0, h: parseFloat(getComputedStyle(o, "::after").height) || 0 } : undefined, className: o ? o.className : undefined }; })()');
      if (answer.outline) { break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    results[name] = answer;
    if (process.env.COLLAPSED_SHOT && name === 'collapsed-div') {
      fs.writeFileSync(process.env.COLLAPSED_SHOT, (await win.webContents.capturePage()).toPNG());
    }
    win.destroy();
  }
  console.log('RESULT ' + JSON.stringify(results));
  app.exit(0);
});`;

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('collapsed-selection: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/collapsed-selection');
  fs.mkdirSync(path.join(directory, 'pages'), { recursive: true });
  esbuild.buildSync({
    entryPoints: [repoPath('electron/preload/preload.ts')],
    outfile: path.join(directory, 'preload.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: ['electron'],
    logLevel: 'silent',
    absWorkingDir: ROOT,
  });
  esbuild.buildSync({
    entryPoints: [repoPath('test/helpers/collapsedOutlineHost.tsx')],
    outfile: path.join(directory, 'host.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    logLevel: 'silent',
    absWorkingDir: ROOT,
  });
  fs.writeFileSync(
    path.join(directory, 'app.css'),
    ['src/features/style/tokens.css', 'src/app/styles.css'].map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n'),
  );
  for (const [name, html] of Object.entries(PAGES)) {
    fs.writeFileSync(path.join(directory, 'pages', `${name}.html`), html);
  }
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 2000));
  } else {
    const results = JSON.parse(line.slice('RESULT '.length));
    for (const name of Object.keys(PAGES)) {
      const seen = results[name];
      check(`${name}: the frame reported a box for the selected path`, seen.host.box !== undefined, JSON.stringify(seen));
      check(`${name}: an outline is drawn`, seen.outline !== undefined, JSON.stringify(seen));
      if (seen.outline) {
        check(`${name}: the outline keeps the real 0px width`, seen.outline.w < 1, JSON.stringify(seen));
        check(`${name}: the outline keeps the real 0px height`, seen.outline.h < 1, JSON.stringify(seen));
        check(`${name}: it is drawn as a crosshair, not a box`, seen.className.includes('is-point'), JSON.stringify(seen));
        check(`${name}: the arm across is a findable hairline`, seen.across.w >= 10 && seen.across.h <= 1, JSON.stringify(seen));
        check(`${name}: the arm down is a findable hairline`, seen.down.h >= 10 && seen.down.w <= 1, JSON.stringify(seen));
        check(`${name}: the outline is inside the frame`, seen.outline.x >= 0 && seen.outline.y >= 0, JSON.stringify(seen));
      }
      check(`${name}: its name tag is drawn`, seen.tag !== undefined && seen.tag.w > 0 && seen.tag.h > 0, JSON.stringify(seen));
      check(`${name}: its name tag says just div`, seen.tag !== undefined && seen.tag.text === 'div', JSON.stringify(seen));
    }
  }
  if (failures.length) {
    console.error(`collapsed-selection: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`collapsed-selection: ${checked} checks passed  [real preload, real layout]`);
  }
})();
