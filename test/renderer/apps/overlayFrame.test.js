// An app's overlay `frame` item fills its item, and setting the overlay again keeps its document.
//
//   node test/renderer/apps/overlayFrame.test.js
//
// Goal: a `frame` item (docs/apps.md, "Overlays" and "Messages to overlay frames") is drawn the
// size of its anchor, and an `overlay.set` that only moves or resizes it, or changes
// `interactive`, keeps the same document with its state and listeners: no reload, no flicker,
// no handshake to repeat. A new `path` loads that page in the same frame; a new `id` is a new
// frame. Before PR 96 the iframe kept the browser default of 300 × 150 whatever the anchor's size.
//
// Method: a real Electron window, since only a browser lays out a replaced element. A host page
// renders the real AppOverlayView with the real apps.css, and the probe serves the app's pages
// on the app scheme (stacki-app://), each of which names itself with a random id when it loads
// and again when asked. Checks:
//   - the iframe's box equals the item's box, for a rectangle larger than 300 × 150 in both axes,
//   - after a render with a moved, resized, interactive item: the same element, no `src` write
//     (a MutationObserver sees any, even of the same value, which would navigate), the new size,
//     and the same document answering,
//   - a new `path`: the same element, a new document from that page,
//   - a new `id`: a new element and a new document, the old element gone,
//   - the negative space: an item anchored to nothing draws no frame, and with the sizing rule
//     overridden the iframe falls back to 300 × 150, so the size check can fail.

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

const WINDOW = { width: 900, height: 700 };
const LAYER = { width: 800, height: 600 };
// Both larger than the 300 × 150 default, so neither axis passes by accident.
const FIRST = { x: 40, y: 30, w: 480, h: 260 };
const MOVED = { x: 120, y: 90, w: 520, h: 320 };

const ENTRY = `
  import React from 'react'
  import { flushSync } from 'react-dom'
  import { createRoot } from 'react-dom/client'
  import { AppOverlayView } from './src/features/apps/AppOverlayLayer'
  import { parseOverlayItems } from './shared/properties/appsRpc'
  import './src/app/styles.css'
  import './src/features/preview/previewViewport.css'
  import './src/features/apps/apps.css'

  const app = { manifest: { manifestVersion: 1, id: 'rotator', name: 'Rotator', version: '1.0.0', entry: 'index.html' }, lock: {} }
  const root = createRoot(document.getElementById('layer'))
  window.render = (spec) => {
    const items = parseOverlayItems([{ kind: 'frame', id: spec.id, anchor: { nodeId: spec.nodeId }, path: spec.path, interactive: spec.interactive }])
    flushSync(() => root.render(
      <AppOverlayView
        overlays={new Map([['rotator', items]])}
        apps={new Map([['rotator', app]])}
        capture={undefined}
        held={undefined}
        rects={spec.rects}
        scale={1}
        pathFor={(nodeId) => 'p.' + nodeId}
        clickItem={() => {}}
      />,
    ))
    return true
  }
`;

// Runs in the page: what each frame document says about itself, and the frame element's writes.
const PROBE_PAGE = `(() => {
  window.documents = [];
  window.answers = [];
  window.waiters = [];
  addEventListener('message', (event) => {
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.probe === undefined) return;
    (data.probe === 'hello' ? window.documents : window.answers).push(data);
    for (const waiter of window.waiters.splice(0)) waiter();
  });
  // Resolves once the list holds more than count entries; each message wakes it.
  window.until = (list, count) => new Promise((resolve) => {
    const test = () => (window[list].length > count ? resolve(window[list].at(-1)) : window.waiters.push(test));
    test();
  });
  window.frame = () => document.querySelector('.app-overlay-frame');
  window.box = (element) => { const r = element.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  window.watch = () => {
    // Counted in the callback: delivered records leave takeRecords() at the next microtask checkpoint.
    window.srcWrites = 0;
    window.writes = new MutationObserver((records) => { window.srcWrites += records.length; });
    window.writes.observe(window.frame(), { attributes: true, attributeFilter: ['src'] });
    window.watched = window.frame();
    return true;
  };
  window.ask = () => { const before = window.answers.length; window.frame().contentWindow.postMessage('who', '*'); return window.until('answers', before); };
  return true;
})()`;

// What every app page serves: it names itself on load and when asked.
const APP_PAGE = `<!doctype html><meta charset="utf-8"><body style="margin: 0">
<script>
  const id = Math.random().toString(36).slice(2);
  const page = location.pathname;
  parent.postMessage({ probe: 'hello', id, page }, '*');
  addEventListener('message', (event) => { if (event.data === 'who') parent.postMessage({ probe: 'me', id, page }, '*'); });
</script>`;

