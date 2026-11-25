// A card that opens a modal keeps it open in the canvas's interact mode, in a real
// browser, exactly as the page does in a plain browser.
//
//   node test/electron/preload/canvasInteractModal.test.js
//
// Goal: a Stacki user's project grid (cards from `projects.map`, each opening its
// project in a lightbox) showed the lightbox for a moment and then lost it under
// "Loading page…". Pinned here, for every way a page opens a modal from a card:
// a `<dialog>` opened with showModal(), a lightbox appended to <body>, a lightbox that
// also pushes `?project=` onto the history, and a card that is a LINK to its project
// page whose script opens the lightbox instead (`preventDefault`). For each: the page's
// own handler runs exactly once, the click still selects the card, the modal is open
// two seconds later and after a selection and an edit's morph tick, no recorded
// animation frame shows it closed once it opened, and the canvas never reloads. A plain
// link card, whose page leaves the click to the browser, still loads the project page
// in the canvas, with the design hash, and loads it once.
//
// Methodology: run under the Electron binary, so layout, events and postMessage are
// Chromium's own. A local server on 127.0.0.1 serves each page with Stacki's markers
// and stamps; the host page embeds it in an iframe the real built preload runs in (as
// Desktop's window runs it) and runs the real message parser and click ladder
// (test/helpers/canvasClickHost.ts). The frame is put in interact mode with the real
// `avb:interaction` message. The real morph client runs in the page (#avb-design), and
// the server renders a new heading on every request, so `avb:patch-now` is a real patch
// of the live page while the modal is open. The page records, in its own world, every
// animation frame's modal state, its handler's calls, and every removal of the modal.
// Clicks are dispatched at the card's centre, since a hidden window takes no native
// presses. Waits on state are bounded polls (test/helpers/waitFor.js); the two-second
// observation window is a deliberate fixed span, since "still open after two seconds"
// is the property itself.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const stamp = (file, digit) => `<!--avb-d:${digit.repeat(64)}:${file}-->`;
const marked = (nodePath, html) => `<!--avb-s:${nodePath}-->${html}<!--avb-e:${nodePath}-->`;
const STYLE =
  '<style>html,body{margin:0;font:16px/1.4 sans-serif}.grid{display:flex;gap:8px;padding:8px}' +
  '.card{display:block;width:200px;height:200px;background:#ccc}.lightbox{position:fixed;inset:0;background:#000c;color:#fff}' +
  'dialog{width:80vw;height:60vh}</style>';
// The page's own record, in its own world: each animation frame's modal state, the
// handler's calls, morphs, and who removed the modal (the stack of a removal made by
// a page-world call; a removal with no such call came from another world).
const RECORDER =
  '<script>window.record = { frames: [], delivered: 0, morphs: 0, removals: [] };' +
  'window.modalOpen = () => document.querySelector(".lightbox, dialog[open]") !== null;' +
  'const tick = () => { record.frames.push(modalOpen() ? 1 : 0); if (record.frames.length < 5000) { requestAnimationFrame(tick); } }; requestAnimationFrame(tick);' +
  'document.addEventListener("avb:morphed", () => { record.morphs += 1; });' +
  'new MutationObserver((changes) => { for (const change of changes) { for (const node of change.removedNodes) { if (node.nodeType === 1 && node.matches(".lightbox")) { record.removals.push("removed " + new Error().stack); } }' +
  ' if (change.type === "attributes" && change.target.matches("dialog") && !change.target.open) { record.removals.push("dialog closed"); } } }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });</script>';
const cards = (kind) =>
  Array.from({ length: 3 }, (_, index) =>
    marked(
      `0.1.${index}`,
      kind === 'link'
        ? `<a class="card" id="card${index}" data-index="${index}" href="/projects/p${index}/">Project ${index}</a>`
        : `<div class="card" id="card${index}" data-index="${index}">Project ${index}</div>`,
    ),
  ).join('');
const OPEN_LIGHTBOX =
  'const openLightbox = (index) => { record.delivered += 1; const box = document.createElement("div"); box.className = "lightbox";' +
  ' box.innerHTML = "<button>(Close)</button><p>Project " + index + "</p>"; box.querySelector("button").onclick = () => box.remove(); document.body.append(box); };';
const EACH_CARD = 'for (const card of document.querySelectorAll(".card")) ';
// `RENDER` is replaced by the server with a count of its renderings: every fetch the
// morph client makes is a new rendering, so its patch really changes the live page.
const page = (body, script) =>
  `<!doctype html><html><head><meta charset="utf-8">${STYLE}${RECORDER}<script type="module" src="/morph.js"></script></head><body>` +
  marked('0', '<h1 id="title">Rendering RENDER</h1>') +
  marked('0.1', `<section class="grid">${body}</section>`) +
  `<script>${script}</script>${stamp('src/pages/index.astro', 'a')}</body></html>`;

