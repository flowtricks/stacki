// The canvas keeps the wheel; app overlay items keep only their clicks.
//
//   node test/renderer/apps/overlayPointer.test.js
//
// Goal: an app that draws over the canvas ("Analytics on canvas": a heat map,
// fold lines, "Seen by %" labels) must never stop the page from scrolling, and
// an app that captures canvas clicks (a comment app's pin mode) must not turn a
// click on its own pin into a new comment. Before this, an interactive label
// took the pointer across the whole element it was anchored to, so a label on
// a section covered the section, and a wheel there scrolled nothing.
//
// Method: a real Electron window, since only a browser hit-tests, scrolls and
// routes a wheel between a page and a frame. A host page served over localhost
// draws the real overlay view (AppOverlayView from AppOverlayLayer.tsx, with
// the app's own stylesheets, bundled by esbuild) over a canvas frame that runs
// the built preload, as the app does. Wheels and clicks are real input
// (`webContents.sendInputEvent`), aimed at:
//   - a heat map, which takes no pointer: the frame scrolls natively,
//   - an interactive, draggable box, the pill of an interactive label, an
//     interactive pin, and the drag surface a press puts over the layer: the
//     overlay hands the wheel to the frame (`avb:app-wheel`) and it scrolls,
//   - the element under an interactive label, away from its pill: the pointer
//     goes through to the frame,
// each from a known scroll position, with and without a capture on. With the
// capture on, a click on an interactive label (inside its 24px hit area but
// off the drawn pill) and on a pin sends `overlay.click` and no click reaches
// the frame, while a click on bare canvas still reaches the frame, so the
// capture would take it. Scrolling is read after it settles, within a bound,
// so a slow machine waits longer rather than failing.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const CANVAS = { width: 800, height: 600 };

// A tall page, marked as the serializer marks a real one, so the preload treats it as the canvas.
const FRAME_PAGE = `<!doctype html><html data-avb-p="0"><head><meta charset=utf-8>
<style>body { margin: 0; font: 14px sans-serif; } section { height: 900px; background: linear-gradient(#eee, #ccc); }</style>
</head><body data-avb-p="0.1">
<section data-avb-p="0.1.0">One</section><section data-avb-p="0.1.1">Two</section><section data-avb-p="0.1.2">Three</section><section data-avb-p="0.1.3">Four</section>
<script>
  // Every press and click the page hears, told to the host: what reaches the frame is what a capture takes.
  for (const type of ['pointerdown', 'click']) {
    addEventListener(type, () => parent.postMessage({ type: 'test:' + type }, '*'), true);
  }
</script>
</body></html>`;

// Where each item is drawn, in canvas pixels at zoom 1: rects the canvas would have measured.
const RECTS = {
  'p.heat': [{ x: 20, y: 20, w: 200, h: 150 }],
  'p.box': [{ x: 300, y: 20, w: 200, h: 150 }],
  'p.section': [{ x: 20, y: 250, w: 300, h: 200 }],
  'p.pinhost': [{ x: 600, y: 400, w: 100, h: 100 }],
  'p.dot': [{ x: 500, y: 300, w: 40, h: 40 }],
};

const ENTRY = `
  import React from 'react'
  import { flushSync } from 'react-dom'
  import { createRoot } from 'react-dom/client'
  import { AppOverlayView } from './src/features/apps/AppOverlayLayer'
  import { setCanvasFrame } from './src/editor/canvasQuery'
  import { parseOverlayItems } from './shared/properties/appsRpc'
  import './src/features/apps/apps.css'

  const items = parseOverlayItems([
    { kind: 'heat', id: 'heat', anchor: { nodeId: 'heat' }, columns: 2, rows: 1, values: [0.2, 0.9] },
    { kind: 'box', id: 'fold', anchor: { nodeId: 'box' }, color: '#f97316', interactive: true, draggable: true },
    { kind: 'label', id: 'seen', anchor: { nodeId: 'section' }, text: 'Seen by 40%', placement: 'center', interactive: true },
    { kind: 'label', id: 'dot', anchor: { nodeId: 'dot', at: { x: 0.5, y: 0.5 } }, text: '7', placement: 'center', interactive: true, cluster: false },
    { kind: 'pin', id: 'pin', anchor: { nodeId: 'pinhost', at: { x: 0, y: 0 } }, label: '3', interactive: true, draggable: true, cluster: false },
  ])
  const rects = ${JSON.stringify(RECTS)}
  const root = createRoot(document.getElementById('overlay'))
  window.clicked = []
  window.render = ({ capturing, held }) => {
    flushSync(() => root.render(
      <AppOverlayView
        overlays={new Map([['analytics', items]])}
        apps={new Map()}
        capture={capturing ? { appId: 'notes', appName: 'Notes', cursor: 'crosshair' } : undefined}
        held={held ? { appId: 'analytics', itemId: 'fold', phase: 'dragging' } : undefined}
        rects={rects}
        scale={1}
        pathFor={(nodeId) => 'p.' + nodeId}
        clickItem={(appId, itemId) => window.clicked.push(appId + ':' + itemId)}
      />,
    ))
    return true
  }
  // The presses and clicks that reached the canvas frame: there the capture would take them (canvas.click).
  window.frameClicks = []
  addEventListener('message', (event) => {
    if (event.data && (event.data.type === 'test:pointerdown' || event.data.type === 'test:click')) {
      window.frameClicks.push(event.data.type)
    }
  })
  window.attach = () => {
    const frame = document.getElementById('canvas').contentWindow
    setCanvasFrame(frame)
    // A frame the editor tracks paths in is a design canvas, as in the app.
    frame.postMessage({ type: 'avb:track', paths: ['0.1.0'], scope: '', focus: '', focusOcc: 0 }, '*')
    return true
  }
`;