function hostPage() {
  return `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css">
<style>body { margin: 0; background: #111; } #pane { position: absolute; inset: 0; }</style>
<div id="pane"><div id="layer" class="preview-overlay-layer" style="width: ${LAYER.width}px; height: ${LAYER.height}px"></div></div>
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
    console.log('overlay-frame: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }

  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/overlay-frame');
  fs.mkdirSync(buildDirectory, { recursive: true });
  await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'tsx' },
    outfile: path.join(buildDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    logLevel: 'silent',
  });
  const files = {
    '/host.html': ['text/html', hostPage()],
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

  const spec = (overrides) => ({ id: 'rotator', nodeId: 'card', path: 'index.html', interactive: false, rects: { 'p.card': [FIRST] }, ...overrides });
  const probe = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow, protocol } = require('electron');
     protocol.registerSchemesAsPrivileged([{ scheme: 'stacki-app', privileges: { standard: true, secure: true } }]);
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       protocol.handle('stacki-app', () => new Response(${JSON.stringify(APP_PAGE)}, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
       const win = new BrowserWindow({
         show: false, width: ${WINDOW.width}, height: ${WINDOW.height}, useContentSize: true,
         webPreferences: { contextIsolation: true, nodeIntegration: false },
       });
       const run = (code) => win.webContents.executeJavaScript(code);
       const render = (value) => run('window.render(' + JSON.stringify(value) + ')');
       const out = { errors: [] };
       win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) out.errors.push(message); });
       try {
         await win.loadURL('http://127.0.0.1:${port}/host.html');
         await run(${JSON.stringify(PROBE_PAGE)});
         const layer = await run('window.box(document.getElementById("layer"))');
         out.layer = layer;

         // Anchored to nothing measured: no frame at all.
         await render(${JSON.stringify(spec({ rects: {} }))});
         out.unanchored = await run('window.frame() === null');

         await render(${JSON.stringify(spec({}))});
         out.first = { frame: await run('window.box(window.frame())'), item: await run('window.box(window.frame().parentElement)') };
         out.firstDocument = await run('window.until("documents", 0)');
         await run('window.watch()');

         // Moved, resized and made interactive: the same frame and document.
         await render(${JSON.stringify(spec({ interactive: true, rects: { 'p.card': [MOVED] } }))});
         out.moved = {
           sameElement: await run('window.frame() === window.watched'),
           srcWrites: await run('(window.srcWrites += window.writes.takeRecords().length, window.srcWrites)'),
           frame: await run('window.box(window.frame())'),
           answer: await run('window.ask()'),
           documents: await run('window.documents.length'),
         };

         // A new path: the same element loads that page.
         await render(${JSON.stringify(spec({ path: 'other.html', rects: { 'p.card': [MOVED] } }))});
         out.repathed = {
           sameElement: await run('window.frame() === window.watched'),
           srcWrites: await run('(window.srcWrites += window.writes.takeRecords().length, window.srcWrites)'),
           document: await run('window.until("documents", 1)'),
         };

         // A new id: a new frame.
         await render(${JSON.stringify(spec({ id: 'spinner', path: 'other.html', rects: { 'p.card': [MOVED] } }))});
         out.renamed = {
           oldConnected: await run('window.watched.isConnected'),
           newElement: await run('window.frame() !== null && window.frame() !== window.watched'),
           document: await run('window.until("documents", 2)'),
         };

         // The control: without the sizing rule the iframe is the browser default again.
         await run(\`(() => { const s = document.createElement('style'); s.textContent = '.app-overlay-frame { width: auto !important; height: auto !important; }'; document.head.append(s); return true })()\`);
         out.unsized = await run('window.box(window.frame())');
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
    const local = (box) => (box === undefined ? undefined : { x: box.x - out.layer.x, y: box.y - out.layer.y, w: box.w, h: box.h });
    const same = (actual, expected) => actual !== undefined && ['x', 'y', 'w', 'h'].every((key) => Math.abs(actual[key] - expected[key]) < 0.5);
    const show = (value) => JSON.stringify(value);
    check('the probe finished', out.failure === undefined, out.failure);
    check('the page logged no errors', out.errors.length === 0, out.errors.join('\n'));
    check('an item anchored to nothing measured draws no frame', out.unanchored === true);
    check('the item has the anchor box', same(local(out.first?.item), FIRST), show(local(out.first?.item)));
    check('the frame fills its item, not 300 × 150', same(local(out.first?.frame), FIRST), show(local(out.first?.frame)));
    check('the first document loads', typeof out.firstDocument?.id === 'string', show(out.firstDocument));
    check('a moved item keeps its frame element', out.moved?.sameElement === true);
    check('a moved item writes no src, so nothing navigates', out.moved?.srcWrites === 0, show(out.moved?.srcWrites));
    check('a moved item resizes its frame', same(local(out.moved?.frame), MOVED), show(local(out.moved?.frame)));
    check('a moved item keeps its document', out.moved?.answer?.id === out.firstDocument?.id, show({ answer: out.moved?.answer, first: out.firstDocument }));
    check('a moved item loads no other document', out.moved?.documents === 1, show(out.moved?.documents));
    check('a new path keeps the frame element', out.repathed?.sameElement === true);
    check('a new path sets src once in all', out.repathed?.srcWrites === 1, show(out.repathed?.srcWrites));
    check(
      'a new path loads that page as a new document',
      out.repathed?.document?.page === '/other.html' && out.repathed?.document?.id !== out.firstDocument?.id,
      show(out.repathed?.document),
    );
    check('a new id removes the old frame', out.renamed?.oldConnected === false);
    check('a new id draws a new frame', out.renamed?.newElement === true);
    check(
      'a new id loads a new document',
      typeof out.renamed?.document?.id === 'string' && out.renamed?.document?.id !== out.repathed?.document?.id,
      show(out.renamed?.document),
    );
    check('without the sizing rule the frame is 300 × 150 (the size check can fail)', out.unsized?.w === 300 && out.unsized?.h === 150, show(out.unsized));
  }

  if (failures.length) {
    console.error(`overlay-frame: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`overlay-frame: ${checked} passed  [a frame item fills its item; moving it keeps its document, a new path or id loads one]`);
})();
