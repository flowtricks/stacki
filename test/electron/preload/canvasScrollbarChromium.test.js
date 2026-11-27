// The page in a canvas frame gets the breakpoint's whole width, in the browser Desktop ships.
//
//   node test/electron/preload/canvasScrollbarChromium.test.js
//
// Goal: a canvas frame lays its page out at the frame's full width at every breakpoint, as a phone or a tablet does (a
// 320px frame is 320px of page, not 305px beside a classic scrollbar; a 1440px frame is 1440px), from before its first
// paint, not only once the app's word arrives on load; an older app's width threshold in the message no longer brings
// Chromium's bar back. A frame that is not the canvas's keeps the bar Chromium draws. Each frame reports which bar is
// drawn, and the canvas's own bar scrolls it.
//
// Method: a real Electron window (jsdom has no layout and draws no scrollbars) serves a host page over localhost with
// three iframes, the built preload running in each as in the app: a 320px phone frame and a 1440px desktop frame at
// `#avb-design`, as the canvas loads them, later told to hide the bar (the desktop one with an older app's
// `chromiumFromPx: 1023`, now ignored), and a 1440px control frame without the mark that is told nothing. The pages are taller than their frames, so each scrolls. A computer that
// draws overlay scrollbars (macOS with a trackpad) gives the control frame no bar at all; the checks compare a frame's
// layout width against its own viewport, so they hold on either kind of computer and still catch a frame that loses
// width to a bar. Every wait is a bounded poll for what the frames report (test/helpers/waitFor.js), never a fixed
// pause.

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
  '<iframe id="control" style="width:1440px" src="/frame.html"></iframe>' +
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
       // Each frame reports once its preload runs: a canvas frame has hidden its bar already, the control frame has not.
       const before = await waitFor({ what: 'every frame reports', read, until: (frames) => frames.phone.report && frames.desktop.report && frames.control.report });
       await run(${JSON.stringify(tell('phone', { type: 'avb:canvas-scrollbar' }))});
       await run(${JSON.stringify(tell('desktop', { type: 'avb:canvas-scrollbar', chromiumFromPx: 1023 }))});
       const told = await waitFor({
         what: 'both told frames report the canvas bar',
         read,
         until: (frames) => frames.phone.report.chromium === false && frames.desktop.report.chromium === false,
       });
       await run(${JSON.stringify(tell('phone', { type: 'avb:page-scroll-to', topPx: 500 }))});
       const scrolled = await waitFor({ what: 'the phone frame scrolls', read, until: (frames) => frames.phone.report.topPx === 500 });
       console.log(JSON.stringify({ before, told, scrolled }));
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
    const { before, told, scrolled } = JSON.parse(line);
    const detail = (frame) => JSON.stringify(frame);
    check(
      'before the app’s word, a canvas frame has hidden its bar already and says so',
      before.phone.report.chromium === false && before.desktop.report.chromium === false,
      detail(before),
    );
    check('and the 320px phone frame lays its page out at 320px from the start', before.phone.clientWidth === 320, detail(before.phone));
    check('a frame that is not the canvas’s says Chromium draws its bar', before.control.report.chromium === true, detail(before.control));
    check('a 320px phone frame lays its page out at 320px', told.phone.innerWidth === 320 && told.phone.clientWidth === 320, detail(told.phone));
    check('and says the canvas draws its bar', told.phone.report.chromium === false, detail(told.phone));
    check(
      'a 1440px frame lays its page out at 1440px too, an older app’s width threshold ignored',
      told.desktop.clientWidth === told.desktop.innerWidth,
      detail(told.desktop),
    );
    check('and says the canvas draws its bar', told.desktop.report.chromium === false, detail(told.desktop));
    check('an untold frame still says Chromium draws its bar', told.control.report.chromium === true, detail(told.control));
    check(
      'the canvas bar’s scroll moves the page and is reported',
      scrolled.phone.scrollY === 500 && scrolled.phone.report.topPx === 500,
      detail(scrolled.phone),
    );
  }

  if (failures.length) {
    console.error(`canvas-scrollbar-chromium: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`canvas-scrollbar-chromium: ${checked} passed  [every told frame gets its whole width; an untold one keeps Chromium's bar]`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
