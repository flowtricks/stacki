// App overlays stack above Stacki's canvas chrome and below its popups.
//
//   node test/renderer/apps/overlayStacking.test.js
//
// Goal: a pin, label or box an app draws on the canvas (`overlay.set`) is
// meant to be read and clicked, so the editor's own chrome (selection and
// hover outlines, the name tag with its component edit button, spacing bands)
// must not cover it. The app overlay root used to take no z-index while the
// outlines took 4, so a selection's name tag painted over a pin there. The
// editor's popups (dropdowns, tooltips) must still cover app overlays, and an
// app item that takes no pointer must still let the outline's controls work.
//
// Method: a real Electron window, since only a browser stacks and hit-tests. A
// host page draws the real layer (`.preview-overlay-layer` with
// previewViewport.css and the app's stylesheets) holding the real outlines
// (PreviewOverlays) and the real app overlay view (AppOverlayView), as
// PreviewPane.tsx does. The selection is a component, so its tag has the edit
// button, the one control on the outlines that takes the pointer. After the
// outlines lay out, the probe places, over that button, a non-interactive app
// box covering it and an interactive app pin covering part of it, then reads
// `document.elementFromPoint`:
//   - on the pin: the pin, not the button (app above chrome),
//   - on the button beside the pin, under the box: the button, since the box
//     takes no pointer; then with every element made hit-testable, the box,
//     which proves the box paints above the button rather than only passing
//     the pointer through,
//   - on the pin, with a dropdown and then a tooltip opened over it: the
//     popup (popups above app overlays),
//   - on the pin, with the app layer's z-index removed: the button. This is the
//     order before the fix, and it shows the checks above can fail.

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

const ENTRY = `
  import React from 'react'
  import { flushSync } from 'react-dom'
  import { createRoot } from 'react-dom/client'
  import { PreviewOverlays } from './src/features/preview/PreviewOverlays'
  import { AppOverlayView } from './src/features/apps/AppOverlayLayer'
  import { parseOverlayItems } from './shared/properties/appsRpc'
  import './src/app/styles.css'
  import './src/ui/popup.css'
  import './src/features/preview/previewViewport.css'
  import './src/features/apps/apps.css'

  const outlineRects = { 'p.card': [{ x: 100, y: 120, w: 300, h: 200 }], 'p.hero': [{ x: 80, y: 360, w: 400, h: 120 }] }
  const info = { label: 'Card', kind: 'component', tag: 'div', astroAsset: false, dynamicTag: false, nodeKind: 'component', childCount: 1, isLayout: false, bound: false }
  const items = parseOverlayItems([
    { kind: 'box', id: 'cover', anchor: { nodeId: 'cover' }, color: '#f97316' },
    { kind: 'pin', id: 'pin', anchor: { nodeId: 'pinspot', at: { x: 0, y: 0 } }, label: '3', interactive: true, cluster: false },
  ])
  const root = createRoot(document.getElementById('layer'))
  window.render = (appRects) => {
    flushSync(() => root.render(
      <>
        <PreviewOverlays
          rects={outlineRects}
          spacing={{}}
          scale={1}
          selPath="p.card"
          selOcc={0}
          hoverPath="p.hero"
          hoverOcc={0}
          focusPath={undefined}
          focusWhole={false}
          overlayInfo={() => info}
          onOpenComponent={() => {}}
        />
        {appRects === undefined ? null : (
          <AppOverlayView
            overlays={new Map([['notes', items]])}
            apps={new Map()}
            capture={undefined}
            held={undefined}
            rects={appRects}
            scale={1}
            pathFor={(nodeId) => 'p.' + nodeId}
            clickItem={() => {}}
          />
        )}
      </>,
    ))
    return true
  }
`;

function hostPage() {
  return `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css">
<style>
  body { margin: 0; background: #111; }
  /* PreviewPane.tsx's frame wrap: the positioned box the layer centres in. */
  #pane { position: absolute; inset: 0; }
</style>
<div id="pane"><div id="layer" class="preview-overlay-layer" style="width: ${LAYER.width}px; height: ${LAYER.height}px"></div></div>
<script src="bundle.js"></script>`;
}

