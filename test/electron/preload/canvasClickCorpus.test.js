// A click on the canvas always selects something, over every page shape a
// real site has, in a real browser (docs/canvas-click.md).
//
//   node test/electron/preload/canvasClickCorpus.test.js
//
// Goal: for each catalogued page shape — overlays with and without pointer
// events, a fixed header on a scrolled page, transforms, shadow DOM, SVG, an
// embedded document, page scripts that stop or cancel the pointer's events,
// markup a script made or replaced, the dialog top layer, `display: contents`,
// bare text, several roots, a ClientRouter swap, a page showing something other
// than the open file, and a rendering that mixes file versions — a click
// selects the element the pointer is over (or the documented fallback, its
// nearest element a file wrote, or the page), a hover outlines the same thing,
// and no click ends in a notice the canvas could have avoided. A seeded
// randomized run then clicks while the page is patched again and again (the
// HMR churn of an editing session) and holds the invariant: every click
// selects what is under it, and nothing is said.
//
// Methodology: run under the Electron binary, so layout, hit testing and
// postMessage are Chromium's own. A local server on 127.0.0.1 serves each
// fixture page with Stacki's markers and stamps; the host page embeds it in an
// iframe the real built preload runs in (as Desktop's window runs it), and runs
// the real message parser and click ladder (test/helpers/canvasClickHost.ts).
// Pointer events are dispatched at points in the page, at the element the
// browser hit-tests there, since a hidden window on Linux (xvfb) and Windows
// receives no native input; on macOS native
// pointer moves (sendInputEvent), which a hidden window there does take, check
// the hover outline with the real pointer. Every wait is a bounded poll on what the host
// recorded (test/helpers/waitFor.js), never a fixed sleep.
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

const PAGE_FILE = 'src/pages/index.astro';
const LAYOUT_FILE = 'src/layouts/Base.astro';
const stamp = (file, digit = 'a') => `<!--avb-d:${digit.repeat(64)}:${file}-->`;
const PAGE_STAMP = stamp(PAGE_FILE);
const LAYOUT_STAMP = stamp(LAYOUT_FILE, 'e');
const BASE_STYLE = '<style>html,body{margin:0;font:16px/1.4 sans-serif} section,div,p,h1,h2{margin:0}</style>';
const page = (body, { head = '', stamps = PAGE_STAMP } = {}) =>
  `<!doctype html><html><head><meta charset="utf-8">${BASE_STYLE}${head}</head><body>${body}${stamps}${LAYOUT_STAMP}</body></html>`;
const marked = (nodePath, html) => `<!--avb-s:${nodePath}-->${html}<!--avb-e:${nodePath}-->`;

