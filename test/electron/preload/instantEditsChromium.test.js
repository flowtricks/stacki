// Goal: in the browser Desktop ships, an edit shown ahead of its write changes the page's structure and
// attributes in the same task, so the owner's margin-trim case holds: with `.card-body > :where(:last-child)`
// trimming the last child's margin, deleting the paragraph after a heading trims the heading's margin
// at once, an insert untrims it, a reorder swaps first and last, and an attribute edit re-evaluates the
// selectors that read it. Each first visual change is timed from the message to the DOM, and bounded.
//
//   node test/electron/preload/instantEditsChromium.test.js
//
// Method: run under the Electron binary (layout, selector matching and postMessage are Chromium's own),
// with the real built preload running in an iframe, as Desktop's window runs it. A local server serves a
// fixture page with Stacki's markers and stamps; the host posts the same messages the editor posts and
// reads computed styles from the frame. The time to the first change is read from a MutationObserver in
// the frame against the host's clock (both as epoch milliseconds), after a round trip fixes their offset.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { repoPath } = require('../../helpers/sources.js');

const FIRST_VISUAL_CHANGE_MS_MAX = 100;
const STAMP = `<!--avb-d:${'a'.repeat(64)}:src/pages/index.astro-->`;
const marked = (nodePath, html) => `<!--avb-s:${nodePath}-->${html}<!--avb-e:${nodePath}-->`;
const PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'body{margin:0} p,section{margin:0} h2{margin:0 0 24px} .card-body > :where(:last-child){margin-bottom:0} [data-open]{padding-top:8px}' +
  '</style></head><body>' +
  marked('0', '<section class="card-body">' + marked('0.0', '<h2 id="h">Heading</h2>') + marked('0.1', '<p id="p">Paragraph</p>') + '</section>') +
  STAMP +
  '</body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const PRELOAD = ${JSON.stringify(repoPath('dist/electron/preload/preload.js'))};
