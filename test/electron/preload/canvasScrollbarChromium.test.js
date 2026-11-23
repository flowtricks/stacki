// The page in a canvas frame gets the breakpoint's whole width, in the browser Desktop ships.
//
//   node test/electron/preload/canvasScrollbarChromium.test.js
//
// Goal: a canvas frame narrower than the width Settings names for Chromium's scrollbar lays its page out at the
// frame's full width, as a phone or a tablet does (a 320px frame is 320px of page, not 305px beside a classic
// scrollbar), while a frame at or past that width keeps exactly the scrollbar Chromium draws in a frame nobody touched.
// Off hides the root bar at every width. Each frame reports which bar is drawn, and the canvas's own bar scrolls it.
//
// Method: a real Electron window (jsdom has no layout and draws no scrollbars) serves a host page over localhost with
// three canvas iframes at `#avb-design`, the built preload running in each as in the app: a 320px phone frame and a
// 1440px desktop frame told where Chromium's bar starts (1023px, Laptop and wider), and a 1440px control frame that is
// told nothing. The pages are taller than their frames, so each scrolls. A computer that draws overlay scrollbars
// (macOS with a trackpad) gives the control frame no bar at all; the checks compare against the control frame rather
// than a number, so they hold on either kind of computer and still catch a frame that loses width to a bar. Every wait
// is a bounded poll for what the frames report (test/helpers/waitFor.js), never a fixed pause.

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

const FRAME_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}.tall{height:4000px;background:linear-gradient(#eee,#999)}</style></head>' +
  '<body><div class="tall"></div></body></html>';

// The host keeps each frame's last scroll report, so the probe can read what the canvas would draw.
const HOST_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}iframe{border:0;height:600px;display:block}</style></head><body>' +
  '<iframe id="phone" style="width:320px" src="/frame.html#avb-design"></iframe>' +
  '<iframe id="desktop" style="width:1440px" src="/frame.html#avb-design"></iframe>' +
  '<iframe id="control" style="width:1440px" src="/frame.html#avb-design"></iframe>' +
  '<script>window.reports = {};' +
  'addEventListener("message", (event) => {' +
  '  if (!event.data || event.data.type !== "avb:page-scroll") { return; }' +
  '  for (const frame of document.querySelectorAll("iframe")) { if (frame.contentWindow === event.source) { window.reports[frame.id] = event.data; } }' +
  '});</script></body></html>';

// What a frame's page has to lay out in, and what its last report said.
const READ_FRAMES = `(() => {
  const read = (id) => {
    const frame = document.getElementById(id).contentWindow;
    return { innerWidth: frame.innerWidth, clientWidth: frame.document.documentElement.clientWidth, scrollY: frame.scrollY, report: window.reports[id] ?? null };
  };
  return { phone: read('phone'), desktop: read('desktop'), control: read('control') };
})()`;

const tell = (id, message) => `document.getElementById(${JSON.stringify(id)}).contentWindow.postMessage(${JSON.stringify(message)}, '*')`;

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('canvas-scrollbar-chromium: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(url.pathname === '/frame.html' ? FRAME_PAGE : HOST_PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const probeDirectory = repoPath('node_modules/.stacki-test/canvas-scrollbar-chromium');
  fs.mkdirSync(probeDirectory, { recursive: true });
  const probe = path.join(probeDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow, ipcMain } = require('electron');
     app.disableHardwareAcceleration();
     // The preload's top frame asks main for the boot seed synchronously (electron/boot/bootChannels.ts).
     ipcMain.on('boot:read', (event) => {
       event.returnValue = undefined;
     });
     app.on('window-all-closed', () => app.quit());
     const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     app.whenReady().then(async () => {
       const win = new BrowserWindow({
         show: false, width: 3400, height: 800,
         webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true },
       });
       const run = (code) => win.webContents.executeJavaScript(code);
       const read = () => run(${JSON.stringify(READ_FRAMES)});
       await win.loadURL('http://127.0.0.1:${port}/host.html');
       // Each frame reports once its preload runs: Chromium's bar until the app's word arrives.
       const before = await waitFor({ what: 'every frame reports', read, until: (frames) => frames.phone.report && frames.desktop.report && frames.control.report });
       await run(${JSON.stringify(tell('phone', { type: 'avb:canvas-scrollbar', chromiumFromPx: 1023 }))});
       await run(${JSON.stringify(tell('desktop', { type: 'avb:canvas-scrollbar', chromiumFromPx: 1023 }))});
       const told = await waitFor({ what: 'the phone frame reports the canvas bar', read, until: (frames) => frames.phone.report.chromium === false });
       await run(${JSON.stringify(tell('phone', { type: 'avb:page-scroll-to', topPx: 500 }))});
       const scrolled = await waitFor({ what: 'the phone frame scrolls', read, until: (frames) => frames.phone.report.topPx === 500 });
       await run(${JSON.stringify(tell('desktop', { type: 'avb:canvas-scrollbar' }))});
       const off = await waitFor({ what: 'the desktop frame reports Off', read, until: (frames) => frames.desktop.report.chromium === false });
       console.log(JSON.stringify({ before, told, scrolled, off }));
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
    // Only a ceiling for a hung probe: the checks take as long as the machine needs.
    const timer = setTimeout(() => child.kill(), 180000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
  server.close();

  const line = run.stdout.split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 3000));
  } else {
    const { before, told, scrolled, off } = JSON.parse(line);
    const detail = (frame) => JSON.stringify(frame);
    check('before the app’s word, every frame says Chromium draws its bar', before.phone.report.chromium && before.control.report.chromium, detail(before));
    check('a 320px phone frame lays its page out at 320px', told.phone.innerWidth === 320 && told.phone.clientWidth === 320, detail(told.phone));
    check('and says the canvas draws its bar', told.phone.report.chromium === false, detail(told.phone));
    check(
      'a 1440px frame past Laptop keeps exactly the bar Chromium draws in an untouched frame',
      told.desktop.clientWidth === told.control.clientWidth,
      `${detail(told.desktop)} vs ${detail(told.control)}`,
    );
    check('and says Chromium draws it', told.desktop.report.chromium === true, detail(told.desktop));
    check(
      'the canvas bar’s scroll moves the page and is reported',
      scrolled.phone.scrollY === 500 && scrolled.phone.report.topPx === 500,
      detail(scrolled.phone),
    );
    check('Off gives a 1440px frame its whole width', off.desktop.clientWidth === off.desktop.innerWidth, detail(off.desktop));
  }

  if (failures.length) {
    console.error(`canvas-scrollbar-chromium: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`canvas-scrollbar-chromium: ${checked} passed  [a frame below the Chromium width gets its whole width; one past it keeps Chromium's bar]`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