// Each case: a page, then clicks at `#id` centres (or explicit points) with the
// path the click must select. `prepare` runs in the page before the clicks.
const CORPUS = [
  {
    name: 'plain',
    html: page(marked('0', '<h1 id="title" style="height:80px">Title</h1>')),
    clicks: [{ at: '#title', expect: '0' }],
  },
  {
    name: 'overlay-without-pointer-events',
    html: page(
      marked(
        '0',
        '<section style="position:relative;height:200px">' +
          marked('0.0', '<h1 id="title" style="height:80px">Under glass</h1>') +
          '<div style="position:absolute;inset:0;background:rgba(0,0,0,.2);pointer-events:none"></div></section>',
      ),
    ),
    clicks: [{ at: '#title', expect: '0.0' }],
  },
  {
    name: 'overlay-a-script-laid',
    html: page(
      marked(
        '0',
        '<section id="hero" style="position:relative;height:200px">' + marked('0.0', '<h1 id="title" style="height:80px">Behind a catcher</h1>') + '</section>',
      ),
      {
        head: '<script>addEventListener("DOMContentLoaded",()=>{const d=document.createElement("div");d.style.cssText="position:fixed;inset:0;z-index:9";document.body.appendChild(d)})</script>',
      },
    ),
    clicks: [{ at: '#title', expect: '0.0' }],
  },
  {
    name: 'fixed-header-scrolled',
    html: page(
      marked('0', '<header id="bar" style="position:fixed;top:0;left:0;right:0;height:60px;background:#eee;z-index:2">Bar</header>') +
        marked(
          '1',
          '<main style="padding-top:60px">' +
            marked('1.0', '<div style="height:900px">Tall</div>') +
            marked('1.1', '<p id="deep" style="height:200px">Deep</p>') +
            '</main>',
        ),
    ),
    prepare: 'scrollTo(0, 700)',
    clicks: [
      { at: '#bar', expect: '0' },
      { at: '#deep', expect: '1.1' },
    ],
  },
  {
    name: 'transformed',
    html: page(
      marked(
        '0',
        '<div style="transform:scale(.5) translate(40px,40px);transform-origin:0 0;width:800px">' +
          marked('0.0', '<p id="small" style="height:120px">Scaled</p>') +
          '</div>',
      ),
    ),
    clicks: [{ at: '#small', expect: '0.0' }],
  },
  {
    name: 'shadow-dom',
    html: page(marked('0', '<x-card id="card" style="display:block;height:120px"></x-card>'), {
      head: '<script>customElements.define("x-card",class extends HTMLElement{connectedCallback(){this.attachShadow({mode:"open"}).innerHTML="<p style=\\"height:100px\\">Inside the shadow</p>"}})</script>',
    }),
    clicks: [{ at: '#card', expect: '0' }],
  },
  {
    name: 'svg',
    html: page(marked('0', '<svg id="art" width="200" height="200"><circle cx="100" cy="100" r="90" fill="teal"/></svg>')),
    clicks: [{ at: '#art', expect: '0' }],
  },
  {
    name: 'embedded-document',
    html: page(
      marked(
        '0',
        '<section style="padding:20px">' +
          marked('0.0', '<iframe id="embed" srcdoc="<p>An embed</p>" style="width:300px;height:150px;border:0"></iframe>') +
          '</section>',
      ),
    ),
    clicks: [{ at: '#embed', expect: '0.0' }],
  },
  {
    name: 'hostile-page-scripts',
    html: page(marked('0', '<button id="go" style="height:60px">Go</button>'), {
      head:
        '<script>for (const type of ["mousemove","mousedown","mouseup","click","pointerdown"]) {' +
        'document.addEventListener(type,(e)=>{e.stopImmediatePropagation();e.preventDefault()},true);' +
        'addEventListener(type,(e)=>{e.stopPropagation()})}</script>',
    }),
    clicks: [{ at: '#go', expect: '0' }],
  },
  {
    name: 'generated-markup',
    html: page(marked('0', '<section id="list" style="min-height:40px"></section>'), {
      head: '<script>addEventListener("DOMContentLoaded",()=>{document.getElementById("list").innerHTML="<div id=\\"made\\" style=\\"height:80px\\">Made by a script</div>"})</script>',
    }),
    clicks: [{ at: '#made', expect: '0' }],
  },
  {
    name: 'island-replaces-on-press',
    html: page(marked('0', '<section id="island">' + marked('0.0', '<h2 id="swap" style="height:80px">Hydrating</h2>') + '</section>'), {
      head: '<script>addEventListener("mousedown",()=>{const old=document.getElementById("swap");if(old){const fresh=document.createElement("h2");fresh.id="swapped";fresh.style.height="80px";fresh.textContent="Hydrated";old.replaceWith(fresh)}},true)</script>',
    }),
    // The hover outlined the heading that was there; the press replaced it with
    // markup no file wrote, so the click selects the nearest element one did.
    clicks: [{ at: '#swap', expect: '0', hover: '0.0' }],
  },
  {
    name: 'dialog-top-layer',
    html: page(marked('0', '<dialog id="modal">' + marked('0.0', '<p id="inside" style="height:60px;width:200px">In the top layer</p>') + '</dialog>')),
    prepare: 'document.getElementById("modal").showModal()',
    clicks: [{ at: '#inside', expect: '0.0' }],
  },
  {
    name: 'display-contents',
    html: page(marked('0', '<div style="display:contents">' + marked('0.0', '<p id="child" style="height:60px">Child of a box-less parent</p>') + '</div>')),
    clicks: [{ at: '#child', expect: '0.0' }],
  },
  {
    name: 'bare-text',
    html: page(marked('0', '<p id="words" style="height:60px">Just words, no element of their own</p>')),
    clicks: [{ at: '#words', expect: '0' }],
  },
  {
    name: 'several-roots',
    html: page(marked('0', '<section id="first" style="height:100px">One</section>') + marked('1', '<section id="second" style="height:100px">Two</section>')),
    clicks: [
      { at: '#first', expect: '0' },
      { at: '#second', expect: '1' },
    ],
  },
  {
    name: 'client-router-swap',
    html: page(marked('0', '<h1 id="home" style="height:80px">Home</h1>')),
    prepare:
      `document.body.innerHTML = ${JSON.stringify(marked('0', '<section id="about" style="height:120px">' + marked('0.0', '<h2 id="team" style="height:60px">Team</h2>') + '</section>') + stamp(PAGE_FILE, 'b') + LAYOUT_STAMP)};` +
      "document.dispatchEvent(new Event('astro:after-swap'))",
    awaitRenders: 2,
    clicks: [{ at: '#team', expect: '0.0' }],
  },
  {
    name: 'showing-another-page',
    // An error page, a 404, a redirect: the layout rendered, the open file did not.
    html: page(marked('src/layouts/Base.astro|0', '<h1 id="oops" style="height:80px">Something went wrong</h1>'), { stamps: '' }),
    openFile: PAGE_FILE,
    clicks: [{ at: '#oops', expect: undefined, kind: 'page', notice: 'other-page' }],
  },
];

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('canvas-click-corpus: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/canvas-click-corpus');
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
  for (const entry of CORPUS) {
    fs.writeFileSync(path.join(directory, 'pages', `${entry.name}.html`), entry.html);
  }
  // The churn page: thirty items the randomized run clicks while the page is patched.
  const items = Array.from({ length: 30 }, (_, index) => marked(`0.${index}`, `<div id="item${index}" style="height:24px">Item ${index}</div>`)).join('');
  fs.writeFileSync(path.join(directory, 'pages', 'churn.html'), page(marked('0', `<section>${items}</section>`)));
  fs.writeFileSync(
    path.join(directory, 'pages', 'mixed-versions.html'),
    page(marked('0', '<h1 id="title" style="height:80px">Mixed</h1>'), { stamps: PAGE_STAMP + stamp(PAGE_FILE, 'c') }),
  );
  fs.writeFileSync(
    path.join(directory, 'scenarios.json'),
    JSON.stringify(CORPUS.map(({ name, prepare, clicks, openFile, awaitRenders }) => ({ name, prepare, clicks, openFile, awaitRenders }))),
  );
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 240_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{"results"'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 2000));
  } else {
    report(JSON.parse(line));
  }
  if (failures.length) {
    console.error(`canvas-click-corpus: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`canvas-click-corpus: ${checked} checks passed`);
  }
})();

function report({ results, churn, mixed, native, lost, error }) {
  check('the probe ran to the end', error === undefined, error);
  if (error !== undefined) {
    return;
  }
  check('a lost announcement: the click still selects', lost.selection?.path === '0', JSON.stringify(lost));
  check('a lost announcement: healed without a reload', lost.reloads === 0, JSON.stringify(lost));
  check('a lost announcement: nothing is said', lost.notices.length === 0, JSON.stringify(lost));
  for (const result of results) {
    const scenario = CORPUS.find((entry) => entry.name === result.name);
    for (const [index, click] of scenario.clicks.entries()) {
      const seen = result.clicks[index];
      const label = `${result.name} ${click.at}`;
      check(`${label}: the click selects`, seen?.selection !== undefined, JSON.stringify(result));
      if (seen?.selection === undefined) {
        continue;
      }
      check(`${label}: selects ${click.expect ?? 'the page'}`, seen.selection.path === click.expect, JSON.stringify(seen));
      check(`${label}: as a ${click.kind ?? 'node'}`, seen.selection.kind === (click.kind ?? 'node'), JSON.stringify(seen));
      if (click.kind !== 'page') {
        check(`${label}: the hover outlines the same thing`, seen.hover === (click.hover ?? click.expect), JSON.stringify(seen));
      }
    }
    const shows = result.notices.filter((event) => event.kind === 'show');
    const expected = scenario.clicks.map((click) => click.notice).filter(Boolean);
    check(
      `${result.name}: notices`,
      JSON.stringify(shows.map((event) => event.notice.kind)) === JSON.stringify([...new Set(expected)]),
      JSON.stringify(result.notices),
    );
    check(`${result.name}: no reload`, result.reloads === 0, JSON.stringify(result));
  }
  check('churn: every click selected what was under it', churn.wrong.length === 0 && churn.missing.length === 0, JSON.stringify(churn));
  check(
    'churn: the page really was patched under the clicks',
    churn.renders > churn.clicks / 2,
    JSON.stringify({ renders: churn.renders, clicks: churn.clicks }),
  );
  check('churn: some clicks had to be looked at again', churn.retried > 0, JSON.stringify(churn));
  check('churn: nothing was said', churn.notices === 0, JSON.stringify(churn));
  check('mixed versions: the frame said why it cannot vouch', mixed.problems.includes('conflicting-stamps'), JSON.stringify(mixed));
  check('mixed versions: one reload, not a loop', mixed.reloads === 1, JSON.stringify(mixed));
  check('mixed versions: hovers still outline', mixed.hover === '0', JSON.stringify(mixed));
  if (native !== undefined) {
    for (const entry of native) {
      check(`native input ${entry.name}: the hover outlines ${entry.expect}`, entry.hover === entry.expect, JSON.stringify(entry));
    }
  }
}

// The Electron side. A string, so the probe runs under the Electron binary
// with nothing of this file's Node process.
function PROBE(directory) {
  return `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
const DIRECTORY = ${JSON.stringify(directory)};
const PRELOAD = ${JSON.stringify(repoPath('dist/electron/preload/preload.js'))};
const scenarios = JSON.parse(fs.readFileSync(path.join(DIRECTORY, 'scenarios.json'), 'utf8'));
app.on('window-all-closed', () => {});

const host = (pageName, openFile) => '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head>' +
  '<body><iframe data-src="/pages/' + pageName + '.html#avb-design"></iframe>' +
  '<script>window.openFileForHost=' + JSON.stringify(openFile ?? null) + '</script><script src="/host.js"></script>' +
  '<script>canvasHost.openFile = window.openFileForHost ?? undefined</script></body></html>';

// Seeded, so a failure names its run.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/host/')) {
      const name = url.pathname.slice('/host/'.length);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(host(name, url.searchParams.get('open') ?? undefined));
      return;
    }
    const file = path.join(DIRECTORY, path.normalize(url.pathname).replace(/^([/\\\\])+/, ''));
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true },
  });
  // Every call into a page is bounded: a frame that is reloading (the ladder's
  // own reload, a page navigating) can drop a call without ever answering it,
  // which left the probe waiting until the spawn bound killed it.
  const CALL_MS_MAX = 5000;
  const bounded = (call, what) =>
    Promise.race([call, new Promise((_, reject) => setTimeout(() => reject(new Error(what + ': no answer in ' + CALL_MS_MAX + ' ms')), CALL_MS_MAX))]);
  const hostJs = (code) => bounded(win.webContents.executeJavaScript(code), 'host');
  // Page code runs through the host, in the iframe's own realm (same origin):
  // a subframe's WebFrameMain can be swapped by a navigation and then never
  // answer, where the host's reference to the iframe always names the live page.
  // The answer crosses back as JSON: a page value from another realm is not
  // always structured-clonable.
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
  // A read for a poll: a call that failed reads as nothing yet, and the poll goes on.
  const soft = (read) => () => read().catch(() => undefined);
  const readState = () => hostJs('JSON.parse(JSON.stringify(canvasHost))');
  const state = soft(readState);
  // Opens a page and waits, bounded, until its frame has vouched for it (or
  // said why it cannot). A page that never does is a failure, said as one.
  const open = async (name, openFile, { dropRenders = 0 } = {}) => {
    const query = new URLSearchParams();
    if (openFile) {
      query.set('open', openFile);
    }
    if (dropRenders > 0) {
      query.set('drop-renders', String(dropRenders));
    }
    await win.loadURL(origin + '/host/' + name + '?' + query.toString());
    if (dropRenders > 0) {
      await pollUntil({ what: name + ' framed', read: soft(() => pageJs('document.readyState')), until: (value) => value === 'complete' });
      return;
    }
    const vouched = await pollUntil({ what: name + ' vouched for', read: state, until: (seen) => seen !== undefined && (seen.renders >= 1 || seen.problems.length > 0) });
    if (vouched.kind !== 'reached') {
      throw new Error(name + ': the frame never vouched for its rendering: ' + JSON.stringify(vouched.value));
    }
  };
  const centre = (selector) =>
    // From the element's live box at click time, brought into view first: a
    // runner's window can be shorter than asked for, and fonts change heights.
    pageJs('(() => { const element = document.querySelector(' + JSON.stringify(selector) + '); if (!element) { return undefined; } const box = element.getBoundingClientRect(); if (box.top < 0 || box.bottom > innerHeight) { if (getComputedStyle(element).position !== "fixed") { element.scrollIntoView({ block: "center" }); } } const live = element.getBoundingClientRect(); const x = Math.round(live.left + Math.min(live.width / 2, 40)); const y = Math.round(live.top + live.height / 2); return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? { x, y } : undefined; })()');
  // Pointer events as the browser would deliver them to whatever it hit-tests at the point.
  const press = (point) =>
    pageJs('(() => { const x = ' + point.x + ', y = ' + point.y + '; const target = document.elementFromPoint(x, y); if (!target) { throw new Error("nothing at " + x + "," + y); } const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 }; for (const type of ["mousemove", "mousedown", "mouseup"]) { target.dispatchEvent(new MouseEvent(type, init)); } (document.elementFromPoint(x, y) ?? target).dispatchEvent(new MouseEvent("click", { ...init, detail: 1 })); return true; })()');
  const clickAndSee = async (point, deliver) => {
    const before = await readState();
    await deliver(point);
    const seen = await pollUntil({ what: 'a selection', read: state, until: (now) => now !== undefined && now.selections.length > before.selections.length, pollCountMax: 300 });
    const selected = seen.kind === 'reached';
    return { selection: selected ? seen.value.selections.at(-1) : undefined, hover: seen.value?.hovers.at(-1), point };
  };
  const output = { results: [], churn: undefined, mixed: undefined, native: undefined, lost: undefined };
  try {
    for (const scenario of scenarios) {
      await open(scenario.name, scenario.openFile);
      if (scenario.prepare) {
        await pageJs(scenario.prepare);
        if (scenario.awaitRenders) {
          await pollUntil({ what: scenario.name + ' re-vouched', read: state, until: (seen) => seen !== undefined && seen.renders >= scenario.awaitRenders });
        }
      }
      const clicks = [];
      for (const click of scenario.clicks) {
        const point = await pollUntil({ what: click.at + ' laid out', read: soft(() => centre(click.at)), until: (value) => value !== undefined });
        clicks.push(await clickAndSee(point.value, press));
      }
      const seen = await readState();
      output.results.push({ name: scenario.name, clicks, notices: seen.notices, reloads: seen.reloads, log: await hostJs('canvasClickLog()') });
    }

    // An announcement the editor never heard (its listener mounted after the
    // frame spoke): the first click must still select, without a reload.
    await open('plain', undefined, { dropRenders: 2 });
    const lostPoint = (await pollUntil({ what: '#title laid out', read: soft(() => centre('#title')), until: (value) => value !== undefined })).value;
    const lost = await clickAndSee(lostPoint, press);
    const lostState = await readState();
    output.lost = { selection: lost.selection, reloads: lostState.reloads, notices: lostState.notices, log: await hostJs('canvasClickLog()') };

    // Churn: the page is patched (its stamp changes, the patcher says so) at
    // random moments while clicks land on random items.
    await open('churn');
    const random = mulberry32(20261114);
    const churn = { clicks: 0, renders: 0, retried: 0, notices: 0, wrong: [], missing: [] };
    const before = await readState();
    const rendersBefore = before.renders;
    const queriesBefore = before.queries;
    // The page's patch, as the patcher applies one: a new stamp, then avb:morphed.
    await pageJs('window.repatch = () => { const comment = [...document.body.childNodes].find((node) => node.nodeType === 8 && node.data.includes("src/pages/index.astro")); const digit = "0123456789abcdef"[Math.floor(Math.random() * 16)]; comment.data = "avb-d:" + digit.repeat(64) + ":src/pages/index.astro"; document.dispatchEvent(new CustomEvent("avb:morphed")); }; window.churnTimer = setInterval(window.repatch, 15)');
    // A click lands just before a patch, just after one, between two, or on a quiet page.
    const CHURN_MODES = ['quiet', 'patch-before', 'patch-after', 'patch-around'];
    for (let index = 0; index < 40; index++) {
      const item = Math.floor(random() * 30);
      const mode = CHURN_MODES[Math.floor(random() * CHURN_MODES.length)];
      const point = (await pollUntil({ what: 'item ' + item + ' in view', read: soft(() => centre('#item' + item)), until: (value) => value !== undefined })).value;
      churn.clicks += 1;
      const churned = async (at) => {
        const before = mode === 'patch-before' || mode === 'patch-around' ? 'window.repatch();' : '';
        const after = mode === 'patch-after' || mode === 'patch-around' ? 'window.repatch();' : '';
        await pageJs('(() => { ' + before + ' const x = ' + at.x + ', y = ' + at.y + '; const target = document.elementFromPoint(x, y); if (!target) { throw new Error("nothing at " + x + "," + y); } const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0, detail: 1 }; for (const type of ["mousemove", "mousedown", "mouseup", "click"]) { target.dispatchEvent(new MouseEvent(type, init)); } ' + after + ' })()');
      };
      try {
        const seen = await clickAndSee(point, churned);
        if (seen.selection.path !== '0.' + item) {
          churn.wrong.push({ item, mode, seen });
        }
      } catch (error) {
        churn.missing.push({ item, mode, error: String(error).slice(0, 200) });
      }
      if (index === 30) {
        await pageJs('clearInterval(window.churnTimer)');
      }
    }
    const after = await readState();
    churn.renders = after.renders - rendersBefore;
    churn.notices = after.notices.filter((event) => event.kind === 'show').length;
    churn.retried = after.queries - queriesBefore;
    output.churn = churn;

    // A rendering that mixes two versions of one file: reloaded once, still hoverable.
    await open('mixed-versions');
    await pollUntil({ what: 'the reload', read: state, until: (seen) => seen !== undefined && seen.reloads >= 1 });
    await pollUntil({ what: 'the reloaded page', read: state, until: (seen) => seen !== undefined && seen.problems.length >= 2 });
    // The reloaded page may still be laying out: the move is made once the
    // title is under the point, measured again on each try.
    await pollUntil({
      what: 'a move over the reloaded title',
      read: soft(() =>
        pageJs(
          '(() => { const title = document.getElementById("title"); if (!title) { return false; } const box = title.getBoundingClientRect(); const x = Math.round(box.left + Math.min(box.width / 2, 40)), y = Math.round(box.top + box.height / 2); const target = document.elementFromPoint(x, y); if (!target) { return false; } target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })); return true; })()',
        ),
      ),
      until: (moved) => moved === true,
    });
    // The reloaded frame may hear that move before it has walked its markers
    // (a hover of nothing); each poll moves the pointer off and back again,
    // so the hover is said again once the frame knows the page.
    const mixed = (
      await pollUntil({
        what: 'a hover of the title',
        read: soft(async () => {
          await pageJs('(() => { const title = document.getElementById("title"); const box = title.getBoundingClientRect(); for (const dx of [2, 0]) { const x = Math.round(box.left + Math.min(box.width / 2, 40)) + dx, y = Math.round(box.top + box.height / 2); document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })); } document.documentElement.dispatchEvent(new MouseEvent("mouseleave")); const x = Math.round(box.left + Math.min(box.width / 2, 40)), y = Math.round(box.top + box.height / 2); document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })); return true; })()');
          return readState();
        }),
        until: (seen) => seen !== undefined && seen.hovers.at(-1) === '0',
      })
    ).value;
    output.mixed = mixed === undefined ? { problems: [], reloads: 0, hover: undefined } : { problems: mixed.problems, reloads: mixed.reloads, hover: mixed.hovers.at(-1) };

    // Native input, where a hidden window receives it (macOS): the same pages, the real pointer.
    if (process.platform === 'darwin') {
      output.native = [];
      for (const name of ['plain', 'overlay-a-script-laid', 'embedded-document', 'hostile-page-scripts']) {
        const scenario = scenarios.find((entry) => entry.name === name);
        await open(name);
        const click = scenario.clicks[0];
        const point = (await pollUntil({ what: click.at + ' laid out', read: soft(() => centre(click.at)), until: (value) => value !== undefined })).value;
        // A hidden window takes native pointer moves on macOS, but not presses, so
        // native input checks the hover; the clicks above cover the press.
        const hoversBefore = (await readState()).hovers.length;
        win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 1, y: point.y + 1 });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
        const seen = (await pollUntil({ what: name + ' native hover', read: state, until: (now) => now !== undefined && now.hovers.length > hoversBefore })).value;
        output.native.push({ name, expect: click.expect, hover: seen.hovers.at(-1) });
      }
    }
  } catch (error) {
    output.error = String(error && error.stack || error);
  }
  console.log(JSON.stringify(output));
  win.destroy();
  server.close();
  app.quit();
});
`;
}
