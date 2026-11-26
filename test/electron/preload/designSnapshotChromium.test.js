// A Design mode frame is the page as a visitor who scrolled through it sees it, in the browser Desktop ships.
//
//   node test/electron/preload/designSnapshotChromium.test.js
//
// Goal: a snapshot of a page whose content only appears as it is scrolled shows all of it, finished: a delayed,
// staggered scroll entrance; text split into lines under masks; a reveal that reverses off screen; a value tied to
// the scroll position (read where it is centred); a Web animation that holds its end; a view timeline; a 2D and a
// WebGL canvas, at their own size; rules written through the CSSOM, constructed sheets and open shadow roots; and a
// pinned sequence, shown once as it starts without its scroll room. A page that animates for ever still gets its
// picture, within the walk's bound. What the page hides stays hidden. A copy taken after an edit shows new
// entrances finished and keeps the edit. The live page is left where it was scrolled, and is never scrolled while
// the request says the person can see it.
//
// Method: a real Electron window (jsdom has no layout, observers or canvases) serves a host page over localhost with
// one canvas iframe at `#avb-design`, the built preload running in it as in the app, on the page in
// test/fixtures/design-snapshot/motion.html. The host sends the app's own snapshot requests and draws each answer
// in an iframe with scripts off, as the canvas does, which is what is measured. The first request holds the page
// still and is the control: it shows the page as the old copy did. Every wait is a bounded poll or a reply.

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
    failures.push(`  ${what}${detail === undefined ? '' : `\n    ${JSON.stringify(detail)}`}`);
  }
};

const HOST_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}iframe{border:0;display:block;width:400px}#live{height:600px}#copy{height:9000px}</style></head><body>' +
  '<iframe id="live" src="/motion.html#avb-design"></iframe><script>' +
  'const live = document.getElementById("live");' +
  'let asked = 0;' +
  'window.take = (walking) => new Promise((resolve, reject) => {' +
  '  const nonce = "t" + (++asked); const began = performance.now(); let heard = false;' +
  '  const timer = setTimeout(() => reject(new Error("no reply")), 40000);' +
  '  const receive = (event) => {' +
  '    const data = event.data; if (event.source !== live.contentWindow || !data || data.nonce !== nonce) return;' +
  '    if (data.type === "stacki:design-snapshot-started") { heard = true; return; }' +
  '    if (data.type !== "stacki:design-snapshot-reply") return;' +
  '    clearTimeout(timer); removeEventListener("message", receive);' +
  '    resolve({ ok: data.ok, heard, ms: performance.now() - began, html: data.ok ? data.snapshot.html : data.detail });' +
  '  };' +
  '  addEventListener("message", receive);' +
  '  live.contentWindow.postMessage({ type: "stacki:design-snapshot", nonce, walking }, "*");' +
  '});' +
  'window.draw = (html) => new Promise((resolve) => {' +
  '  document.getElementById("copy")?.remove(); const copy = document.createElement("iframe"); copy.id = "copy";' +
  '  copy.setAttribute("sandbox", "allow-same-origin"); copy.srcdoc = html;' +
  '  copy.onload = () => setTimeout(resolve, 300); document.body.appendChild(copy);' +
  '});' +
  '</script></body></html>';

