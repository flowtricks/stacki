// An app's overlay `frame` item is transparent outside what the app paints
// (docs/apps.md, "Overlays"; shared/properties/appUiKit.ts APP_FRAME_SURFACE).
//
//   npx electron test/electron/handlers/appFrameTransparency.test.js
//
// Goal: a hover card drawn as an overlay frame, with a 20px margin the app left
// for its shadow and a transparent body, leaves the canvas pixels around the card
// unchanged. Chromium paints an iframe opaque (#121212 dark, white light) when
// the frame element's used color scheme differs from the document root's, so the
// bug showed as a grey box the size of the frame. Each document is checked twice:
// one that says `color-scheme: dark`, as an app styled for the dark editor does,
// and one that names no scheme. A control frame without the frame surface proves
// the sample can see the box at all, so a pass is not a blind spot.
//
// Methodology: run under the Electron binary (real Chromium compositing), serve
// a fixture app through the real serveAppRequest (which injects the tokens and
// the root's default scheme, withAppTokens), embed it in a host page whose
// canvas is one flat colour, with the iframe styled exactly as AppFrame.tsx
// styles it (APP_FRAME_SURFACE) and sandboxed the same way, capture the page and
// sample pixels in the margin, inside the card, and outside the frame.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, protocol } = require('electron');

const { APP_SCHEME, APP_SCHEME_PRIVILEGES, serveAppRequest } = require('#dist/electron/handlers/appsHandlers.js');
const { APP_FRAME_SURFACE } = require('#dist/shared/properties/appUiKit.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);
app.on('window-all-closed', () => {});

// The canvas under the overlay: a flat colour far from both opaque canvases (#121212 and white).
const CANVAS = { r: 200, g: 120, b: 40 };
const CARD = { r: 51, g: 102, b: 255 };
const FRAME = { left: 40, top: 40, width: 240, height: 140 };
const MARGIN_PX = 20;
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

const card = (scheme) => `<!doctype html>
<html><head><meta charset="utf-8"><title>card</title>
<style>
${scheme === undefined ? '' : `:root { color-scheme: ${scheme}; }`}
html, body { margin: 0; background: transparent; }
.card { position: absolute; inset: ${MARGIN_PX}px; background: rgb(${CARD.r}, ${CARD.g}, ${CARD.b}); border-radius: 8px; }
</style></head>
<body><div class="card"></div></body></html>`;

function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-frame-'));
  const bundle = path.join(root, '.stacki', 'apps', 'hover');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'index.html'), card(undefined));
  fs.writeFileSync(path.join(bundle, 'dark.html'), card('dark'));
  fs.writeFileSync(path.join(bundle, 'plain.html'), card(undefined));
  const manifest = { manifestVersion: 1, id: 'hover', name: 'Hover', version: '1.0.0', entry: 'index.html' };
  fs.writeFileSync(path.join(bundle, 'stacki-app.json'), JSON.stringify(manifest));
  return root;
}

const cssText = (style) =>
  Object.entries(style)
    .map(([name, value]) => `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}: ${value}`)
    .join('; ');

// The editor's side: a canvas colour, no color-scheme of its own, and one overlay frame item.
const host = (file, surface) => `<!doctype html>
<html><head><meta charset="utf-8"><title>host</title>
<style>html, body { margin: 0; width: 100%; height: 100%; background: rgb(${CANVAS.r}, ${CANVAS.g}, ${CANVAS.b}); }</style></head>
<body>
<div style="position: absolute; left: ${FRAME.left}px; top: ${FRAME.top}px; width: ${FRAME.width}px; height: ${FRAME.height}px">
<iframe src="${APP_SCHEME}://hover/${file}" sandbox="${SANDBOX}" title="overlay"
  onload="document.title = 'loaded'"
  style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0; ${cssText(surface)}"></iframe>
</div>
</body></html>`;

async function settled(window) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (window.webContents.getTitle() === 'loaded') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Two more frames, so the iframe's first paint is composited.
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

function pixel(image, x, y) {
  const scale = image.getSize().width / 400;
  const bitmap = image.toBitmap();
  const index = (Math.round(y * scale) * image.getSize().width + Math.round(x * scale)) * 4;
  // toBitmap is BGRA.
  return { r: bitmap[index + 2], g: bitmap[index + 1], b: bitmap[index] };
}

const near = (actual, expected) => Math.abs(actual.r - expected.r) <= 2 && Math.abs(actual.g - expected.g) <= 2 && Math.abs(actual.b - expected.b) <= 2;
const show = (color) => `rgb(${color.r}, ${color.g}, ${color.b})`;

// The margin around the card (each side), the card's middle, and a point outside the frame.
const SAMPLES = {
  marginTop: { x: FRAME.left + FRAME.width / 2, y: FRAME.top + MARGIN_PX / 2 },
  marginLeft: { x: FRAME.left + MARGIN_PX / 2, y: FRAME.top + FRAME.height / 2 },
  marginRight: { x: FRAME.left + FRAME.width - MARGIN_PX / 2, y: FRAME.top + FRAME.height / 2 },
  marginBottom: { x: FRAME.left + FRAME.width / 2, y: FRAME.top + FRAME.height - MARGIN_PX / 2 },
  card: { x: FRAME.left + FRAME.width / 2, y: FRAME.top + FRAME.height / 2 },
  outside: { x: 10, y: 10 },
};

async function capture(window, file, surface) {
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(host(file, surface))}`);
  await settled(window);
  const image = await window.webContents.capturePage();
  return Object.fromEntries(Object.entries(SAMPLES).map(([name, at]) => [name, pixel(image, at.x, at.y)]));
}

app.whenReady().then(async () => {
  const root = fixtureProject();
  protocol.handle(APP_SCHEME, (request) => serveAppRequest(request.url, root));
  const window = new BrowserWindow({
    width: 400,
    height: 260,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  try {
    for (const file of ['dark.html', 'plain.html']) {
      const pixels = await capture(window, file, APP_FRAME_SURFACE);
      for (const side of ['marginTop', 'marginLeft', 'marginRight', 'marginBottom']) {
        check(`${file}: the ${side} pixel is the canvas, unchanged`, near(pixels[side], CANVAS), show(pixels[side]));
      }
      check(`${file}: the card itself is drawn`, near(pixels.card, CARD), show(pixels.card));
      check(`${file}: outside the frame is the canvas`, near(pixels.outside, CANVAS), show(pixels.outside));
    }
    // The control: a dark document in a frame left at the editor's `normal` scheme shows the box.
    const control = await capture(window, 'dark.html', { background: 'transparent' });
    check(
      'the control frame (mismatched color scheme) paints an opaque box, so the sample can see one',
      !near(control.marginTop, CANVAS),
      show(control.marginTop),
    );
  } finally {
    window.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`app frame transparency: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    app.exit(1);
    return;
  }
  console.log(`app frame transparency: ${checked} checks passed`);
  app.exit(0);
});
