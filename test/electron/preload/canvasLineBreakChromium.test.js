// Goal: in real Chromium, a text whose component allows line breaks opens without moving a pixel (its template
// newlines folded to the spaces the page showed), Enter at the end of the words puts the caret on a new line below,
// the words typed there land on that line, and ⌘/Ctrl Enter saves the words with one newline and without the space
// that held the empty line open. A text without the setting still finishes on Enter.
//   node test/electron/preload/canvasLineBreakChromium.test.js
// Method: real Electron window with the built preload over rendered markup and a catalog whose first target carries
// `breaks: 'line'`; a real double click opens the editor, real key events type. Boxes are read from layout, the
// messages from what the frame posts to its host. Every wait polls the state it is about (waitFor), never a sleep.
// A screenshot of the open editor is written beside the probe for a person to look at.
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
const SOURCE = '<p class="lead">\n  Words of a paragraph\n</p>\n<h2 class="head">A heading</h2>\n';
const STYLE = '<style>body{margin:0;font:20px/1.5 Georgia,serif}.lead{width:420px;margin:20px}.head{width:420px;margin:20px}</style>';

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('canvas-line-break: skipped  [needs a Chromium]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  const parsed = parsePage(SOURCE, { locs: true });
  const plans = canvasTextPlans(SOURCE, parsed.model.nodes, (id) => id.replace(/^n/, ''));
  const paragraph = plans.find((plan) => plan.target.tag === 'p').target;
  const heading = plans.find((plan) => plan.target.tag === 'h2').target;
  const checksum = crypto.createHash('sha256').update(SOURCE).digest('hex');
  const catalog = { type: 'avb:text-catalog', session: 'one', file: PAGE, checksum, targets: [{ ...paragraph, breaks: 'line' }, heading] };
  const marked = (node, inner) => `<!--avb-s:${node}-->${inner}<!--avb-e:${node}-->`;
  const html =
    `<!doctype html><meta charset=utf-8>${STYLE}<body>${stampComment({ file: PAGE, checksum })}` +
    marked('0', '<p class="lead" data-avb-p="0">\n  Words of a paragraph\n</p>') +
    marked('1', '<h2 class="head" data-avb-p="1">A heading</h2>') +
    '</body>';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const body =
      url.pathname === '/host.html'
        ? '<!doctype html><meta charset=utf-8><style>html,body{margin:0}iframe{border:0;width:600px;height:400px;display:block}</style><iframe id="canvas" src="/canvas.html#avb-design"></iframe><script>window.posts=[];addEventListener("message",(e)=>posts.push(e.data));</script>'
        : url.pathname === '/canvas.html'
          ? html
          : undefined;
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const directory = repoPath('node_modules/.stacki-test/canvas-line-break');
  fs.mkdirSync(directory, { recursive: true });
  const catalogFile = path.join(directory, 'catalog.json');
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  const shot = path.join(directory, 'editing.png');
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
       const win = new BrowserWindow({ show: false, width: 640, height: 440, webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true } });
       const run = (code) => win.webContents.executeJavaScript(code);
       const frame = 'document.getElementById("canvas").contentWindow';
       const post = (message) => run(frame + '.postMessage(' + JSON.stringify(message) + ', "*")');
       await win.loadURL('http://127.0.0.1:${port}/host.html');
       await waitFor({ what: 'the page loaded', read: () => run(frame + '.document.querySelectorAll("p").length'), until: (count) => count === 1 });
       await post({ type: 'avb:track', paths: ['0', '1'], scope: '', focus: '', focusOcc: 0 });
       await post(JSON.parse(fs.readFileSync(${JSON.stringify(catalogFile)}, 'utf8')));
       const box = (selector) => run('(() => { const r = ' + frame + '.document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; })()');
       const editorOpen = '!!' + frame + '.document.querySelector("[data-avb-text-editor]")';
       const posts = () => run('JSON.stringify(window.posts.filter((m) => /^avb:text-(save|refused|inactive)/.test(m.type)))');
       const open = async (selector) => {
         const point = await run('(() => { const f = document.getElementById("canvas").getBoundingClientRect(); const r = ' + frame + '.document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect(); return { x: Math.round(f.left + r.left + 20), y: Math.round(f.top + r.top + 10) }; })()');
         // The catalog arrives asynchronously; double clicks repeat until one opens the editor.
         await waitFor({
           what: 'the editor opened on ' + selector,
           read: async () => {
             for (let n = 1; n <= 2; n++) {
               win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: n });
               win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: n });
             }
             return run(editorOpen);
           },
           until: (value) => value === true,
         });
       };
       const key = (keyCode, modifiers = []) => {
         win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
         if (keyCode === 'Return') {
           win.webContents.sendInputEvent({ type: 'char', keyCode: '\\r', modifiers });
         }
         win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
       };
       const out = {};
       out.before = await box('p');
       await open('p');
       win.webContents.focus();
       out.opened = await box('p');
       out.whiteSpace = await run('getComputedStyle(' + frame + '.document.querySelector("p")).whiteSpace');
       // The caret at the end of the words.
       await run('(() => { const d = ' + frame + '.document; const t = [...d.querySelector("p").childNodes].find((n) => n.nodeType === 3 && /Words/.test(n.data)); d.getSelection().collapse(t, t.data.trimEnd().length); })()');
       const caretTop = () => run('(() => { const s = ' + frame + '.document.getSelection(); const r = s.getRangeAt(0).getClientRects(); const b = r.length ? r[0] : s.getRangeAt(0).getBoundingClientRect(); return b.top; })()');
       out.caretBefore = await caretTop();
       key('Return');
       await waitFor({ what: 'the break was typed', read: () => run(frame + '.document.querySelector("p").textContent'), until: (text) => text.includes('\\n') });
       out.caretAfter = await caretTop();
       out.grown = await box('p');
       await win.webContents.insertText('More');
       await waitFor({ what: 'the words were typed', read: () => run(frame + '.document.querySelector("p").textContent'), until: (text) => text.includes('More') });
       const image = await win.webContents.capturePage();
       fs.writeFileSync(${JSON.stringify(shot)}, image.toPNG());
       key('Return', [process.platform === 'darwin' ? 'meta' : 'control']);
       await waitFor({ what: 'the editor closed', read: () => run(editorOpen), until: (value) => value === false });
       // The frame's messages reach the host a task later: wait for the save (or a refusal) to arrive.
       out.saved = JSON.parse(await waitFor({ what: 'the save arrived', read: posts, until: (text) => /text-(save|refused)/.test(text) }));
       // Without the setting, Enter finishes.
       await open('h2');
       key('Return');
       await waitFor({ what: 'the heading editor closed on Enter', read: () => run(editorOpen), until: (value) => value === false });
       out.heading = await run(frame + '.document.querySelector("h2").textContent');
       console.log('RESULT ' + JSON.stringify(out));
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
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
  server.close();
  const line = result.stdout.split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) {
    check('the browser probe ran', false, (result.stderr || result.stdout || '').slice(0, 1200));
  } else {
    const reading = JSON.parse(line.slice('RESULT '.length));
    const detail = JSON.stringify(reading);
    check('the editor shows typed newlines', reading.whiteSpace === 'pre-line', detail);
    for (const key of ['top', 'left', 'width', 'height']) {
      check(`opening keeps the ${key}`, reading.opened[key] === reading.before[key], detail);
    }
    check('Enter at the end moves the caret a line down', reading.caretAfter > reading.caretBefore + 10, detail);
    check('the paragraph grew by the new line', reading.grown.height > reading.before.height + 10, detail);
    const saves = reading.saved.filter((message) => message.type === 'avb:text-save');
    check('one save', saves.length === 1, detail);
    check(
      'the save holds one newline and no line-end space',
      saves[0] !== undefined && /paragraph\nMore$/.test(saves[0].value.trim()) && !saves[0].value.includes('​'),
      detail,
    );
    check('a text without the setting finishes on Enter, unchanged', reading.heading === 'A heading', detail);
  }
  if (failures.length) {
    console.error(`canvas-line-break: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`canvas-line-break: ${checked}/${checked} passed (screenshot ${shot})`);
})();
