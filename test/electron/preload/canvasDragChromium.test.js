// Dragging on the canvas, through the shipped chain, in the browser Desktop ships.
//
//   node test/electron/preload/canvasDragChromium.test.js
//
// Goal: a press on an element of the canvas that becomes a drag shows, while it lasts, where the element will land:
// an insertion line on the canvas (horizontal in a column, vertical in a row, inset to the target's content box),
// an empty container's placeholder, a refused target in red with its reason and a not-allowed cursor; and the
// Navigator, opened for the drag in place of the panel that was showing, marks the same place in the same frame,
// with the moved row muted and the target's rows opened. Escape and a release outside the frame cancel and put
// everything back; a release where the element already stands writes nothing; a real drop asks for exactly one move.
//
// Method: run under the Electron binary (Chromium's own layout, pointer capture and postMessage), with the real
// preload bundled fresh from source into the canvas iframe, and the real editor half (test/helpers/canvasDragHost.tsx:
// the message parser, the drag controller, the canvas overlay and the Navigator) in the host page. The page is shaped
// like the Lumos style guide: a section, a centred column Container holding the logo, the heading, a row of badge
// and link and an empty box, then an instance of a component without a slot. The model is the shipped parser's
// (dist/electron/parse/astroParser.js) for the same markup, so the canvas paths and the Navigator ids agree as they do
// in the app. Input is real: mouse events through the DevTools protocol, so the frame sees pointerdown, pointermove
// with the button held (also past its own edge) and pointerup. Every wait is a bounded poll for a condition, never
// a fixed pause. The host samples both pictures once per animation frame, so "same frame" is read, not assumed.
// Screenshots go to CANVAS_DRAG_SHOTS (a folder) when it is set.
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
    failures.push(`  ${what}${detail === undefined ? '' : `\n    ${detail}`}`);
  }
};

const SOURCE =
  "---\nimport Badge from '../components/Badge.astro';\n---\n" +
  '<section class="section"><div class="container"><img class="logo" alt="Lumos" /><h1>Style Guide</h1>' +
  '<div class="row"><span class="badge">v2.2.4</span><a href="/docs">View Docs</a></div><div class="empty"></div></div><Badge /></section>\n';