app.on('window-all-closed', () => {});
ipcMain.on('boot:read', (event) => { event.returnValue = undefined; });
const HOST = '<!doctype html><html><body><iframe style="width:800px;height:600px;border:0" src="/page.html#avb-design"></iframe><script>' +
  'window.heard = []; window.addEventListener("message", (event) => { if (event.data && event.data.type) window.heard.push(event.data.type); });' +
  '</script></body></html>';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/page.html')) { response.writeHead(200, { 'content-type': 'text/html' }); response.end(fs.readFileSync(path.join(DIRECTORY, 'page.html'))); return; }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end(HOST);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { rows: [], error: undefined };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    for (let spin = 0; spin < 200 && !(await host('window.heard.includes("avb:render")')); spin += 1) { await sleep(25); }
    const frame = (code) => host('document.querySelector("iframe").contentWindow.eval(' + JSON.stringify(code) + ')');
    const margin = (id) => frame('getComputedStyle(document.getElementById(' + JSON.stringify(id) + ')).marginBottom');
    // The page's clock against the host's, from one round trip.
    const offset = async () => { const before = await host('performance.timeOrigin + performance.now()'); const page = await frame('performance.timeOrigin + performance.now()'); const after = await host('performance.timeOrigin + performance.now()'); return page - (before + after) / 2; };
    const timed = async (name, message, change) => {
      await frame('window.__first = undefined; new MutationObserver(() => { if (window.__first === undefined) window.__first = performance.timeOrigin + performance.now(); }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });');
      const skew = await offset();
      const sentAt = await host('(() => { const at = performance.timeOrigin + performance.now(); document.querySelector("iframe").contentWindow.postMessage(' + JSON.stringify(message) + ', "*"); return at; })()');
      let first;
      for (let spin = 0; spin < 200 && first === undefined; spin += 1) { first = await frame('window.__first'); if (first === undefined) await sleep(2); }
      const state = await change();
      output.rows.push({ name, firstChangeMs: first === undefined ? undefined : first - skew - sentAt, ...state });
    };
    const base = { h: await margin('h'), p: await margin('p') };
    output.base = base;
    // Delete the paragraph: the heading is the last child at once.
    await timed('delete', { type: 'avb:hide-pending', path: '0.1' }, async () => ({ headingMargin: await margin('h'), headingLast: await frame('document.getElementById("h").matches(":last-child")') }));
    await frame('document.dispatchEvent(new CustomEvent("avb:before-morph", { detail: undefined }))');
    await host('document.querySelector("iframe").contentWindow.postMessage({ type: "avb:insert-revert" }, "*")');
    await sleep(60);
    output.restored = { h: await margin('h'), p: await margin('p') };
    // Insert after the paragraph: the paragraph is no longer the last child.
    await timed('insert', { type: 'avb:optimistic-insert', insert: { scope: '', parent: [0], index: 2, anchor: { path: [0, 1], placement: 'after' }, node: { kind: 'element', tag: 'p', attributes: [], text: 'New' } } }, async () => ({ paragraphMargin: await margin('p'), paragraphLast: await frame('document.getElementById("p").matches(":last-child")') }));
    await host('document.querySelector("iframe").contentWindow.postMessage({ type: "avb:insert-revert" }, "*")');
    await sleep(60);
    // Reorder: the heading moves after the paragraph.
    await timed('reorder', { type: 'avb:optimistic-move', move: { scope: '', from: [0, 0], count: 1, parent: [0], index: 2, anchor: { path: [0, 1], placement: 'after' } } }, async () => ({ headingMargin: await margin('h'), paragraphFirst: await frame('document.getElementById("p").matches(":first-child")') }));
    await host('document.querySelector("iframe").contentWindow.postMessage({ type: "avb:move-revert" }, "*")');
    await sleep(60);
    // An attribute edit: a selector that reads the attribute applies in the same task.
    await timed('attribute', { type: 'avb:optimistic-edit', edits: [{ kind: 'attributes', path: '0.1', set: [['data-open', '']], remove: [] }] }, async () => ({ paddingTop: await frame('getComputedStyle(document.getElementById("p")).paddingTop') }));
    await timed('text', { type: 'avb:optimistic-edit', edits: [{ kind: 'text', path: '0.1', text: 'Changed' }] }, async () => ({ words: await frame('document.getElementById("p").textContent') }));
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log(JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string' || !fs.existsSync(repoPath('dist/electron/preload/preload.js'))) {
    console.log('instant-edits-chromium: skipped  [needs the Electron binary and npm run build:preload]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/instant-edits-chromium');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'page.html'), PAGE);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{"rows"'));
  const failures = [];
  const check = (what, condition, detail) => {
    if (!condition) {
      failures.push(`  ${what}${detail === undefined ? '' : `\n    ${detail}`}`);
    }
  };
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 1500));
  } else {
    const output = JSON.parse(line);
    check('the probe ran to the end', output.error === undefined, output.error);
    const row = (name) => output.rows.find((entry) => entry.name === name);
    check('the heading starts with its 24px margin', output.base?.h === '24px', JSON.stringify(output.base));
    check(
      'delete: the heading is the last child at once, margin trimmed',
      row('delete')?.headingLast === true && row('delete')?.headingMargin === '0px',
      JSON.stringify(row('delete')),
    );
    check('delete refused: the heading margin is back', output.restored?.h === '24px' && output.restored?.p === '0px', JSON.stringify(output.restored));
    check('insert: the paragraph stops being the last child and its margin returns', row('insert')?.paragraphLast === false, JSON.stringify(row('insert')));
    check(
      'reorder: the paragraph becomes the first child; the heading is last',
      row('reorder')?.paragraphFirst === true && row('reorder')?.headingMargin === '0px',
      JSON.stringify(row('reorder')),
    );
    check('attribute: the selector reading it applies', row('attribute')?.paddingTop === '8px', JSON.stringify(row('attribute')));
    check('text: the words changed', row('text')?.words === 'Changed', JSON.stringify(row('text')));
    for (const entry of output.rows ?? []) {
      check(
        `${entry.name}: first visual change within ${FIRST_VISUAL_CHANGE_MS_MAX} ms`,
        entry.firstChangeMs !== undefined && entry.firstChangeMs < FIRST_VISUAL_CHANGE_MS_MAX,
        JSON.stringify(entry),
      );
    }
    console.log(
      `instant-edits-chromium timings (ms to first change): ${(output.rows ?? []).map((entry) => `${entry.name} ${entry.firstChangeMs?.toFixed(1)}`).join(', ')}`,
    );
  }
  if (failures.length > 0) {
    console.error(`instant-edits-chromium: ${failures.length} checks failed\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('instant-edits-chromium: passed');
  }
})();
