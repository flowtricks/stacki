// Goal: in real Chromium, a text whose component allows line breaks opens without moving a pixel (its template
// newlines folded to the spaces the page showed), Enter at the end of the words puts the caret on a new line below,
// the words typed there land on that line, and ⌘/Ctrl Enter saves the words with one newline and without the space
// that held the empty line open. A text without the setting still finishes on Enter.
//   node test/electron/preload/canvasLineBreakChromium.test.js
// Method: real Electron window with the built preload over rendered markup and a catalog whose first target carries
// `breaks: 'line'`; a real double click opens the editor, real key events type. Boxes are read from layout, the
// messages from what the frame posts to its host. Every wait polls the state it is about (waitFor), never a sleep.
// The same window then edits a rich text instance: Enter makes a new paragraph at once, the caret in an empty block
// asks the host for its `+`, a `+` choice turns the block into a heading, and ⌘/Ctrl Enter posts the instance's HTML
// without the preview's bookkeeping. Screenshots of both open editors are written beside the probe.
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
const SOURCE = '<p class="lead">\n  Words of a paragraph\n</p>\n<h2 class="head">A heading</h2>\n<RichText><p>Hello world</p><h2>Title</h2></RichText>\n';
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
  // The probe drives the real pointer, so like every pointer probe it runs on macOS only (docs/release-runbook.md).
  if (process.platform !== 'darwin') {
    console.log('canvas-line-break: skipped  [macOS only]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  const parsed = parsePage(SOURCE, { locs: true });
  const plans = canvasTextPlans(SOURCE, parsed.model.nodes, (id) => id.replace(/^n/, ''));
  const paragraph = plans.find((plan) => plan.target.tag === 'p').target;
  const heading = plans.find((plan) => plan.target.tag === 'h2').target;
  const checksum = crypto.createHash('sha256').update(SOURCE).digest('hex');
  const hello = plans.find((plan) => plan.target.value === 'Hello world').target;
  const catalog = {
    type: 'avb:text-catalog',
    session: 'one',
    file: PAGE,
    checksum,
    targets: [{ ...paragraph, breaks: 'line' }, heading, { ...hello, breaks: 'rich', richRoot: '2' }],
  };
  const marked = (node, inner) => `<!--avb-s:${node}-->${inner}<!--avb-e:${node}-->`;
  const html =
    `<!doctype html><meta charset=utf-8>${STYLE}<body>${stampComment({ file: PAGE, checksum })}` +
    marked('0', '<p class="lead" data-avb-p="0">\n  Words of a paragraph\n</p>') +
    marked('1', '<h2 class="head" data-avb-p="1">A heading</h2>') +
    // The rich text component draws its own wrapper and label; the instance's blocks sit beside the label.
    marked(
      '2',
      `<div class="rich" data-astro-cid-x><span class="label">Component label</span>${marked('2.0', '<p data-avb-p="2.0" data-astro-cid-x>Hello world</p>')}${marked('2.1', '<h2 data-avb-p="2.1">Title</h2>')}</div>`,
    ) +
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
  const richShot = path.join(directory, 'rich.png');
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
       await waitFor({ what: 'the page loaded', read: () => run(frame + '.document.querySelectorAll("p").length'), until: (count) => count >= 1 });
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
       out.editing = await run(frame + '.document.querySelector("p").isContentEditable');
       // The caret at the end of the words.
       await run('(() => { const d = ' + frame + '.document; const t = [...d.querySelector("p").childNodes].find((n) => n.nodeType === 3 && /Words/.test(n.data)); d.getSelection().collapse(t, t.data.trimEnd().length); })()');
       const caretTop = () => run('(() => { const s = ' + frame + '.document.getSelection(); const r = s.getRangeAt(0).getClientRects(); const b = r.length ? r[0] : s.getRangeAt(0).getBoundingClientRect(); return b.top; })()');
       out.caretBefore = await caretTop();
       key('Return');
       await waitFor({ what: 'the break was typed', read: () => run(frame + '.document.querySelectorAll("p br").length'), until: (count) => count > 0 });
       out.caretAfter = await caretTop();
       out.grown = await box('p');
       await win.webContents.insertText('More');
       await waitFor({ what: 'the words were typed', read: () => run(frame + '.document.querySelector("p").textContent'), until: (text) => text.includes('More') });
       const image = await win.webContents.capturePage();
       fs.writeFileSync(${JSON.stringify(shot)}, image.toPNG());
       // ⌘/Ctrl Enter breaks the line too, and Backspace takes a break back out.
       key('Return', [process.platform === 'darwin' ? 'meta' : 'control']);
       await win.webContents.insertText('Gone');
       for (let index = 0; index < 'Gone'.length + 1; index++) {
         key('Backspace');
       }
       out.afterBackspace = await run(frame + '.document.querySelector("p").innerHTML');
       // A press elsewhere on the canvas saves, and the page keeps showing the break until its rendering arrives.
       const away = await run('(() => { const f = document.getElementById("canvas").getBoundingClientRect(); const r = ' + frame + '.document.querySelector("h2").getBoundingClientRect(); return { x: Math.round(f.left + r.left + 4), y: Math.round(f.top + r.top + 4) }; })()');
       win.webContents.sendInputEvent({ type: 'mouseDown', x: away.x, y: away.y, button: 'left', clickCount: 1 });
       win.webContents.sendInputEvent({ type: 'mouseUp', x: away.x, y: away.y, button: 'left', clickCount: 1 });
       await waitFor({ what: 'the editor closed', read: () => run(editorOpen), until: (value) => value === false });
       out.shownAfterSave = await run(frame + '.document.querySelector("p").innerHTML');
       // The frame's messages reach the host a task later: wait for the save (or a refusal) to arrive.
       out.saved = JSON.parse(await waitFor({ what: 'the save arrived', read: () => run('JSON.stringify(window.posts.filter((m) => /^avb:(rich-save|text-(save|refused))/.test(m.type)))'), until: (text) => /save|refused/.test(text) }));
       // Without the setting, Enter finishes.
       await open('h2');
       key('Return');
       await waitFor({ what: 'the heading editor closed on Enter', read: () => run(editorOpen), until: (value) => value === false });
       out.heading = await run(frame + '.document.querySelector("h2").textContent');
       // Rich text: the caret at the end of "Hello", Enter, typing, a + choice, then ⌘/Ctrl Enter.
       await open('.rich p');
       await run('(() => { const d = ' + frame + '.document; const t = [...d.querySelector(".rich p").childNodes].find((n) => n.nodeType === 3); d.getSelection().collapse(t, 5); })()');
       key('Return');
       const blocks = () => run('[...' + frame + '.document.querySelector(".rich").children].map((e) => e.tagName + ":" + e.textContent.trim()).join("|")');
       await waitFor({ what: 'Enter made a paragraph', read: blocks, until: (text) => (text.match(/P:/g) ?? []).length === 2 });
       out.afterEnter = await blocks();
       key('End', ['shift']);
       key('Delete');
       await waitFor({ what: 'the new paragraph emptied', read: blocks, until: (text) => text.includes('P:|') });
       await waitFor({ what: 'the + was asked for', read: () => run('JSON.stringify(window.posts.filter((m) => m.type === "avb:rich-plus").at(-1) ?? null)'), until: (text) => /rect/.test(text) });
       await post({ type: 'avb:rich-block', session: 'one', choice: { kind: 'block', block: 'h3' } });
       await waitFor({ what: 'the block became a heading', read: blocks, until: (text) => text.includes('H3:') });
       await win.webContents.insertText('New');
       await waitFor({ what: 'the heading took words', read: blocks, until: (text) => text.includes('H3:New') });
       out.afterChoice = await blocks();
       fs.writeFileSync(${JSON.stringify(richShot)}, (await win.webContents.capturePage()).toPNG());
       // ⌘/Ctrl Enter breaks the line inside the heading; a press elsewhere saves.
       key('Return', [process.platform === 'darwin' ? 'meta' : 'control']);
       out.richBreak = await run(frame + '.document.querySelector(".rich h3").innerHTML');
       key('Backspace');
       const outside = await run('(() => { const f = document.getElementById("canvas").getBoundingClientRect(); const r = ' + frame + '.document.querySelector("h2.head").getBoundingClientRect(); return { x: Math.round(f.left + r.left + 4), y: Math.round(f.top + r.top + 4) }; })()');
       win.webContents.sendInputEvent({ type: 'mouseDown', x: outside.x, y: outside.y, button: 'left', clickCount: 1 });
       win.webContents.sendInputEvent({ type: 'mouseUp', x: outside.x, y: outside.y, button: 'left', clickCount: 1 });
       await waitFor({ what: 'the rich editor closed', read: () => run(editorOpen), until: (value) => value === false });
       out.rich = JSON.parse(await waitFor({ what: 'the rich save arrived', read: () => run('JSON.stringify(window.posts.filter((m) => m.type === "avb:rich-save"))'), until: (text) => (text.match(/rich-save/g) ?? []).length >= 2 }));
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
    check('the words are edited as a block the browser edits', reading.editing === true, detail);
    for (const key of ['top', 'left', 'width', 'height']) {
      check(`opening keeps the ${key}`, reading.opened[key] === reading.before[key], detail);
    }
    check('Enter at the end puts the words typed next on the new line', /<br>More/.test(reading.afterBackspace), detail);
    check('the paragraph grew by the new line', reading.grown.height > reading.before.height + 10, detail);
    const saves = reading.saved.filter((message) => message.type === 'avb:rich-save');
    check('one save', saves.length === 1, detail);
    check('Backspace took the ⌘ Enter break back out', !/More<br>.*<br>/.test(reading.afterBackspace), detail);
    check('the save holds the words and one break, nothing left over', saves[0] !== undefined && /paragraph\s*<br>More$/.test(saves[0].html.trim()), detail);
    check('the break still shows once the editor closed', /<br>/.test(reading.shownAfterSave), detail);
    check('a text without the setting finishes on Enter, unchanged', reading.heading === 'A heading', detail);
    check('rich Enter makes a new paragraph at once', reading.afterEnter === 'SPAN:Component label|P:Hello|P:world|H2:Title', detail);
    check('a + choice turns the empty block into a heading', reading.afterChoice === 'SPAN:Component label|P:Hello|H3:New|H2:Title', detail);
    check('⌘ Enter in rich text breaks the line inside the block', /<br>/.test(reading.richBreak ?? ''), detail);
    check('the save is the instance blocks only, without bookkeeping', reading.rich.at(-1)?.html === '<p>Hello</p><h3>New</h3><h2>Title</h2>', detail);
  }
  if (failures.length) {
    console.error(`canvas-line-break: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`canvas-line-break: ${checked}/${checked} passed (screenshot ${shot})`);
})();
