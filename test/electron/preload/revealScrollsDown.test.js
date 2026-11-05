// Revealing a selection scrolls the page down to it, never sideways.
//
//   node test/electron/preload/revealScrollsDown.test.js
//
// Selecting a node in the Navigator asks the canvas frame to bring it into
// view (`avb:scroll-to`). A site is often wider than the frame on purpose — a
// hero video bleeding off the right edge — and clips the overflow with
// `overflow-x: hidden` on the body or a wrapper. The reveal used to scroll
// sideways as well, and a viewport whose overflow is hidden still scrolls when
// script asks it to, while nothing on the canvas can scroll it back: the page
// stayed stuck to one side.
//
// Method: a real Electron window (jsdom has no layout and no scrolling) serves
// a host page over localhost with the canvas page in an iframe at
// `#avb-design`, the built preload running in both as it does in the app. The
// host posts `avb:track` and then `avb:scroll-to` exactly as the app does, and
// reads the frame's scroll state afterwards:
//   - a video overflowing to the right inside an `overflow-x: hidden` wrapper,
//   - a video bleeding off the right of a body with `overflow-x: hidden`,
// both already in vertical view, leave the window and every ancestor at
// scrollLeft 0 and the page where it was; a section below the fold scrolls the
// page down until it is on screen, even when the smooth scroll is halted
// partway (the page halts the first one, as Linux did); revealing it again
// does not move the page.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const FRAME_PAGE = `<!doctype html><meta charset=utf-8>
<style>
  html, body { margin: 0; }
  body { overflow-x: hidden; }
  .spacer { height: 40px; }
  .wrap { overflow-x: hidden; }
  .video { width: 2000px; height: 200px; margin-left: 600px; background: #c33; }
  .bleed { margin-top: 20px; }
  .tall { height: 3000px; }
  .below { height: 200px; background: #36c; }
</style>
<body>
  <div class="spacer"></div>
  <div class="wrap"><!--avb-s:0--><div class="video" id="wrapped"></div><!--avb-e:0--></div>
  <!--avb-s:1--><div class="video bleed" id="bleeding"></div><!--avb-e:1-->
  <div class="tall"></div>
  <!--avb-s:2--><section class="below" id="below"></section><!--avb-e:2-->
  <script>
    // The stall the Linux runner showed, made to happen everywhere: the first
    // smooth scroll the page sees is halted where it is, a few pixels down.
    // The reveal must still arrive at the section.
    let halted = false;
    addEventListener('scroll', () => {
      if (!halted && scrollY > 0) {
        halted = true;
        scrollTo({ top: scrollY, behavior: 'instant' });
      }
    });
  </script>
</body>`;

const HOST_PAGE = `<!doctype html><meta charset=utf-8>
<style>html, body { margin: 0; } iframe { border: 0; width: 800px; height: 600px; display: block; }</style>
<iframe id="canvas" src="/frame.html#avb-design"></iframe>`;

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('reveal-scrolls-down: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const server = http.createServer((request, response) => {
    const page = (request.url || '').startsWith('/frame.html') ? FRAME_PAGE : HOST_PAGE;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const probeDirectory = repoPath('node_modules/.stacki-test/reveal-scrolls-down');
  fs.mkdirSync(probeDirectory, { recursive: true });
  const probe = path.join(probeDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     app.whenReady().then(async () => {
       const win = new BrowserWindow({
         show: false, width: 900, height: 700,
         webPreferences: {
           preload: ${JSON.stringify(preload)},
           contextIsolation: true,
           nodeIntegration: false,
           nodeIntegrationInSubFrames: true,
         },
       });
       await win.loadURL('http://127.0.0.1:${port}/host.html');
       await sleep(600);
       const run = (code) => win.webContents.executeJavaScript(code);
       await run(\`document.getElementById('canvas').contentWindow.postMessage(
         { type: 'avb:track', paths: ['0', '1', '2'], scope: '', focus: '', focusOcc: 0 }, '*')\`);
       await sleep(300);
       // Reveal a path, let a smooth scroll finish (bounded), and read where everything is.
       const reveal = (nodePath, id) => run(\`(async () => {
         const frame = document.getElementById('canvas').contentWindow;
         frame.postMessage({ type: 'avb:scroll-to', path: '\${nodePath}', occ: 0 }, '*');
         // Settled means the element is on screen and the page has stopped, or
         // the page has held still for ten readings. Two equal readings were not
         // enough: on the Linux runner a smooth scroll can pause between frames
         // for longer than one 60 ms reading, and was read 9px into its way.
         const element = frame.document.getElementById('\${id}');
         const SETTLE_TRIES_MAX = 80;
         const STILL_READINGS_MAX = 10;
         let last = -1;
         let still = 0;
         for (let attempt = 0; attempt < SETTLE_TRIES_MAX; attempt += 1) {
           await new Promise((r) => setTimeout(r, 60));
           const now = frame.scrollY + frame.scrollX * 100000;
           still = now === last ? still + 1 : 0;
           last = now;
           const box = element.getBoundingClientRect();
           const onScreen = box.top >= 0 && box.bottom <= frame.innerHeight;
           if (attempt > 4 && still >= 2 && onScreen) { break; }
           if (still >= STILL_READINGS_MAX) { break; }
         }
         const lefts = [];
         for (let node = element; node; node = node.parentElement) {
           lefts.push(node.scrollLeft);
         }
         lefts.push(frame.document.scrollingElement.scrollLeft);
         const rect = element.getBoundingClientRect();
         return { scrollX: frame.scrollX, scrollY: frame.scrollY, lefts, top: rect.top, bottom: rect.bottom, height: frame.innerHeight };
       })()\`);
       const wrapped = await reveal('0', 'wrapped');
       const bleeding = await reveal('1', 'bleeding');
       const below = await reveal('2', 'below');
       const again = await reveal('2', 'below');
       console.log(JSON.stringify({ wrapped, bleeding, below, again }));
       app.quit();
     });`,
  );

  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // Asynchronous, so this process keeps serving the pages the probe loads.
  const run = await new Promise((resolve) => {
    const child = spawn(electronPath, [probe], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
  server.close();

  const line = run.stdout.split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const { wrapped, bleeding, below, again } = JSON.parse(line);
    const allZero = (lefts) => lefts.every((left) => left === 0);

    check('a video overflowing a clipped wrapper does not scroll the window sideways', wrapped.scrollX === 0, JSON.stringify(wrapped));
    check('nor any ancestor of it', allZero(wrapped.lefts), JSON.stringify(wrapped.lefts));
    check('and, already in view, the page stays put', wrapped.scrollY === 0, JSON.stringify(wrapped));

    check('a video bleeding off a clipped body does not scroll the window sideways', bleeding.scrollX === 0, JSON.stringify(bleeding));
    check('nor any ancestor of it', allZero(bleeding.lefts), JSON.stringify(bleeding.lefts));
    check('and, already in view, the page stays put', bleeding.scrollY === 0, JSON.stringify(bleeding));

    check('a section below the fold scrolls the page down', below.scrollY > 0, JSON.stringify(below));
    check('until it is on screen', below.top >= 0 && below.bottom <= below.height, JSON.stringify(below));
    check('still without going sideways', below.scrollX === 0 && allZero(below.lefts), JSON.stringify(below));

    check('revealing it again does not move the page', again.scrollY === below.scrollY, JSON.stringify({ below, again }));
  }

  if (failures.length) {
    console.error(`reveal-scrolls-down: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`reveal-scrolls-down: ${checked} passed  [a reveal scrolls down, never sideways]`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
