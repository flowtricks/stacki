// Goal: opening a text on the canvas for typing never changes the layout: the element's box is the same
// to the pixel before editing, while editing and after the editor closes, for multi-line centred text with
// a custom line height and balanced wrapping, in headings, paragraphs, buttons and inline text.
//   node test/electron/preload/textEditLayout.test.js
// Method: real Electron window, the built preload, the real planner's catalog over the rendered markup;
// real mouse events (click count 2) open the editor. Heights and widths of each element, and of its
// parent, are read from real layout at the three moments.
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const loadRenderer = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { stampComment } = loadRenderer('shared/page/previewToken.ts');
const { canvasTextPlans } = loadRenderer('src/features/preview/canvasTextSource.ts');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const PAGE = 'src/pages/index.astro';
const WORDS = 'Build sites that rank in search, convert visitors and keep every team moving for high-performing brands';
// The Webflow home page heading: a component's slot leaves a newline before and after the words, and
// its two balanced lines grew a third while editing.
const HEADING = 'Webflow is the agentic web marketing platform for high-performing brands';
const SOURCE = `<h2 class="bal">\n  ${HEADING}\n</h2>\n<h1 class="hero">${WORDS}</h1>\n<p class="lead">${WORDS}</p>\n<div class="row"><button class="cta">${WORDS}</button></div>\n<div class="row2"><span class="tag">${WORDS}</span> and more</div>\n`;
const STYLE = `<style>
  body { margin: 0; font-family: Georgia, serif; }
  .hero { width: 420px; margin: 20px auto; text-align: center; font-size: 44px; line-height: 0.95; letter-spacing: -0.02em; text-wrap: balance; font-weight: 700; }
  .lead { width: 380px; margin: 10px auto; text-align: center; font-size: 22px; line-height: 1.7; padding: 4px 0; }
  .row { width: 300px; margin: 10px auto; }
  .cta { display: block; width: 100%; font: 600 18px/1.2 Georgia, serif; padding: 10px 14px; text-align: center; }
  .row2 { width: 300px; margin: 10px auto; font-size: 18px; line-height: 1.3; }
  .tag { background: #def; }
  .bal { width: 749px; margin: 30px auto; font: 600 42.6px/44.3px Georgia, serif; text-align: center; text-wrap: balance; }
</style>`;

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('text-edit-layout: skipped  [needs a Chromium]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  const parsed = parsePage(SOURCE, { locs: true });
  const plans = canvasTextPlans(SOURCE, parsed.model.nodes, (id) => id.replace(/^n/, ''));
  const byTag = (tag) => plans.find((plan) => plan.target.tag === tag).target;
  const targets = ['h1', 'h2', 'p', 'button', 'span'].map(byTag);
  const checksum = crypto.createHash('sha256').update(SOURCE).digest('hex');
  const catalog = { type: 'avb:text-catalog', session: 'one', file: PAGE, checksum, targets };
  const marked = (node, inner) => `<!--avb-s:${node}-->${inner}<!--avb-e:${node}-->`;
  const html =
    `<!doctype html><meta charset=utf-8>${STYLE}<body>${stampComment({ file: PAGE, checksum })}` +
    marked('0', `<h2 class="bal" data-avb-p="0">\n  <!--x-->${HEADING}<!--y-->\n</h2>`) +
    marked('1', `<h1 class="hero" data-avb-p="1">${WORDS}</h1>`) +
    marked('2', `<p class="lead" data-avb-p="2">${WORDS}</p>`) +
    marked('3', `<div class="row" data-avb-p="3">${marked('3.0', `<button class="cta" data-avb-p="3.0">${WORDS}</button>`)}</div>`) +
    marked('4', `<div class="row2" data-avb-p="4">${marked('4.0', `<span class="tag" data-avb-p="4.0">${WORDS}</span>`)} and more</div>`) +
    '</body>';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const body =
      url.pathname === '/host.html'
        ? '<!doctype html><meta charset=utf-8><style>html,body{margin:0}iframe{border:0;width:800px;height:1100px;display:block}</style><iframe id="canvas" src="/canvas.html#avb-design"></iframe><script>window.posts=[];addEventListener("message",(e)=>posts.push(e.data));</script>'
        : url.pathname === '/canvas.html'
          ? html
          : undefined;
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const directory = repoPath('node_modules/.stacki-test/text-edit-layout');
  fs.mkdirSync(directory, { recursive: true });
  const catalogFile = path.join(directory, 'catalog.json');
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const fs = require('fs');
     const { app, BrowserWindow, ipcMain } = require('electron');
     app.disableHardwareAcceleration();
     ipcMain.on('boot:read', (event) => { event.returnValue = undefined; });
     app.on('window-all-closed', () => app.quit());
     const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 900, height: 1150, webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true } });
       const run = (code) => win.webContents.executeJavaScript(code);
       const frame = 'document.getElementById("canvas").contentWindow';
       const post = (message) => run(frame + '.postMessage(' + JSON.stringify(message) + ', "*")');
       await win.loadURL('http://127.0.0.1:${port}/host.html');
       await waitFor({ what: 'the page loaded', read: () => run('document.getElementById("canvas").contentDocument.querySelectorAll("h1").length'), until: (count) => count === 1 });
       await post({ type: 'avb:track', paths: ['0', '1', '2', '3', '3.0', '4', '4.0'], scope: '', focus: '', focusOcc: 0 });
       await post(JSON.parse(fs.readFileSync(${JSON.stringify(catalogFile)}, 'utf8')));
       await new Promise((resolve) => setTimeout(resolve, 600));
       const read = (selector) => run('(() => { const d = ' + frame + '.document; const e = d.querySelector(' + JSON.stringify(selector) + '); const r = e.getBoundingClientRect(); const p = e.parentElement.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, parentHeight: p.height, html: e.innerHTML.length }; })()');
       const out = {};
       for (const selector of ['h2', 'h1', 'p', 'button', 'span']) {
         const before = await read(selector);
         const point = await run('(() => { const r = ' + frame + '.document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8) }; })()');
         for (let n = 1; n <= 2; n++) {
           win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: n });
           win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: n });
         }
         // The editor's presence is awaited, not guessed with a sleep: a slow Windows runner delivers the double click later. A wait that
         // runs out is not thrown here; it reads as editing false below, so the check names the selector and the posts seen.
         const editorOpen = '!!' + frame + '.document.querySelector("[data-avb-text-editor]")';
         await waitFor({ what: 'the editor opened on ' + selector, read: () => run(editorOpen), until: (open) => open === true }).catch(() => undefined);
         const editing = await run(editorOpen);
         const during = await read(selector);
         win.webContents.focus();
         await win.webContents.insertText('.');
         await new Promise((resolve) => setTimeout(resolve, 200));
         const typing = await read(selector);
         const tail = await run('(() => { const e = ' + frame + '.document.querySelector(' + JSON.stringify(selector) + '); return { last: e.lastChild && e.lastChild.nodeName, children: e.childNodes.length, style: e.getAttribute("style"), whiteSpace: getComputedStyle(e).whiteSpace }; })()');
         await post({ type: 'avb:text-close', session: 'one', action: 'cancel' });
         // The next selector's double click must not land while this editor is still closing.
         await waitFor({ what: 'the editor closed on ' + selector, read: () => run(editorOpen), until: (open) => open === false }).catch(() => undefined);
         await new Promise((resolve) => setTimeout(resolve, 400));
         const after = await read(selector);
         out[selector] = { before, during, typing, after, editing, tail, posts: await run('JSON.stringify(window.posts.filter((m) => /^avb:text/.test(m.type)).map((m) => m.type + (m.reason ? ":" + m.reason : "")))') };
       }
       console.log('RESULT ' + JSON.stringify(out));
       app.quit();
     });`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
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
  const line = run.stdout.split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const result = JSON.parse(line.slice('RESULT '.length));
    for (const [selector, reading] of Object.entries(result)) {
      check(`${selector}: the editor opened`, reading.editing === true, JSON.stringify(reading));
      for (const moment of ['during', 'typing', 'after']) {
        for (const key of ['top', 'left', 'width', 'height', 'parentHeight']) {
          check(
            `${selector}: ${key} while ${moment === 'during' ? 'editing' : 'closed again'} equals before`,
            reading[moment][key] === reading.before[key],
            `${reading.before[key]} -> ${reading[moment][key]} ${JSON.stringify(reading.tail)}`,
          );
        }
      }
      check(`${selector}: its markup is restored`, reading.after.html === reading.before.html, JSON.stringify(reading));
    }
  }
  if (failures.length) {
    console.error(`text-edit-layout: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`text-edit-layout: ${checked}/${checked} passed`);
})();
