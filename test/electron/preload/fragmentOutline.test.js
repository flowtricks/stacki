// A Fragment's outline wraps every child it renders, not the first one alone.
//
//   node test/electron/preload/fragmentOutline.test.js
//
// Goal: pin the bug where a `<Fragment slot="column2">` holding a Paragraph and a ButtonWrapper, selected in the
// navigator, drew its outline and "Fragment" tag around the paragraph only. A Fragment puts no element on the page;
// its markers are all that say where it is, and a component that renders its slot to a string and strips the
// comments (Lumos's slotContent) takes them away. The frame then derives the fragment from its children's tags
// (frameRegions.ts collectHollowRegions), and it split them into one "copy" per child, because each child also
// carries its own component's root path. The navigator selects copy zero, the paragraph. The outline must be the
// union of every rendered child (elements and the bare text between them), with display: none and 0px children left
// out, unless every child is 0px, which keeps the crosshair rule (collapsedRects).
//
// Methodology: the preload is bundled fresh from source into a scratch folder, as scripts/build/bundleClients.ts
// bundles it, so a stale dist/ cannot hide a regression. An Electron window (Chromium's own layout) serves each page
// from 127.0.0.1 inside an iframe the preload runs in; the host page (test/helpers/fragmentOutlineHost.tsx) tracks the
// fragment as a navigator selection does and draws the real overlay. Each page is shaped as the canvas receives it once
// the slot's comments are gone (plus one control whose markers survive). The expected box is computed in the page from
// the children the case marks `data-in` (and the bare text in a `data-text-in` holder): min and max of their boxes.
// The drawn outline is read back from the overlay's DOM. Then a real pointer move over one child must draw that
// child's own hover outline. Every wait is a bounded poll. Set FRAGMENT_SHOTS to a folder to keep screenshots of the
// stacked, side-by-side and nested cases.
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

// The fragment is 0.0.1: the second child of the split ContentWrapper (0.0) in the section (0), as in the bug's page.
const FRAGMENT = '0.0.1';
const stamp = `<!--avb-d:${'a'.repeat(64)}:src/pages/index.astro-->`;
const STYLE =
  '<style>html,body{margin:0;font:16px/1.4 sans-serif;background:#fff;color:#111}.layout{display:flex;gap:48px;padding:40px}.layout>*{flex:1;display:flex;flex-direction:column}' +
  '.row{flex-direction:row!important;gap:32px;align-items:flex-start}.button-wrapper{margin-top:24px}.button-wrapper a{display:inline-block;padding:8px 0}' +
  '.empty{width:0;height:0}</style>';