// What the drawn copy shows, read as a person would see it.
const READ_COPY = `(async () => {
  const page = document.getElementById('copy').contentDocument;
  await Promise.all(Array.from(page.images, (image) => image.decode().catch(() => undefined)));
  const view = page.defaultView;
  const one = (selector) => page.querySelector(selector);
  const seen = (element) => {
    if (!element) return false;
    let opacity = 1;
    for (let at = element; at; at = at.parentElement) {
      const style = view.getComputedStyle(at);
      if (style.display === 'none') return false;
      opacity *= Number(style.opacity);
    }
    return view.getComputedStyle(element).visibility === 'visible' && opacity > 0.98;
  };
  const box = (element) => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top + view.scrollY }; };
  const pixel = async (selector) => {
    const image = one(selector);
    if (!image || image.tagName !== 'IMG') return image ? image.tagName : 'missing';
    await image.decode().catch(() => undefined);
    const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 4, 4);
    return Array.from(context.getImageData(2, 2, 1, 1).data);
  };
  const color = (element) => (element ? view.getComputedStyle(element).color : 'missing');
  const parallax = one('.parallax');
  return {
    cards: Array.from(page.querySelectorAll('.card')).map((card) => seen(card) && ['none', '0px'].includes(view.getComputedStyle(card).translate)),
    splitMasks: page.querySelectorAll('.split .mask').length,
    splitHeight: box(one('.split')).height,
    reversing: seen(one('.toggle')),
    parallaxShift: new view.DOMMatrix(view.getComputedStyle(parallax).transform).m42,
    parallaxWidth: box(parallax).width,
    web: seen(one('.web')),
    timeline: seen(one('.timeline')),
    late: seen(one('.late')),
    flat: { box: box(one('.flat')), pixel: await pixel('.flat') },
    solid: { box: box(one('.solid')), pixel: await pixel('.solid') },
    inserted: color(one('.by-insert')),
    adopted: color(one('.by-adopt')),
    shadow: color(one('x-card')?.shadowRoot?.querySelector('b')),
    pinHeight: box(one('.pin-spacer')).height,
    pinPosition: view.getComputedStyle(one('#pinned')).position,
    menuHidden: !seen(one('#menu')),
    loader: seen(one('.loader')),
    nodesKept: page.querySelectorAll('[data-dm-id]').length > 10,
  };
})()`;