const SCENARIOS = [
  {
    name: 'dialog',
    html: page(
      cards('div') + '<dialog id="modal"><p>Photo</p></dialog>',
      `${EACH_CARD}card.addEventListener("click", () => { record.delivered += 1; document.getElementById("modal").showModal(); });`,
    ),
  },
  {
    name: 'lightbox',
    html: page(cards('div'), `${OPEN_LIGHTBOX}${EACH_CARD}card.addEventListener("click", () => openLightbox(card.dataset.index));`),
  },
  {
    name: 'history-lightbox',
    html: page(
      cards('div'),
      OPEN_LIGHTBOX +
        `${EACH_CARD}card.addEventListener("click", () => { history.pushState({}, "", "?project=" + card.dataset.index); openLightbox(card.dataset.index); });` +
        'addEventListener("popstate", () => document.querySelector(".lightbox")?.remove());',
    ),
  },
  {
    name: 'link-card-lightbox',
    html: page(
      cards('link'),
      `${OPEN_LIGHTBOX}${EACH_CARD}card.addEventListener("click", (event) => { event.preventDefault(); openLightbox(card.dataset.index); });`,
    ),
  },
];
const PROJECT_PAGE =
  `<!doctype html><html><head><meta charset="utf-8">${STYLE}</head><body>` +
  marked('0', '<div class="lightbox"><a href="/">(Close)</a><p id="project">Project photo</p></div>') +
  `${stamp('src/pages/projects/[slug].astro', 'c')}</body></html>`;

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('canvas-interact-modal: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/canvas-interact-modal');
  fs.mkdirSync(path.join(directory, 'pages'), { recursive: true });
  esbuild.buildSync({
    entryPoints: [repoPath('test/helpers/canvasClickHost.ts')],
    outfile: path.join(directory, 'host.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    logLevel: 'silent',
    absWorkingDir: ROOT,
  });
  fs.copyFileSync(repoPath('dist/electron/previewClient/morphClient.js'), path.join(directory, 'morph.js'));
  for (const scenario of SCENARIOS) {
    fs.writeFileSync(path.join(directory, 'pages', `${scenario.name}.html`), scenario.html);
  }
  fs.writeFileSync(path.join(directory, 'pages', 'link-card-page.html'), page(cards('link'), ''));
  // A page script that stops the click on its way up without cancelling it: the browser
  // would still follow the link, so the canvas must, once, with its design hash.
  fs.writeFileSync(
    path.join(directory, 'pages', 'link-card-stopped.html'),
    page(cards('link'), `${EACH_CARD}card.addEventListener("click", (event) => event.stopPropagation());`),
  );
  fs.writeFileSync(path.join(directory, 'project.html'), PROJECT_PAGE);
  fs.writeFileSync(path.join(directory, 'scenarios.json'), JSON.stringify(SCENARIOS.map(({ name }) => name)));
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 240_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{"results"'));
  if (line === undefined) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 2000));
  } else {
    report(JSON.parse(line));
  }
  if (failures.length) {
    console.error(`canvas-interact-modal: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`canvas-interact-modal: ${checked} checks passed`);
  }
})();

function report({ results, plainLink, stoppedLink, error }) {
  check('the probe ran to the end', error === undefined, error);
  if (error !== undefined) {
    return;
  }
  for (const result of results) {
    const label = result.name;
    const detail = JSON.stringify({ ...result, frames: undefined });
    check(`${label}: the canvas stayed on the card's page`, result.left === undefined, detail);
    if (result.left !== undefined) {
      continue;
    }
    check(`${label}: the modal opened`, result.opened, detail);
    check(`${label}: the page's handler ran exactly once`, result.delivered === 1, detail);
    check(`${label}: the click selected the card`, result.selections.includes('0.1.1'), detail);
    check(`${label}: still open after two seconds`, result.openAfterWait, detail);
    check(`${label}: the morph tick patched the page`, result.morphs >= 1, detail);
    check(`${label}: the patch reached the live page`, result.title !== result.titleBefore, detail);
    check(`${label}: still open after a selection and a morph`, result.openAfterTick, detail);
    check(`${label}: no frame shows it closed once it opened`, result.closedFrames === 0, `${result.closedFrames} closed frames; ${detail}`);
    check(`${label}: nothing removed or closed it`, result.removals.length === 0, detail);
    check(`${label}: the canvas never reloaded`, result.loads === 1, detail);
    check(`${label}: the click ladder never reloaded`, result.reloads === 0, detail);
  }
  for (const [label, link] of [
    ['a plain link card', plainLink],
    ['a link card whose script stops the click', stoppedLink],
  ]) {
    const detail = JSON.stringify(link);
    check(`${label}: the canvas loads the project page`, link.landed === '/projects/p1/', detail);
    check(`${label}: with the design hash`, link.hash === '#avb-design', detail);
    check(`${label}: loaded once`, link.loads === 2, detail);
    check(`${label}: the host hears where it went`, link.navigated.includes('/projects/p1/'), detail);
  }
}