const stamp = `<!--avb-d:${'a'.repeat(64)}:src/pages/index.astro-->`;
const marked = (nodePath, html) => `<!--avb-s:${nodePath}-->${html}<!--avb-e:${nodePath}-->`;
const PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;font:16px/1.3 sans-serif;background:linear-gradient(90deg,#c6f24e,#d9e98a)}' +
  '.section{padding:32px 24px}.container{display:flex;flex-direction:column;align-items:center;gap:24px;padding:16px}' +
  '.logo{display:block;width:160px;height:40px;background:#111}h1{margin:0;font-size:64px;line-height:1}' +
  '.row{display:flex;gap:12px;align-items:center}.badge{background:#111;color:#fff;padding:6px 10px;border-radius:6px}' +
  '.empty{width:320px;min-height:48px;background:rgba(0,0,0,0.06)}.tag{display:block;margin:24px auto 0;width:200px;height:60px;background:#fff}' +
  '</style></head><body>' +
  marked(
    '0',
    '<section class="section">' +
      marked(
        '0.0',
        '<div class="container">' +
          marked('0.0.0', '<img class="logo" alt="Lumos">') +
          marked('0.0.1', '<h1>Style Guide</h1>') +
          marked(
            '0.0.2',
            '<div class="row">' + marked('0.0.2.0', '<span class="badge">v2.2.4</span>') + marked('0.0.2.1', '<a href="/docs">View Docs</a>') + '</div>',
          ) +
          marked('0.0.3', '<div class="empty"></div>') +
          '</div>',
      ) +
      marked('0.1', '<span class="tag">Badge</span>') +
      '</section>',
  ) +
  stamp +
  '</body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const SHOTS = process.env.CANVAS_DRAG_SHOTS || '';
const STAGE_LEFT = 300;
app.on('window-all-closed', () => {});
ipcMain.on('boot:read', (event) => { event.returnValue = undefined; });
const HOST = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0;background:#1e1e1e}' +
  'iframe{position:fixed;left:' + STAGE_LEFT + 'px;top:0;width:900px;height:640px;border:0}#ui{position:fixed;inset:0;pointer-events:none}#ui .left-panel{pointer-events:auto;background:var(--bg-panel,#222)}</style></head>' +
  '<body><iframe src="/page.html#avb-design"></iframe><div id="ui"></div><script src="/model.js"></script><script src="/host.js"></script></body></html>';
const poll = async (read, limit) => {
  for (let attempt = 0; attempt < limit; attempt++) {
    const value = await read();
    if (value) { return value; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
};
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(HOST); return; }
    const file = path.join(DIRECTORY, path.normalize(url.pathname));
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 1200, height: 640, useContentSize: true, webPreferences: { preload: path.join(DIRECTORY, 'preload.js'), contextIsolation: true, nodeIntegrationInSubFrames: true, backgroundThrottling: false } });
  const out = { steps: {}, error: undefined };
  const host = (code) => win.webContents.executeJavaScript(code);
  const frame = (code) => host('document.querySelector("iframe").contentWindow.eval(' + JSON.stringify(code) + ')');
  const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, name + '.png'), (await win.webContents.capturePage()).toPNG()); } };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    // The frame announces its rendering once; a host that started listening later asks again until it hears it.
    out.ready = await poll(() => host('(() => { if (window.canvasDragHost === undefined) { return false; } document.querySelector("iframe").contentWindow.postMessage({ type: "avb:request-render" }, "*"); return window.canvasDragHost.ready; })()'), 400);
    win.webContents.debugger.attach('1.3');
    let held = 0;
    const mouse = (type, x, y) => {
      if (type === 'mousePressed') { held = 1; }
      if (type === 'mouseReleased') { held = 0; }
      return win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: type === 'mouseMoved' && !held ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : held, clickCount: 1 });
    };
    const key = async (name, code) => {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: 27 });
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: 27 });
    };
    // Input reaches a new window only once it can take it: press on the left panel until the press is seen.
    await host('window.__downs = 0; window.addEventListener("pointerdown", () => { window.__downs += 1; }, true); 1');
    out.inputReady = await poll(async () => { await mouse('mouseMoved', 100, 600); await mouse('mousePressed', 100, 600); await mouse('mouseReleased', 100, 600); return host('window.__downs > 0'); }, 200);
    const box = (selector) => frame('(() => { const r = document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()');
    const boxes = { logo: await box('.logo'), heading: await box('h1'), badge: await box('.badge'), row: await box('.row'), link: await box('.row a'), empty: await box('.empty'), tag: await box('.tag'), container: await box('.container') };
    out.boxes = boxes;
    const at = (b, fx, fy) => ({ x: STAGE_LEFT + b.x + b.w * fx, y: b.y + b.h * fy });
    // A move counts once the editor has heard the frame's probe for that very point.
    const moveTo = async (point) => {
      await mouse('mouseMoved', point.x, point.y);
      return poll(() => host('(() => { const o = window.canvasDragHost.lastOver; return o !== undefined && Math.round(o.x) === ' + Math.round(point.x - STAGE_LEFT) + ' && Math.round(o.y) === ' + Math.round(point.y) + '; })()'), 200);
    };
    const startDrag = async (from) => {
      await mouse('mouseMoved', from.x, from.y);
      await mouse('mousePressed', from.x, from.y);
      const overs = await host('window.canvasDragHost.overs');
      for (let step = 1; step <= 4; step++) { await mouse('mouseMoved', from.x + step * 3, from.y + step * 3); }
      return poll(() => host('window.canvasDragHost.overs > ' + overs), 200);
    };
    const picture = () => host('(() => { const h = window.canvasDragHost; const s = h.samples[h.samples.length - 1]; const overlay = document.querySelector("[data-testid=canvas-drop]"); const reason = document.querySelector(".canvas-drop-reason"); const moving = document.querySelector(".structure-node.is-moving"); return { sample: s, verdict: overlay ? overlay.getAttribute("data-verdict") : undefined, reason: reason ? reason.textContent : undefined, chip: (document.querySelector(".canvas-drop-chip") || {}).textContent, tag: (document.querySelector(".canvas-drop-tag") || {}).textContent, moving: moving ? moving.getAttribute("data-node-id") : undefined, rows: Array.from(document.querySelectorAll(".structure-node[data-node-id]")).map((row) => row.getAttribute("data-node-id")), note: (document.querySelector(".navigator-drop-note") || {}).textContent, tab: h.tab, moves: h.moves.slice(), selected: h.selected }; })()');
    const settled = async (accept) => poll(async () => { const seen = await picture(); return accept(seen) ? seen : undefined; }, 200);
    const ids = await host('JSON.stringify(window.__canvasDragIds)');
    out.ids = JSON.parse(ids);
    const cursor = () => frame('(document.getElementById("avb-drag-cursor") || {}).textContent || ""');

    // A: press the heading and drag it to the top of the logo.
    out.steps.started = await startDrag(at(boxes.heading, 0.5, 0.5));
    await host('window.canvasDragHost.samples.length = 0; window.canvasDragHost.mutationFrames.overlay.length = 0; window.canvasDragHost.mutationFrames.navigator.length = 0; 1');
    await moveTo(at(boxes.logo, 0.5, 0.05));
    out.steps.before = await settled((seen) => seen.sample && seen.sample.line && seen.sample.gap);
    out.steps.beforeCursor = await cursor();
    await shot('canvas-drag-line-and-navigator');
    // B: over the badge's right half, in the row.
    await moveTo(at(boxes.badge, 0.9, 0.5));
    out.steps.row = await settled((seen) => seen.sample && seen.sample.line && seen.sample.line.orientation === 'vertical');
    // C: into the empty box.
    await moveTo(at(boxes.empty, 0.5, 0.5));
    out.steps.empty = await settled((seen) => seen.sample && seen.sample.empty);
    await shot('canvas-drag-into-container');
    out.frames = await host('({ samples: window.canvasDragHost.samples.slice(), mutations: window.canvasDragHost.mutationFrames })');
    // D: the middle of the slotless instance takes the drop beside it; over the heading itself the drop is refused.
    await moveTo(at(boxes.tag, 0.5, 0.4));
    out.steps.slotless = await settled((seen) => seen.verdict === 'valid' && seen.sample && seen.sample.gap && seen.sample.gap.parent === out.ids.section);
    await moveTo(at(boxes.heading, 0.5, 0.5));
    out.steps.refused = await settled((seen) => seen.verdict === 'refused');
    out.steps.refusedCursor = await poll(async () => { const text = await cursor(); return text.includes('not-allowed') ? text : undefined; }, 100);
    await shot('canvas-drag-invalid');
    // E: Escape cancels and puts everything back; the release that follows does nothing.
    await key('Escape', 'Escape');
    out.steps.escaped = await settled((seen) => seen.verdict === undefined && seen.tab === 'pages');
    await mouse('mouseReleased', at(boxes.tag, 0.5, 0.5).x, at(boxes.tag, 0.5, 0.5).y);
    out.steps.escapedCursor = await cursor();
    // F: a release outside the frame cancels.
    await startDrag(at(boxes.heading, 0.5, 0.5));
    await moveTo(at(boxes.logo, 0.5, 0.05));
    await mouse('mouseMoved', 120, 300);
    out.steps.outsideOver = await settled((seen) => seen.verdict === 'none');
    await mouse('mouseReleased', 120, 300);
    out.steps.outside = await settled((seen) => seen.verdict === undefined && seen.tab === 'pages');
    // G: with the Navigator already open, a drag opens the rows it needs and closes them again on Escape.
    await host('window.canvasDragHostOpenNavigator(); 1');
    out.steps.navigatorOpen = await settled((seen) => seen.tab === 'navigator' && seen.rows.length > 0);
    await startDrag(at(boxes.heading, 0.5, 0.5));
    await moveTo(at(boxes.logo, 0.5, 0.05));
    out.steps.opened = await settled((seen) => seen.sample && seen.sample.gap);
    await key('Escape', 'Escape');
    out.steps.closed = await settled((seen) => seen.verdict === undefined);
    await mouse('mouseReleased', 10, 10);
    // T: a hand trembling on the logo's midline, 2px either side, settles on one place instead of flipping.
    await startDrag(at(boxes.heading, 0.5, 0.5));
    const midline = at(boxes.logo, 0.5, 0.5);
    await moveTo({ x: midline.x, y: midline.y - 6 });
    await settled((seen) => seen.sample && seen.sample.gap);
    await host('window.canvasDragHost.samples.length = 0; 1');
    for (let wobble = 0; wobble < 24; wobble++) { await moveTo({ x: midline.x, y: midline.y + (wobble % 2 === 0 ? 2 : -2) }); }
    out.tremor = await host('window.canvasDragHost.samples.map((sample) => sample.gap ? sample.gap.parent + ":" + sample.gap.index : "none")');
    await key('Escape', 'Escape');
    await settled((seen) => seen.verdict === undefined);
    await mouse('mouseReleased', 10, 10);
    // H: a release where the heading already stands (just after the logo) writes nothing.
    await startDrag(at(boxes.heading, 0.5, 0.5));
    await moveTo(at(boxes.logo, 0.5, 0.95));
    out.steps.noopOver = await settled((seen) => seen.sample && seen.sample.line);
    await mouse('mouseReleased', at(boxes.logo, 0.5, 0.95).x, at(boxes.logo, 0.5, 0.95).y);
    out.steps.noop = await settled((seen) => seen.verdict === undefined);
    // I: a drop before the logo asks for one move, and the heading is the selection.
    await startDrag(at(boxes.heading, 0.5, 0.5));
    await moveTo(at(boxes.logo, 0.5, 0.05));
    await settled((seen) => seen.sample && seen.sample.gap);
    await mouse('mouseReleased', at(boxes.logo, 0.5, 0.05).x, at(boxes.logo, 0.5, 0.05).y);
    out.steps.dropped = await settled((seen) => seen.verdict === undefined && seen.moves.length > 0);
    out.reveals = await host('window.canvasDragHost.reveals');
    // N: a Navigator row dragged onto the canvas (a native drag: the frame sees dragover and drop) takes the same path.
    await host('window.canvasDragHostSetDrag(' + JSON.stringify(out.ids.empty) + '); 1');
    const nativeAt = { x: boxes.row.x + boxes.row.w / 2, y: boxes.row.y + 2 };
    const native = (type) => frame('(() => { const transfer = new DataTransfer(); transfer.setData("avb/node", ' + JSON.stringify(out.ids.empty) + '); const target = document.elementFromPoint(' + nativeAt.x + ', ' + nativeAt.y + '); target.dispatchEvent(new DragEvent(' + JSON.stringify(type) + ', { bubbles: true, cancelable: true, clientX: ' + nativeAt.x + ', clientY: ' + nativeAt.y + ', dataTransfer: transfer })); return true; })()');
    await native('dragover');
    out.steps.native = await settled((seen) => seen.verdict !== undefined && seen.sample && seen.sample.gap);
    await native('drop');
    out.steps.nativeDropped = await settled((seen) => seen.verdict === undefined && seen.moves.length > 1);
    await shot('canvas-drag-after-drop');
  } catch (error) { out.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(out));
  win.destroy(); server.close(); app.exit(0);
});`;

function idsOf(model) {
  const ids = {};
  const pending = model.nodes.map((node) => node);
  for (let visited = 0; visited < pending.length; visited++) {
    if (visited > 1000) {
      throw new Error('the fixture page is small');
    }
    const node = pending[visited];
    const name = node.kind === 'element' || node.kind === 'component' ? node.name : undefined;
    const className = node.props?.class?.type === 'string' ? node.props.class.value : undefined;
    const key = className ?? name;
    if (key !== undefined && ids[key] === undefined) {
      ids[key] = node.id;
    }
    pending.push(...(node.children ?? []));
  }
  return ids;
}

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string' || !fs.existsSync(repoPath('dist/electron/parse/astroParser.js'))) {
    console.log('canvas-drag-chromium: skipped  [needs the Electron binary and the built parser]');
    return;
  }
  const { parsePage } = require(repoPath('dist/electron/parse/astroParser.js'));
  const parsed = parsePage(SOURCE, { locs: false });
  const model = { nodes: parsed.model.nodes, imports: parsed.model.imports ?? [] };
  const ids = idsOf(model);
  const directory = repoPath('node_modules/.stacki-test/canvas-drag-chromium');
  fs.mkdirSync(directory, { recursive: true });
  esbuild.buildSync({
    entryPoints: [repoPath('electron/preload/preload.ts')],
    outfile: path.join(directory, 'preload.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: ['electron'],
    logLevel: 'silent',
    absWorkingDir: ROOT,
  });
  esbuild.buildSync({
    entryPoints: [repoPath('test/helpers/canvasDragHost.tsx')],
    outfile: path.join(directory, 'host.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    absWorkingDir: ROOT,
  });
  fs.writeFileSync(
    path.join(directory, 'app.css'),
    ['src/features/style/tokens.css', 'src/app/styles.css', 'src/features/preview/canvasDrop.css']
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(directory, 'model.js'),
    `window.__canvasDragModel = ${JSON.stringify(model)};\nwindow.__canvasDragIds = ${JSON.stringify(ids)};\n`,
  );
  fs.writeFileSync(path.join(directory, 'page.html'), PAGE);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 180_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  if (line === undefined) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 2000));
    report();
    return;
  }
  const out = JSON.parse(line.slice('RESULT '.length));
  if (process.env.CANVAS_DRAG_DEBUG) {
    console.log(JSON.stringify(out, null, 1).slice(0, 20000));
  }
  const steps = out.steps;
  const show = (value) => JSON.stringify(value)?.slice(0, 600);
  check('the probe ran to the end', out.error === undefined, out.error);
  check('the canvas and the input were ready', out.ready === true && out.inputReady === true, show(out));
  check('a press that moves becomes a drag the editor hears', steps.started === true, show(steps));
  // A: before the logo.
  const before = steps.before;
  check('A: the Navigator opened for the drag in place of Pages', before?.tab === 'navigator', show(before));
  check('A: the canvas line is horizontal in the column', before?.sample?.line?.orientation === 'horizontal', show(before));
  check(
    'A: the line sits at the top of the logo',
    before !== undefined && Math.abs(before.sample.line.y + before.sample.line.h / 2 - out.boxes.logo.y) <= 1.5,
    show({ line: before?.sample?.line, logo: out.boxes.logo }),
  );
  check(
    'A: the line is inset to the Container’s content box (16px padding)',
    before !== undefined &&
      Math.abs(before.sample.line.x - (out.boxes.container.x + 16)) <= 1 &&
      Math.abs(before.sample.line.w - (out.boxes.container.w - 32)) <= 1,
    show({ line: before?.sample?.line, container: out.boxes.container }),
  );
  check(
    'A: the Navigator marks the gap at index 0 of the Container',
    before?.sample?.gap?.parent === out.ids.container && before.sample.gap.index === 0,
    show(before?.sample),
  );
  check('A: the Container’s rows were opened so the mark shows', before?.rows?.includes(out.ids.logo), show(before?.rows));
  check('A: the heading’s row is marked as moving', before?.moving === out.ids.h1, show(before));
  check('A: the chip says an element is moving', before?.chip === 'Moving element', show(before));
  check('A: the target container is named', before?.tag === 'Container', show(before));
  check('A: the frame shows the grabbing cursor', String(steps.beforeCursor).includes('grabbing'), show(steps.beforeCursor));
  // B: the row.
  const row = steps.row;
  check(
    'B: in the row the line is vertical, between the badge and the link',
    row !== undefined && Math.abs(row.sample.line.x + row.sample.line.w / 2 - (out.boxes.badge.x + out.boxes.badge.w + out.boxes.link.x) / 2) <= 1.5,
    show({ row: row?.sample, boxes: out.boxes }),
  );
  check('B: the Navigator marks the gap at index 1 of the row', row?.sample?.gap?.parent === out.ids.row && row.sample.gap.index === 1, show(row?.sample));
  // C: into the empty box.
  check('C: the empty box shows the placeholder', steps.empty?.sample?.empty === true, show(steps.empty));
  check('C: the Navigator lights the empty box’s own row', steps.empty?.sample?.into === out.ids.empty, show(steps.empty?.sample));
  // Same frame: every sampled frame that shows a canvas mark shows the Navigator's matching mark, never the previous one.
  const samples = out.frames?.samples ?? [];
  const kindOf = (sample) => (sample.empty ? 'empty' : sample.line ? sample.line.orientation : 'none');
  const navOf = (sample) => (sample.into !== undefined ? `into:${sample.into}` : sample.gap ? `gap:${sample.gap.parent}:${sample.gap.index}` : 'none');
  const expected = { horizontal: `gap:${out.ids.container}:0`, vertical: `gap:${out.ids.row}:1`, empty: `into:${out.ids.empty}` };
  const mismatched = samples.filter((sample) => kindOf(sample) !== 'none' && navOf(sample) !== expected[kindOf(sample)]);
  check(
    'every frame: the Navigator shows the same place as the canvas (no frame lags)',
    samples.length > 0 && mismatched.length === 0,
    show({ frames: samples.length, mismatched: mismatched.slice(0, 3) }),
  );
  const overlayFrames = new Set(out.frames?.mutations?.overlay ?? []);
  const navigatorFrames = out.frames?.mutations?.navigator ?? [];
  const lagging = navigatorFrames.filter((frameNumber) => !overlayFrames.has(frameNumber));
  check(
    'every Navigator change landed in a frame the canvas also changed in',
    navigatorFrames.length > 0 && lagging.length === 0,
    show({ navigatorFrames, lagging }),
  );
  // D: refused.
  const refused = steps.refused;
  check('D: the middle of a slotless instance drops before it in its parent, no red', steps.slotless?.sample?.gap?.index === 1, show(steps.slotless));
  check('D: over itself the drop is refused, with the reason beside the pointer', refused?.reason?.includes('inside itself') === true, show(refused));
  check('D: over itself the Navigator shows no mark and says nothing', refused?.note === undefined && refused?.sample?.gap === undefined, show(refused));
  check('D: the frame shows the not-allowed cursor', typeof steps.refusedCursor === 'string', show(steps.refusedCursor));
  // E: Escape.
  check('E: Escape takes the drag away and gives Pages back', steps.escaped?.tab === 'pages' && steps.escaped.verdict === undefined, show(steps.escaped));
  check('E: Escape wrote nothing', steps.escaped?.moves?.length === 0, show(steps.escaped));
  check('E: the cursor is the editor’s again', steps.escapedCursor === '', show(steps.escapedCursor));
  // F: outside.
  check('F: past the frame’s edge the drop goes nowhere and says so', steps.outsideOver?.reason === 'Release to cancel', show(steps.outsideOver));
  check(
    'F: a release outside cancels, writes nothing and gives Pages back',
    steps.outside?.tab === 'pages' && steps.outside.moves.length === 0,
    show(steps.outside),
  );
  // G: rows opened for the drag close again.
  check(
    'G: the Navigator open before the drag shows the Container folded',
    steps.navigatorOpen !== undefined && !steps.navigatorOpen.rows.includes(out.ids.logo),
    show(steps.navigatorOpen),
  );
  check('G: the drag opens the Container', steps.opened?.rows?.includes(out.ids.logo) === true, show(steps.opened));
  check(
    'G: Escape folds it again and keeps the Navigator',
    steps.closed !== undefined && !steps.closed.rows.includes(out.ids.logo) && steps.closed.tab === 'navigator',
    show(steps.closed),
  );
  // T: tremor.
  const marks = out.tremor ?? [];
  const changes = marks.filter((mark, at) => at > 0 && mark !== marks[at - 1]).length;
  check(
    'T: a pointer trembling on a midline settles: the mark changes at most once',
    marks.length > 0 && changes <= 1,
    show({ changes, marks: [...new Set(marks)] }),
  );
  // H: no-op.
  check('H: just after the logo is where the heading stands: the line shows it', steps.noopOver?.sample?.line !== undefined, show(steps.noopOver));
  check('H: releasing there writes nothing', steps.noop?.moves?.length === 0, show(steps.noop));
  // I: the drop.
  const dropped = steps.dropped;
  check(
    'I: one move, the heading to index 0 of the Container',
    dropped?.moves?.length === 1 && dropped.moves[0].id === out.ids.h1 && dropped.moves[0].parentId === out.ids.container && dropped.moves[0].index === 0,
    show(dropped?.moves),
  );
  check(
    'I: the moved heading is the selection, and the Navigator was asked to reveal it',
    dropped?.selected === out.ids.h1 && out.reveals > 0,
    show({ selected: dropped?.selected, reveals: out.reveals }),
  );
  check('I: the Navigator, open before the drag, stays open', dropped?.tab === 'navigator', show(dropped));
  // N: native.
  check(
    'N: a row dragged onto the canvas shows the same line and mark, before the row',
    steps.native?.sample?.line?.orientation === 'horizontal' && steps.native.sample.gap?.parent === out.ids.container,
    show(steps.native),
  );
  const nativeMove = steps.nativeDropped?.moves?.[1];
  check(
    'N: its drop asks for one move to the place shown',
    nativeMove?.id === out.ids.empty && nativeMove.parentId === out.ids.container && nativeMove.index === 2,
    show(steps.nativeDropped?.moves),
  );
  report();
})();

function report() {
  if (failures.length > 0) {
    console.error(`canvas-drag-chromium: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`canvas-drag-chromium: ${checked} checks passed  [real preload, real controller, real overlay and Navigator]`);
  }
}