// Runs in the page: which layer owns the topmost hit-testable element at a point.
const LAYER_AT = `window.layerAt = (x, y) => {
  const element = document.elementFromPoint(x, y);
  if (element === null) return 'none';
  if (element.closest('.dd-popup')) return 'dropdown';
  if (element.closest('.popup-tooltip')) return 'tooltip';
  if (element.closest('.app-overlay-pin')) return 'app-pin';
  if (element.closest('.app-overlay-box')) return 'app-box';
  if (element.closest('.app-overlay-root')) return 'app-root';
  if (element.closest('.node-outline-edit')) return 'outline-edit';
  if (element.closest('.node-outline-tag')) return 'outline-tag';
  if (element.closest('.node-outline')) return 'outline';
  return element.id || element.tagName;
}; true`;

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('overlay-stacking: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }

  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/overlay-stacking');
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

  const probe = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({
         show: false, width: ${WINDOW.width}, height: ${WINDOW.height}, useContentSize: true,
         webPreferences: { contextIsolation: true, nodeIntegration: false },
       });
       const run = (code) => win.webContents.executeJavaScript(code);
       const out = { errors: [] };
       win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) out.errors.push(message); });
       try {
         await win.loadURL('http://127.0.0.1:${port}/host.html');
         await run(${JSON.stringify(LAYER_AT)});
         await run('window.render(undefined)');
         // Where the edit button landed, in the layer's own pixels: the app's rects are canvas pixels at zoom 1.
         const at = await run(\`(() => {
           const layer = document.getElementById('layer').getBoundingClientRect();
           const button = document.querySelector('.node-outline-edit');
           if (button === null) return undefined;
           const b = button.getBoundingClientRect();
           return { layer: { x: layer.left, y: layer.top }, button: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } };
         })()\`);
         out.at = at;
         if (at !== undefined) {
           const local = (x, y) => ({ x: x - at.layer.x, y: y - at.layer.y });
           const corner = local(at.button.left, at.button.top);
           const width = at.button.right - at.button.left;
           const height = at.button.bottom - at.button.top;
           // The pin's tail tip sits at the anchor, its 24px badge up and to the right: over the button's right part.
           const tip = local(at.button.right - 8, at.button.bottom - 1);
           const appRects = {
             'p.cover': [{ x: corner.x, y: corner.y, w: width, h: height }],
             'p.pinspot': [{ x: tip.x, y: tip.y, w: 1, h: 1 }],
           };
           await run('window.render(' + JSON.stringify(appRects) + ')');
           const pin = await run(\`(() => { const r = document.querySelector('.app-overlay-pin-badge').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()\`);
           out.pin = pin;
           // A point on both the pin and the button, and one on the button (and the box) clear of the pin.
           const onPin = { x: Math.round(at.button.right - 4), y: Math.round(at.button.bottom - 5) };
           const besidePin = { x: Math.round(at.button.left + 4), y: Math.round((at.button.top + at.button.bottom) / 2) };
           out.onPin = onPin;
           out.besidePin = besidePin;
           out.besideIsClear = besidePin.x < pin.left;
           const layerAt = (point) => run('window.layerAt(' + point.x + ', ' + point.y + ')');
           out.hits = { pin: await layerAt(onPin), beside: await layerAt(besidePin) };

           // Every element hit-testable, so elementFromPoint reads paint order alone.
           await run(\`(() => { const s = document.createElement('style'); s.id = 'all-hit'; s.textContent = '#layer * { pointer-events: auto !important; }'; document.head.append(s); return true })()\`);
           out.painted = { beside: await layerAt(besidePin) };
           await run('document.getElementById("all-hit").remove(); true');

           // The editor's popups, opened over the pin as their components place them: fixed, in <body>.
           const popup = (className) => run(\`(() => {
             const element = document.createElement('div');
             element.className = '\${className}';
             element.textContent = 'Popup';
             Object.assign(element.style, { position: 'fixed', left: '\${onPin.x - 20}px', top: '\${onPin.y - 20}px', width: '60px', height: '40px' });
             document.body.append(element);
             return true;
           })()\`);
           await popup('dd-popup');
           out.hits.dropdown = await layerAt(onPin);
           await run('document.querySelector(".dd-popup").remove(); true');
           // A tooltip takes no pointer, so it is made hit-testable to read whether it paints above the pin.
           await popup('popup-tooltip');
           await run(\`(() => { document.querySelector('.popup-tooltip').style.setProperty('pointer-events', 'auto', 'important'); return true })()\`);
           out.hits.tooltip = await layerAt(onPin);
           await run('document.querySelector(".popup-tooltip").remove(); true');

           // The order before the fix: no z-index on the app layer.
           await run(\`(() => { const s = document.createElement('style'); s.textContent = '.app-overlay-root { z-index: auto !important; }'; document.head.append(s); return true })()\`);
           out.hits.unlayered = await layerAt(onPin);
         }
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
    const detail = JSON.stringify({ at: out.at, pin: out.pin, onPin: out.onPin, besidePin: out.besidePin });
    check('the probe finished', out.failure === undefined, out.failure);
    check('the page logged no errors', out.errors.length === 0, out.errors.join('\n'));
    check('the selected component draws its edit button', out.at !== undefined);
    check('the probe point beside the pin is clear of it', out.besideIsClear === true, detail);
    check('an app pin is above the selection tag and its edit button', out.hits?.pin === 'app-pin', `${out.hits?.pin} ${detail}`);
    check('the edit button takes the pointer where the app draws nothing that does', out.hits?.beside === 'outline-edit', `${out.hits?.beside} ${detail}`);
    check('an app box paints above the edit button', out.painted?.beside === 'app-box', `${out.painted?.beside} ${detail}`);
    check('a dropdown covers an app pin', out.hits?.dropdown === 'dropdown', out.hits?.dropdown);
    check('a tooltip covers an app pin', out.hits?.tooltip === 'tooltip', out.hits?.tooltip);
    check('without its layer the pin falls under the edit button (the check can fail)', out.hits?.unlayered === 'outline-edit', out.hits?.unlayered);
  }

  if (failures.length) {
    console.error(`overlay-stacking: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(
    `overlay-stacking: ${checked} passed  [app overlays above outlines and tags, below popups; outline controls keep the pointer where no app item takes it]`,
  );
})();