const PROBE = (preload, port, waitForPath) => `const { app, BrowserWindow, ipcMain } = require('electron');
app.commandLine.appendSwitch('use-mock-keychain');
// A machine with no graphics card draws WebGL in software.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.setPath('userData', require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'stacki-design-snapshot-')));
// The preload's top frame asks main for the boot seed synchronously (electron/boot/bootChannels.ts).
ipcMain.on('boot:read', (event) => { event.returnValue = undefined; });
app.on('window-all-closed', () => app.quit());
app.dock?.hide();
const { waitFor } = require(${JSON.stringify(waitForPath)});
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 600, height: 800,
    webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, backgroundThrottling: false },
  });
  const run = (code) => win.webContents.executeJavaScript(code);
  const live = (code) => run('document.getElementById("live").contentWindow.eval(' + JSON.stringify(code) + ')');
  await win.loadURL('http://127.0.0.1:${port}/host.html');
  await waitFor({ what: 'the page is up', read: () => live('document.readyState === "complete" && !!document.querySelector(".runner").style.translate'), until: Boolean });
  const read = async (reply) => { await run('draw(' + JSON.stringify(reply.html) + ')'); return await run(${JSON.stringify(READ_COPY)}); };
  const out = { webgl: await live('window.drawsWebGL') };
  await live('scrollTo(0, 150); window.scrolls = []; addEventListener("scroll", () => scrolls.push(scrollY)); 0');
  await waitFor({ what: 'the scroll is heard', read: () => live('scrolls.length'), until: (count) => count > 0 });
  await live('scrolls.length = 0');
  const held = await run('take("held")');
  out.held = { reply: { ok: held.ok, heard: held.heard }, copy: await read(held), scrolls: await live('scrolls.length') };
  const walked = await run('take("allowed")');
  out.walked = { ok: walked.ok, ms: walked.ms, copy: await read(walked), scrollAfter: await live('scrollY') };
  const again = await run('take("allowed")');
  out.again = { ms: again.ms, copy: await read(again) };
  // An edit: new elements with entrances of their own, and a style written on an element the page scrubs.
  await live('const section = document.querySelector("#tween"); section.innerHTML = "<div class=card>Four</div><div class=card>Five</div>"; armCards(); document.querySelector(".parallax").style.width = "123px"; 0');
  const edited = await run('take("allowed")');
  out.edited = { ms: edited.ms, copy: await read(edited) };
  out.liveStyles = await live('JSON.stringify({ pin: document.querySelector(".pin-spacer").getAttribute("style"), canvases: document.querySelectorAll("canvas").length, menu: document.querySelector("#menu").getAttribute("style") })');
  console.log(JSON.stringify(out));
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
`;

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('design-snapshot-chromium: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);
  const fixture = fs.readFileSync(repoPath('test/fixtures/design-snapshot/motion.html'), 'utf8');

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(url.pathname === '/motion.html' ? fixture : HOST_PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const probeDirectory = repoPath('node_modules/.stacki-test/design-snapshot-chromium');
  fs.mkdirSync(probeDirectory, { recursive: true });
  const probe = path.join(probeDirectory, 'probe.js');
  fs.writeFileSync(probe, PROBE(preload, port, repoPath('test/helpers/waitFor.js')));

  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = await new Promise((resolve) => {
    const child = spawn(electronPath, [probe, '--use-mock-keychain'], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    // Only a ceiling for a hung probe.
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
    judge(JSON.parse(line));
  }

  if (failures.length) {
    console.error(`design-snapshot-chromium: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`design-snapshot-chromium: ${checked} passed  [a frame shows the page finished, as scrolled through]`);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function judge({ webgl, held, walked, again, edited, liveStyles }) {
  check('a request is acknowledged before its answer', held.reply.ok && held.reply.heard, held.reply);
  check('a held request never scrolls the page', held.scrolls === 0, held.scrolls);
  check('control: held, the entrances below the screen have not played', held.copy.cards.every((card) => !card) && held.copy.splitMasks === 3, held.copy);
  check('a walked page is pictured', walked.ok, walked);
  if (!webgl) {
    console.log('design-snapshot-chromium: no WebGL here, so its picture is not checked');
  }
  whole('first copy', walked.copy, webgl);
  check('the walk stays within its bound', walked.ms < 20_000, walked.ms);
  check('the live page is back where it was scrolled', walked.scrollAfter === 150, walked.scrollAfter);
  whole('a second copy', again.copy, webgl);
  check('a page already walked is pictured again without walking it', again.ms < walked.ms && again.ms < 5_000, [walked.ms, again.ms]);
  check('after an edit, new entrances are finished', edited.copy.cards.length === 2 && edited.copy.cards.every(Boolean), edited.copy.cards);
  check('and the edit stands, over what was read while walking', Math.round(edited.copy.parallaxWidth) === 123, edited.copy.parallaxWidth);
  const live = JSON.parse(liveStyles);
  check('the live page keeps its pin, canvases and menu', /1200px/.test(live.pin) && live.canvases === 2 && /hidden/.test(live.menu), live);
}

function whole(which, copy, webgl) {
  const say = (what, condition, detail) => check(`${which}: ${what}`, condition, detail);
  say('a delayed, staggered entrance is finished', copy.cards.length === 3 && copy.cards.every(Boolean), copy.cards);
  say('split text is whole again, at its real height', copy.splitMasks === 0 && copy.splitHeight < 80, [copy.splitMasks, copy.splitHeight]);
  say('a reveal that reverses off screen shows as seen on screen', copy.reversing);
  say('a scrubbed value is read where it is centred', Math.abs(copy.parallaxShift) <= 40, copy.parallaxShift);
  say('a Web animation shows its end', copy.web);
  say('a view timeline shows as seen on screen', copy.timeline);
  say('an entrance on a timer is waited for', copy.late);
  say('a 2D canvas keeps its size', Math.abs(copy.flat.box.height - copy.flat.box.width / 2) < 1, copy.flat);
  say('and its picture', Array.isArray(copy.flat.pixel) && copy.flat.pixel[0] > 230 && copy.flat.pixel[2] < 30, copy.flat.pixel);
  say('a WebGL canvas keeps its size', Math.abs(copy.solid.box.height - copy.solid.box.width / 2) < 1, copy.solid);
  say('and its picture', !webgl || (Array.isArray(copy.solid.pixel) && copy.solid.pixel[1] > 170 && copy.solid.pixel[0] < 30), copy.solid.pixel);
  say('a rule written with insertRule applies', copy.inserted === 'rgb(1, 2, 3)', copy.inserted);
  say('a constructed stylesheet applies', copy.adopted === 'rgb(4, 5, 6)', copy.adopted);
  say('an open shadow root is drawn with its styles', copy.shadow === 'rgb(7, 8, 9)', copy.shadow);
  say('a pinned sequence is shown once, without its scroll room', copy.pinHeight < 600 && copy.pinPosition === 'relative', [copy.pinHeight, copy.pinPosition]);
  say('what the page keeps hidden stays hidden', copy.menuHidden);
  say('an endless animation leaves its element showing', copy.loader);
  say('the copy still carries its element marks', copy.nodesKept);
}