function hostPage() {
  return `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css">
<style>
  body { margin: 0; background: #111; }
  #stage { position: absolute; left: 0; top: 0; width: ${CANVAS.width}px; height: ${CANVAS.height}px; }
  #canvas { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  /* The editor's overlay layer (previewViewport.css .preview-overlay-layer): over the frame, taking no pointer. */
  #overlay { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
</style>
<div id="stage"><iframe id="canvas" src="frame.html#avb-design"></iframe><div id="overlay"></div></div>
<script src="bundle.js"></script>`;
}

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('overlay-pointer: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/overlay-pointer');
  fs.mkdirSync(buildDirectory, { recursive: true });
  await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'tsx' },
    outfile: path.join(buildDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  const files = {
    '/host.html': ['text/html', hostPage()],
    '/frame.html': ['text/html', FRAME_PAGE],
    '/bundle.js': ['text/javascript', fs.readFileSync(path.join(buildDirectory, 'bundle.js'), 'utf8')],
    '/bundle.css': ['text/css', fs.readFileSync(path.join(buildDirectory, 'bundle.css'), 'utf8')],
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const file = files[url.pathname];
    if (file === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': `${file[0]}; charset=utf-8` });
    response.end(file[1]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const probe = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     app.whenReady().then(async () => {
       const win = new BrowserWindow({
         show: false, width: ${CANVAS.width}, height: ${CANVAS.height}, useContentSize: true,
         webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true },
       });
       const run = (code) => win.webContents.executeJavaScript(code);
       const out = { errors: [] };
       win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) out.errors.push(message); });
       try {
         await win.loadURL('http://127.0.0.1:${port}/host.html');
         for (let attempt = 0; attempt < 100; attempt += 1) {
           if (await run('!!document.getElementById("canvas").contentDocument?.querySelector("section")')) break;
           await sleep(50);
         }
         await run('window.attach()');
         const frameY = () => run('document.getElementById("canvas").contentWindow.scrollY');
         const scrollTo = (top) => run('document.getElementById("canvas").contentWindow.scrollTo({ top: ' + top + ', behavior: "instant" }); true');
         // Wheels at a point from a known place; reads where the frame settles, within a bound.
         const wheel = async (x, y) => {
           await scrollTo(1000);
           await sleep(50);
           const start = await frameY();
           win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
           for (let tick = 0; tick < 4; tick += 1) {
             win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120, canScroll: true });
             await sleep(16);
           }
           let last = start;
           let still = 0;
           for (let attempt = 0; attempt < 60 && still < 4; attempt += 1) {
             await sleep(50);
             const now = await frameY();
             still = now === last && now !== start ? still + 1 : 0;
             last = now;
           }
           return { start, end: last };
         };
         const click = async (x, y) => {
           win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
           win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
           win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
           await sleep(250);
         };
         const hit = (x, y) => run('(() => { const e = document.elementFromPoint(' + x + ', ' + y + '); return e ? (e.className || e.tagName) : "" })()');
         const surface = () => run('!!document.querySelector(".app-overlay-drag-surface")');

         out.wheel = {};
         for (const capturing of [false, true]) {
           await run('window.render(' + JSON.stringify({ capturing, held: false }) + ')');
           await sleep(100);
           const key = capturing ? 'capturing' : 'plain';
           out.wheel[key] = {
             heat: await wheel(120, 95),
             box: await wheel(400, 95),
             labelPill: await wheel(170, 350),
             underLabel: await wheel(60, 280),
             pin: await wheel(612, 388),
             dot: await wheel(520, 320),
           };
         }
         out.hits = { heat: await hit(120, 95), underLabel: await hit(60, 280), labelPill: await hit(170, 350), dotEdge: await hit(520, 330) };
         out.pillHeight = await run('document.querySelectorAll(".app-overlay-label")[1].getBoundingClientRect().height');
         out.chip = await run('getComputedStyle(document.querySelector(".app-capture-chip")).pointerEvents');
         out.pinCursor = await run('getComputedStyle(document.querySelector(".app-overlay-pin-badge")).cursor');

         // Clicks while the capture is on: the label's hit area off its pill, the pin, then bare canvas.
         await run('window.clicked = []; window.frameClicks = []; true');
         await scrollTo(0);
         await sleep(100);
         await click(520, 330);
         await click(612, 388);
         out.itemClicks = { clicked: await run('window.clicked'), frame: await run('window.frameClicks') };
         await click(700, 150);
         out.bareClick = { clicked: await run('window.clicked'), frame: await run('window.frameClicks') };

         // The drag surface: there while the store holds an item, taking wheels for the frame; gone when it lets go.
         await run('window.render({ capturing: true, held: true })');
         out.surfaceHeld = await surface();
         out.surfaceWheel = await wheel(700, 550);
         await run('window.render({ capturing: true, held: false })');
         out.surfaceReleased = await surface();
       } catch (error) {
         out.failure = String(error && error.stack || error);
       }
       console.log(JSON.stringify(out));
       app.quit();
     });`,
  );

  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve) => {
    const child = spawn(electronPath, [probe], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
  server.close();

  const line = result.stdout.split('\n').find((text) => text.trim().startsWith('{'));
  if (line === undefined) {
    check('the browser probe ran', false, (result.stderr || result.stdout || '').slice(0, 800));
  } else {
    const out = JSON.parse(line);
    check('the probe finished', out.failure === undefined, out.failure);
    check('the page logged no errors', out.errors.length === 0, out.errors.join('\n'));
    for (const [mode, cases] of Object.entries(out.wheel ?? {})) {
      for (const [where, moved] of Object.entries(cases)) {
        check(`a wheel over ${where} (${mode}) scrolls the canvas frame`, moved.end !== moved.start, JSON.stringify(moved));
      }
    }
    check('a heat map takes no pointer', out.hits?.heat === 'IFRAME', out.hits?.heat);
    check('a label takes no pointer across its element', out.hits?.underLabel === 'IFRAME', out.hits?.underLabel);
    check('a label takes the pointer on its pill', String(out.hits?.labelPill).includes('app-overlay-label'), out.hits?.labelPill);
    check('a small label is drawn under 24px tall', out.pillHeight < 20, String(out.pillHeight));
    check('and is clickable across 24px', String(out.hits?.dotEdge).includes('app-overlay-label'), out.hits?.dotEdge);
    check('the capture chip takes no pointer', out.chip === 'none', out.chip);
    check('an interactive pin shows the pointer during a capture', out.pinCursor === 'pointer', out.pinCursor);
    check(
      'with the capture on, a click on an interactive label and on a pin sends overlay.click',
      JSON.stringify(out.itemClicks?.clicked) === JSON.stringify(['analytics:dot']),
      JSON.stringify(out.itemClicks),
    );
    // The pin is draggable: its click goes through the drag store, which only a running app has; it must not reach the frame either.
    check('and no click reaches the canvas frame (no canvas.click)', out.itemClicks?.frame.length === 0, JSON.stringify(out.itemClicks));
    check(
      'a click on bare canvas still reaches the frame for the capture',
      JSON.stringify(out.bareClick?.frame) === JSON.stringify(['test:pointerdown', 'test:click']),
      JSON.stringify(out.bareClick),
    );
    check('the drag surface is mounted while an item is held', out.surfaceHeld === true);
    check('a wheel over the drag surface scrolls the frame', out.surfaceWheel?.end !== out.surfaceWheel?.start, JSON.stringify(out.surfaceWheel));
    check('the drag surface unmounts when the hold ends', out.surfaceReleased === false);
  }

  if (failures.length) {
    console.error(`overlay-pointer: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`overlay-pointer: ${checked} passed  [wheel reaches the canvas over every overlay item; items keep their clicks under a capture]`);
})();