// The Electron side. A string, so the probe runs under the Electron binary with
// nothing of this file's Node process.
function PROBE(directory) {
  return `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
const DIRECTORY = ${JSON.stringify(directory)};
const PRELOAD = ${JSON.stringify(repoPath('dist/electron/preload/preload.js'))};
const scenarios = JSON.parse(fs.readFileSync(path.join(DIRECTORY, 'scenarios.json'), 'utf8'));
// The observation window: the modal must still be open this long after it opened.
const OBSERVE_MS = 2000;
app.on('window-all-closed', () => {});
// The preload's top frame asks main for the boot seed synchronously; this answers as main does with no snapshot.
ipcMain.on('boot:read', (event) => {
  event.returnValue = undefined;
});

// The host: the real ladder (host.js), the canvas put in interact mode on every load
// as useCanvasInteraction does, and a log of the frame's loads and navigations.
const host = (name) =>
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head>' +
  '<body><iframe data-src="/pages/' + name + '.html#avb-design"></iframe><script src="/host.js"></script><script>' +
  'window.hostLog = { loads: [], navigated: [] }; const canvas = document.querySelector("iframe");' +
  'canvas.addEventListener("load", () => { const page = canvas.contentWindow; hostLog.loads.push(page.location.pathname + page.location.hash);' +
  ' page.postMessage({ type: "avb:site-pages", base: "", routes: ["/pages/' + name + '.html", "/projects/[slug]"] }, "*"); page.postMessage({ type: "avb:interaction", mode: "interact" }, "*"); });' +
  'addEventListener("message", (event) => { if (event.source === canvas.contentWindow && event.data && event.data.type === "avb:navigated") { hostLog.navigated.push(event.data.path); } });' +
  '</script></body></html>';

app.whenReady().then(async () => {
  const renderings = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/host/')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(host(url.pathname.slice('/host/'.length)));
      return;
    }
    if (url.pathname.startsWith('/projects/')) {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end(fs.readFileSync(path.join(DIRECTORY, 'project.html')));
      return;
    }
    const file = path.join(DIRECTORY, path.normalize(url.pathname).replace(/^([/\\\\])+/, ''));
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const javascript = file.endsWith('.js');
    response.writeHead(200, { 'content-type': javascript ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' });
    // The document's own load and the morph client's first pull (its baseline) are one
    // rendering; every pull after them is a new one.
    const count = (renderings.get(url.pathname) ?? 0) + (javascript ? 0 : 1);
    renderings.set(url.pathname, count);
    response.end(javascript ? fs.readFileSync(file) : fs.readFileSync(file, 'utf8').replace('RENDER', String(Math.max(1, count - 1))));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true },
  });
  const CALL_MS_MAX = 5000;
  const bounded = (call, what) =>
    Promise.race([call, new Promise((_, reject) => setTimeout(() => reject(new Error(what + ': no answer in ' + CALL_MS_MAX + ' ms')), CALL_MS_MAX))]);
  const hostJs = (code) => bounded(win.webContents.executeJavaScript(code), 'host');
  // Page code runs through the host, in the iframe's own realm; the answer crosses back as JSON.
  const pageJs = (code) =>
    hostJs(
      '(() => { const page = document.querySelector("iframe").contentWindow; if (!page || page.location.href === "about:blank") { return { failed: "no canvas page yet" }; } try { const value = page.eval(' +
        JSON.stringify(code) +
        '); return { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }; } catch (error) { return { failed: String(error) }; } })()',
    ).then((answer) => {
      if (answer.failed !== undefined) {
        throw new Error(answer.failed + ' in: ' + code.slice(0, 120));
      }
      return answer.value;
    });
  const soft = (read) => () => read().catch(() => undefined);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const must = async (options) => {
    const outcome = await pollUntil(options);
    if (outcome.kind !== 'reached') {
      throw new Error(options.what + ': not reached; last seen ' + JSON.stringify(outcome.value));
    }
    return outcome.value;
  };
  const open = async (name) => {
    await win.loadURL(origin + '/host/' + name);
    await must({ what: name + ' vouched for', read: soft(() => hostJs('canvasHost.renders')), until: (renders) => renders >= 1 });
    await must({ what: name + ' in interact mode', read: soft(() => pageJs('getComputedStyle(document.documentElement).cursor')), until: (cursor) => cursor === 'default' });
  };
  // A full press at the card's centre, as the browser delivers one to what it hit-tests there.
  const pressCard = () =>
    pageJs('(() => { const box = document.getElementById("card1").getBoundingClientRect(); const x = Math.round(box.left + box.width / 2), y = Math.round(box.top + box.height / 2); const target = document.elementFromPoint(x, y); const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 }; target.dispatchEvent(new PointerEvent("pointerdown", init)); target.dispatchEvent(new MouseEvent("mousedown", init)); target.dispatchEvent(new PointerEvent("pointerup", init)); target.dispatchEvent(new MouseEvent("mouseup", init)); target.dispatchEvent(new MouseEvent("click", { ...init, detail: 1 })); return true; })()');
  // The modal's state, or 'left' once the canvas shows another document than the card's page.
  const MODAL = 'typeof modalOpen === "function" ? modalOpen() : "left"';
  const output = { results: [], plainLink: undefined, stoppedLink: undefined };
  try {
    for (const name of scenarios) {
      await open(name);
      await pressCard();
      // The link card's click waits out the double-click window before the page hears it.
      const opened = (await pollUntil({ what: name + ' modal open', read: soft(() => pageJs(MODAL)), until: (open) => open !== false })).value === true;
      await sleep(OBSERVE_MS);
      const openAfterWait = await pageJs(MODAL);
      if (openAfterWait === 'left') {
        // The canvas left the page the card is on: nothing of it is left to look at.
        const hostState = await hostJs('({ loads: hostLog.loads, navigated: hostLog.navigated })');
        output.results.push({ name, left: true, opened, ...hostState });
        continue;
      }
      // What a selection and an edit do to the frame: the app tracks the selected card,
      // and the edit's patch morphs the page from a new server rendering.
      const titleBefore = await pageJs('document.getElementById("title").textContent');
      await hostJs('(() => { const page = document.querySelector("iframe").contentWindow; page.postMessage({ type: "avb:track", paths: ["0", "0.1", "0.1.1"], scope: "", focus: "", focusOcc: 0 }, "*"); page.postMessage({ type: "avb:patch-now" }, "*"); return true; })()');
      await must({ what: name + ' morphed', read: soft(() => pageJs('record.morphs')), until: (morphs) => morphs >= 1 });
      const title = await pageJs('document.getElementById("title").textContent');
      const openAfterTick = await pageJs('modalOpen()');
      const record = await pageJs('({ frames: record.frames.join(""), delivered: record.delivered, morphs: record.morphs, removals: record.removals })');
      const firstOpen = record.frames.indexOf('1');
      const closedFrames = firstOpen < 0 ? 0 : [...record.frames.slice(firstOpen)].filter((frame) => frame === '0').length;
      const hostState = await hostJs('({ loads: hostLog.loads, selections: canvasHost.selections.map((entry) => entry.path), reloads: canvasHost.reloads })');
      output.results.push({
        name,
        opened,
        openAfterWait,
        openAfterTick,
        titleBefore,
        title,
        delivered: record.delivered,
        morphs: record.morphs,
        removals: record.removals,
        frameCount: record.frames.length,
        closedFrames,
        frames: record.frames,
        loads: hostState.loads.length,
        selections: hostState.selections,
        reloads: hostState.reloads,
      });
    }

    // A link card whose page leaves the click to the browser: the canvas follows it.
    output.plainLink = await followLink('link-card-page');
    output.stoppedLink = await followLink('link-card-stopped');
  } catch (error) {
    output.error = String((error && error.stack) || error);
  }
  console.log(JSON.stringify(output));
  win.destroy();
  server.close();
  app.quit();

  async function followLink(name) {
    await open(name);
    await pressCard();
    const landed = await must({
      what: 'the project page loaded',
      read: soft(() => hostJs('hostLog.loads')),
      until: (loads) => loads !== undefined && loads.length >= 2,
    });
    await must({ what: 'the project page announced', read: soft(() => hostJs('hostLog.navigated')), until: (paths) => paths !== undefined && paths.includes('/projects/p1/') });
    const after = await hostJs('({ loads: hostLog.loads, navigated: hostLog.navigated })');
    // A second load would show here: the bare address the browser follows, or a reload.
    await sleep(500);
    const settled = await hostJs('({ loads: hostLog.loads, navigated: hostLog.navigated })');
    const last = after.loads.at(-1) ?? '';
    return { landed: last.split('#')[0], hash: last.includes('#') ? last.slice(last.indexOf('#')) : '', loads: settled.loads.length, navigated: settled.navigated, seen: landed };
  }
});
`;
}