// A page as the canvas gets it after a slot-scrubbing component rendered the fragment's column: the section keeps its
// marker pair, the fragment's markers and its children's own markers are gone, and the paths ride on the tags.
const page = (column, columnClass = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${STYLE}</head><body><!--avb-s:0--><section data-avb-p="0">` +
  `<div class="layout split" data-avb-p="0.0 ContentWrapper.astro|0"><div><h2 data-avb-p="0.0.0 Heading.astro|0">From idea to impact, faster</h2></div>` +
  `<div class="${columnClass}">${column}</div></div></section><!--avb-e:0-->${stamp}</body></html>`;
const paragraph = (nodePath, extra = '') =>
  `<p data-in data-avb-p="Paragraph.astro|0 ${nodePath}"${extra}>Webflow's agentic AI works alongside your team, drafting copy, generating pages, running experiments.</p>`;
const buttonWrapper = (nodePath) =>
  `<div class="button-wrapper" data-in data-avb-p="ButtonWrapper.astro|0 ${nodePath}"><a href="#" data-avb-p="Button.astro|0 ${nodePath}.0">Discover Webflow AI →</a></div>`;
const childOf = (index) => `${FRAGMENT}.${index}`;

const CASES = {
  stacked: { html: page(paragraph(childOf(0)) + buttonWrapper(childOf(1))), hover: childOf(0), shot: true },
  'side-by-side': { html: page(paragraph(childOf(0), ' style="max-width:260px"') + buttonWrapper(childOf(1)), 'row'), hover: childOf(0), shot: true },
  'text-between': {
    html: page(
      `<span data-in data-avb-p="${childOf(0)}">Lead</span> bare text the fragment writes between its two children, wider than either <span data-in data-avb-p="${childOf(2)}">Tail</span>`,
    ).replace('<div class="">', '<div class="" data-text-in style="display:block">'),
    hover: childOf(0),
  },
  'marked-mixed': {
    // Control: the fragment's markers survived (no scrubbing slot), with bare text first and last.
    html: page(
      `<!--avb-s:${FRAGMENT}-->Opening words <strong data-in data-avb-p="${childOf(1)}">bold</strong> closing words that run on longer<!--avb-e:${FRAGMENT}-->`,
    ).replace('<div class="">', '<div class="" data-text-in style="display:block">'),
    hover: childOf(1),
  },
  'loop-child': {
    html: page(
      [0, 1, 2].map((item) => `<div data-in data-avb-p="Card.astro|0 ${childOf(0)}.0" style="padding:8px;background:#eef">Card ${item + 1}</div>`).join('') +
        buttonWrapper(childOf(1)),
    ),
    hover: `${childOf(0)}.0`,
  },
  nested: {
    html: page(paragraph(childOf(0)) + paragraph(`${childOf(1)}.0`, ' style="color:#555"') + buttonWrapper(`${childOf(1)}.1`)),
    hover: childOf(0),
    inner: { path: childOf(1), from: 1 },
    shot: true,
  },
  'multi-root-children': {
    // Each child is a component with two roots, both spreading the caller's path.
    html: page(
      `<h3 data-in data-avb-p="Pair.astro|0 ${childOf(0)}">First pair</h3><p data-in data-avb-p="Pair.astro|1 ${childOf(0)}">its second root</p>` +
        `<h3 data-in data-avb-p="Pair.astro|0 ${childOf(1)}">Second pair</h3><p data-in data-avb-p="Pair.astro|1 ${childOf(1)}" style="width:420px">its second root, wider</p>`,
    ),
    hover: childOf(0),
  },
  'display-none-child': {
    html: page(
      paragraph(childOf(0)) + `<div data-avb-p="${childOf(1)}" style="display:none;width:900px;height:400px">hidden</div>` + buttonWrapper(childOf(2)),
    ),
    hover: childOf(0),
  },
  'collapsed-child': {
    html: page(paragraph(childOf(0), ' style="max-width:200px"') + buttonWrapper(childOf(1)) + `<div class="empty" data-avb-p="${childOf(2)}"></div>`, 'row'),
    hover: childOf(0),
  },
  'all-collapsed': {
    html: page(`<div class="empty" data-avb-p="${childOf(0)}"></div><div class="empty" data-avb-p="${childOf(1)}"></div>`, 'row'),
    collapsed: true,
  },
};

const LABELS = JSON.stringify({ [FRAGMENT]: 'Fragment', [childOf(1)]: 'Fragment' });

const PROBE = (directory) => `
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const SHOTS = process.env.FRAGMENT_SHOTS;
const CASES = ${JSON.stringify(Object.fromEntries(Object.entries(CASES).map(([name, item]) => [name, { hover: item.hover, inner: item.inner, shot: item.shot === true }])))};
app.on('window-all-closed', () => {});
ipcMain.on('boot:read', (event) => { event.returnValue = undefined; });
const host = (name) => '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>html,body{margin:0}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}#overlay{position:fixed;inset:0;pointer-events:none}#overlay>*{position:absolute}</style></head><body><iframe src="/pages/' + name + '.html#avb-design"></iframe><div id="overlay"></div><script src="/host.js"></script></body></html>';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The union of what the case marks as inside: elements with data-in, and the bare text of a data-text-in holder.
const EXPECTED = '(() => { const d = document.querySelector("iframe").contentDocument; const boxes = []; for (const e of d.querySelectorAll("[data-in]")) { const r = e.getBoundingClientRect(); boxes.push(r); } for (const holder of d.querySelectorAll("[data-text-in]")) { for (const n of holder.childNodes) { if (n.nodeType === 3 && n.textContent.trim()) { const range = d.createRange(); range.selectNode(n); boxes.push(range.getBoundingClientRect()); } } } const sized = boxes.filter((r) => r.width > 0 && r.height > 0); if (!sized.length) { return undefined; } const left = Math.min(...sized.map((r) => r.left)); const top = Math.min(...sized.map((r) => r.top)); return { x: left, y: top, w: Math.max(...sized.map((r) => r.right)) - left, h: Math.max(...sized.map((r) => r.bottom)) - top, count: sized.length }; })()';
const DRAWN = (kind) => '(() => { const all = Array.from(document.querySelectorAll(".node-outline.' + kind + '")); return all.map((o) => { const b = o.getBoundingClientRect(); const t = o.querySelector(".node-outline-tag"); const g = t && t.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, className: o.className, tag: t ? t.textContent : undefined, tagBox: g ? { x: g.x, y: g.y, w: g.width, h: g.height } : undefined }; }); })()';
const childBox = (nodePath) => '(() => { const d = document.querySelector("iframe").contentDocument; const e = Array.from(d.querySelectorAll("[data-avb-p]")).find((x) => (x.getAttribute("data-avb-p") || "").split(" ").includes(' + JSON.stringify(nodePath) + ')); if (!e) { return undefined; } const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()';
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/host/')) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(host(url.pathname.slice('/host/'.length)));
      return;
    }
    const file = path.join(DIRECTORY, path.normalize(url.pathname));
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const results = {};
  for (const [name, item] of Object.entries(CASES)) {
    const selections = [${JSON.stringify(FRAGMENT)}].concat(item.inner ? [item.inner.path] : []);
    results[name] = {};
    for (const selected of selections) {
      // A window per selection: each starts from a frame that has never been told what to track.
      const win = new BrowserWindow({ show: false, width: 1000, height: 560, webPreferences: { preload: path.join(DIRECTORY, 'preload.js'), contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true } });
      await win.loadURL(origin + '/host/' + name + '?path=' + encodeURIComponent(selected) + '&labels=' + encodeURIComponent(${JSON.stringify(LABELS)}));
      let drawn = [];
      for (let attempt = 0; attempt < 100 && drawn.length === 0; attempt++) {
        await sleep(50);
        drawn = await win.webContents.executeJavaScript(DRAWN('sel'));
      }
      const seen = { selected: drawn, expected: await win.webContents.executeJavaScript(EXPECTED), reported: await win.webContents.executeJavaScript('window.fragmentHost.rects[' + JSON.stringify(selected) + ']') };
      if (selected !== ${JSON.stringify(FRAGMENT)}) {
        seen.expected = await win.webContents.executeJavaScript('(() => { const d = document.querySelector("iframe").contentDocument; const boxes = Array.from(d.querySelectorAll("[data-avb-p]")).filter((e) => (e.getAttribute("data-avb-p") || "").split(" ").some((p) => p.startsWith(' + JSON.stringify(selected + '.') + ') && p.split(".").length === ' + (selected.split('.').length + 1) + ')).map((e) => e.getBoundingClientRect()); const left = Math.min(...boxes.map((r) => r.left)); const top = Math.min(...boxes.map((r) => r.top)); return { x: left, y: top, w: Math.max(...boxes.map((r) => r.right)) - left, h: Math.max(...boxes.map((r) => r.bottom)) - top, count: boxes.length }; })()');
      }
      if (item.hover && selected === ${JSON.stringify(FRAGMENT)}) {
        const child = await win.webContents.executeJavaScript(childBox(item.hover));
        if (child) {
          const x = Math.round(child.x + Math.min(child.w / 2, 20));
          const y = Math.round(child.y + child.h / 2);
          let hovered = [];
          for (let attempt = 0; attempt < 60 && hovered.length === 0; attempt++) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: x + (attempt % 2), y });
            await sleep(50);
            hovered = await win.webContents.executeJavaScript(DRAWN('hover'));
          }
          seen.hover = { child, path: await win.webContents.executeJavaScript('window.fragmentHost.hoverPath'), drawn: hovered };
        }
      }
      if (SHOTS && item.shot) {
        fs.mkdirSync(SHOTS, { recursive: true });
        // The shot shows the selection alone: the pointer leaves the canvas first.
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 999, y: 559 });
        await sleep(150);
        fs.writeFileSync(path.join(SHOTS, 'fragment-' + name + (selected === ${JSON.stringify(FRAGMENT)} ? '' : '-inner') + '.png'), (await win.webContents.capturePage()).toPNG());
      }
      results[name][selected] = seen;
      win.destroy();
    }
  }
  console.log('RESULT ' + JSON.stringify(results));
  app.exit(0);
});`;

const near = (left, right) => Math.abs(left - right) <= 1;
const sameBox = (left, right) =>
  left !== undefined && right !== undefined && near(left.x, right.x) && near(left.y, right.y) && near(left.w, right.w) && near(left.h, right.h);

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('fragment-outline: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/fragment-outline');
  fs.mkdirSync(path.join(directory, 'pages'), { recursive: true });
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
    entryPoints: [repoPath('test/helpers/fragmentOutlineHost.tsx')],
    outfile: path.join(directory, 'host.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    logLevel: 'silent',
    absWorkingDir: ROOT,
  });
  fs.writeFileSync(
    path.join(directory, 'app.css'),
    ['src/features/style/tokens.css', 'src/app/styles.css'].map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n'),
  );
  for (const [name, item] of Object.entries(CASES)) {
    fs.writeFileSync(path.join(directory, 'pages', `${name}.html`), item.html);
  }
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 180_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 2000));
  } else {
    const results = JSON.parse(line.slice('RESULT '.length));
    for (const [name, item] of Object.entries(CASES)) {
      const seen = results[name][FRAGMENT];
      const detail = JSON.stringify(seen);
      check(`${name}: one selection outline is drawn`, seen.selected.length === 1, detail);
      const [outline] = seen.selected;
      if (outline === undefined) {
        continue;
      }
      check(`${name}: the tag names the Fragment`, outline.tag === 'Fragment', detail);
      if (item.collapsed) {
        // The existing 0px rule: each collapsed child reports its point, and the first is drawn.
        check(`${name}: every child is 0px, so the outline is the crosshair`, outline.className.includes('is-point'), detail);
        continue;
      }
      check(`${name}: the frame reported one box for the fragment`, (seen.reported ?? []).length === 1, detail);
      check(`${name}: the outline is the union of every rendered child`, sameBox(outline, seen.expected), detail);
      check(`${name}: the union is made of more than one child`, (seen.expected?.count ?? 0) > 1, detail);
      check(`${name}: the tag sits at the union's left edge`, outline.tagBox !== undefined && near(outline.tagBox.x, outline.x), detail);
      if (item.hover) {
        check(`${name}: a pointer over a child hovers that child`, seen.hover?.path === item.hover, detail);
        check(`${name}: one hover outline is drawn`, seen.hover?.drawn.length === 1, detail);
        check(`${name}: the hover outline is the child's own box, not the fragment's`, sameBox(seen.hover?.drawn[0], seen.hover?.child), detail);
      }
      if (item.inner) {
        const inner = results[name][item.inner.path];
        const innerDetail = JSON.stringify(inner);
        check(`${name}: the inner fragment draws one outline`, inner.selected.length === 1, innerDetail);
        check(`${name}: the inner fragment's outline is the union of its own children`, sameBox(inner.selected[0], inner.expected), innerDetail);
        check(
          `${name}: the inner fragment's outline lies inside the outer one`,
          inner.selected[0] !== undefined && inner.selected[0].y >= outline.y - 1,
          innerDetail,
        );
      }
    }
  }
  if (failures.length) {
    console.error(`fragment-outline: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`fragment-outline: ${checked} checks passed  [real preload, real layout, real overlay]`);
  }
})();
