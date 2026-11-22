// Goal: words a page writes into a component's slot (`<Button>Start your free flight</Button>`) are outlined on hover when
// the component renders them straight into its own root (`<a class="button"><slot /></a>`), the outline hugs the words and
// not the whole button, and a double click types in them (docs/canvas-closed-component-text.md). The regression: the hover
// skipped any words whose element carries the instance's own path, the rule that keeps a Heading's `<h2><slot /></h2>`
// from drawing a second outline over itself, so a padded button's slot text got no outline at all.
//   node test/electron/preload/slotTextHoverCanvas.test.js
// Method: the real planner (`canvasTextPlans`) reads a page of Buttons (two side by side, one inside a Card's slot, one
// behind a condition), a Heading and a Card whose badge the component writes itself, and publishes its catalog. The real
// built preload runs in a hidden Electron window over markup shaped as the preview renders it (each component's root tagged
// with its own path and the path of the instance that drew it, the slot wrapped in its markers). Real mouse moves hover
// the words, the padding, the Heading and the badge; the `avb:text-marks` the frame posts are compared with the words' own
// range box measured in the page. Both sides of the rule are checked: slot words are outlined, words no slot or prop
// reaches (the badge) and a root that is only its words (the Heading) are not.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const loadRenderer = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { stampComment } = loadRenderer('shared/page/previewToken.ts');
const { canvasTextPlans } = loadRenderer('src/features/preview/canvasTextSource.ts');
const { createTreeIndex } = loadRenderer('src/editor/editorTree.ts');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const PAGE = 'src/pages/index.astro';
const PAGE_SOURCE = [
  '---',
  'import Button from "@/components/Button.astro";',
  'import Heading from "@/components/Heading.astro";',
  'import Card from "@/components/Card.astro";',
  'const show = true;',
  '---',
  '<section>',
  '  <Button href="/a">Start your free flight</Button>',
  '  <Button href="/b">Second button</Button>',
  '  <Heading>Plain heading</Heading>',
  '  <Card><Button href="/c">Nested words</Button></Card>',
  '  {show && <Button href="/d">Maybe words</Button>}',
  '</section>',
  '',
].join('\n');

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('slot-text-hover-canvas: skipped  [needs a Chromium]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const parsed = parsePage(PAGE_SOURCE, { locs: true });
  check('the page parses as editable', parsed.editable === true);
  const tree = createTreeIndex(parsed.model.nodes);
  const targets = canvasTextPlans(PAGE_SOURCE, parsed.model.nodes, (id) => tree.path(id)).map((plan) => plan.target);
  const slotTarget = (words) => targets.find((target) => target.value === words && target.from === 'slot');
  const WORDS = ['Start your free flight', 'Second button', 'Plain heading', 'Nested words', 'Maybe words'];
  const found = Object.fromEntries(WORDS.map((words) => [words, slotTarget(words)]));
  check(
    'the planner offers every slot text as the slot of its own instance',
    WORDS.every((words) => found[words]?.scope === found[words]?.parent),
    JSON.stringify(targets),
  );
  if (WORDS.some((words) => found[words] === undefined)) {
    console.error(`slot-text-hover-canvas: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }

  // The rest drives the real pointer, so like every pointer probe it runs on macOS only (docs/release-runbook.md): a
  // hidden window on Windows drops the first synthetic mouse move, which reads as a missing hover.
  if (process.platform !== 'darwin') {
    if (failures.length) {
      console.error(`slot-text-hover-canvas: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
      process.exit(1);
    }
    console.log(`slot-text-hover-canvas: ${checked}/${checked} planner checks passed; pointer checks skipped  [macOS only]`);
    return;
  }
  // The markup the preview renders. Button: `<a class="button"><slot /></a>` with padding; Heading: `<h2><slot /></h2>` with
  // none; Card: `<div class="card"><span class="card_badge">New</span><slot /></div>`, its badge written by the component.
  const marked = (pathText, inner) => `<!--avb-s:${pathText}-->${inner}<!--avb-e:${pathText}-->`;
  const button = (words) => {
    const instance = found[words].parent;
    return marked(
      instance,
      `<a class="button" href="#" data-avb-p="src/components/Button.astro|0 ${instance}">${marked('src/components/Button.astro|0.0', words)}</a>`,
    );
  };
  const heading = marked(
    found['Plain heading'].parent,
    `<h2 data-avb-p="src/components/Heading.astro|0 ${found['Plain heading'].parent}">${marked('src/components/Heading.astro|0.0', 'Plain heading')}</h2>`,
  );
  const cardPath = parentOf(found['Nested words'].parent);
  const card = marked(
    cardPath,
    `<div class="card" data-avb-p="src/components/Card.astro|0 ${cardPath}">` +
      '<span class="card_badge" data-avb-p="src/components/Card.astro|0.0">New</span>' +
      `${marked('src/components/Card.astro|0.1', button('Nested words'))}</div>`,
  );
  const sectionPath = parentOf(found['Start your free flight'].parent);
  const checksum = crypto.createHash('sha256').update(PAGE_SOURCE).digest('hex');
  const markup =
    '<!doctype html><meta charset=utf-8><style>body{margin:0;font:20px/1.4 sans-serif}section{padding:20px}' +
    '.button{display:inline-block;padding:14px 28px;margin:0 12px 16px 0;background:#222;color:#fff;border-radius:8px;text-decoration:none;text-transform:uppercase}' +
    'h2{margin:0 0 16px;font-size:28px}.card{padding:16px;background:#eee;margin-bottom:16px}.card_badge{display:inline-block;padding:4px 10px;margin-right:12px;background:#fc0}</style>' +
    `<body>${stampComment({ file: PAGE, checksum })}` +
    marked(
      sectionPath,
      `<section data-avb-p="${sectionPath}">${button('Start your free flight')}${button('Second button')}${heading}${card}${button('Maybe words')}</section>`,
    ) +
    '</body>';
  const catalog = { type: 'avb:text-catalog', session: 'one', file: PAGE, checksum, targets };
  const instances = WORDS.map((words) => found[words].parent);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const body =
      url.pathname === '/host.html'
        ? '<!doctype html><meta charset=utf-8><style>html,body{margin:0}iframe{border:0;width:900px;height:700px;display:block}</style><iframe id="canvas" src="/canvas.html#avb-design"></iframe>' +
          '<script>window.posts=[];addEventListener("message",(e)=>posts.push(e.data));</script>'
        : url.pathname === '/canvas.html'
          ? markup
          : undefined;
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? '');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const probeDirectory = repoPath('node_modules/.stacki-test/slot-text-hover-canvas');
  fs.mkdirSync(probeDirectory, { recursive: true });
  const catalogFile = path.join(probeDirectory, 'catalog.json');
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  const probe = path.join(probeDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const fs = require('fs');
     const { app, BrowserWindow, ipcMain } = require('electron');
     app.disableHardwareAcceleration();
     ipcMain.on('boot:read', (event) => { event.returnValue = undefined; });
     app.on('window-all-closed', () => app.quit());
     const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     app.whenReady().then(async () => {
       const win = new BrowserWindow({
         show: false, width: 1000, height: 750,
         webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true },
       });
       const out = {};
       const run = (code) => win.webContents.executeJavaScript(code);
       const frame = 'document.getElementById("canvas").contentWindow';
       const post = (message) => run(frame + '.postMessage(' + JSON.stringify(message) + ', "*")');
       await win.loadURL('http://127.0.0.1:${port}/host.html');
       await waitFor({ what: 'the page loaded', read: () => run(frame + '.document.querySelectorAll("a.button").length'), until: (count) => count === 4 });
       await post({ type: 'avb:track', paths: ${JSON.stringify(instances)}, scope: '', focus: '', focusOcc: 0 });
       await post(JSON.parse(fs.readFileSync(${JSON.stringify(catalogFile)}, 'utf8')));
       // The words' own box (the range of their text) and their element's box, measured in the page.
       const boxes = (selector, index) => run('(() => { const el = ' + frame + '.document.querySelectorAll(' + JSON.stringify(selector) + ')[' + index + ']; const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.data.trim()); const r = ' + frame + '.document.createRange(); r.selectNodeContents(node); const w = r.getBoundingClientRect(); const e = el.getBoundingClientRect(); return { words: { x: w.left, y: w.top, w: w.width, h: w.height }, element: { x: e.left, y: e.top, w: e.width, h: e.height } }; })()');
       const posts = () => run('JSON.stringify(window.posts.filter((m) => /^avb:text/.test(m.type)))').then(JSON.parse);
       const point = (at) => win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(at.x), y: Math.round(at.y) });
       const away = { x: 990, y: 740 };
       // The hover reported once the pointer rests at a point: the last text-marks message after the pointer left everything.
       const hoverAt = async (at, what) => {
         point(away);
         await waitFor({ what: 'no hover off the page (' + what + ')', read: posts, until: (list) => list.filter((m) => m.type === 'avb:text-marks').at(-1)?.hover === undefined });
         await run('window.posts.length = 0');
         point(at);
         // A point with no hover posts nothing new (the report did not change), so a short settle is read as "none".
         const seen = await waitFor({ what: 'the hover settled (' + what + ')', read: posts, until: (list) => list.some((m) => m.type === 'avb:text-marks'), pollCountMax: 10 }).catch(() => []);
         return seen.filter((m) => m.type === 'avb:text-marks').at(-1)?.hover;
       };
       const middle = (box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
       out.first = await boxes('a.button', 0);
       out.firstHover = await hoverAt(middle(out.first.words), 'first button words');
       out.paddingHover = await hoverAt({ x: out.first.element.x + 6, y: out.first.element.y + out.first.element.h / 2 }, 'first button padding');
       out.second = await boxes('a.button', 1);
       out.secondHover = await hoverAt(middle(out.second.words), 'second button words');
       out.heading = await boxes('h2', 0);
       out.headingHover = await hoverAt(middle(out.heading.words), 'heading words');
       out.badge = await boxes('.card_badge', 0);
       out.badgeHover = await hoverAt(middle(out.badge.words), 'card badge');
       out.nested = await boxes('a.button', 2);
       out.nestedHover = await hoverAt(middle(out.nested.words), 'nested button words');
       out.maybe = await boxes('a.button', 3);
       out.maybeHover = await hoverAt(middle(out.maybe.words), 'conditional button words');
       // With the first Button selected, its words are marked at rest (a dashed mark the size of the words) and still hovered.
       await post({ type: 'avb:text-focus', paths: [${JSON.stringify(found['Start your free flight'].parent)}] });
       out.restMark = await waitFor({
         what: 'the selected button marked its words',
         read: () => run('(() => { const m = ' + frame + '.document.querySelector("[data-avb-text-marks]")?.children[0]; if (!m) return undefined; const b = m.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()'),
         until: (box) => box !== undefined,
         pollCountMax: 40,
       }).catch(() => undefined);
       out.selectedHover = await hoverAt(middle(out.first.words), 'selected button words');
       // A double click on the words opens their editor; the frame answers once its session has settled, so it is repeated while nothing answered.
       await run('window.posts.length = 0');
       let clickedAtMs = 0;
       const at = middle(out.first.words);
       out.opened = await waitFor({
         what: 'the editor opened or refused',
         read: async () => {
           const list = await posts();
           if (!list.some((m) => m.type === 'avb:text-active' || m.type === 'avb:text-refused') && Date.now() - clickedAtMs >= 1000) {
             clickedAtMs = Date.now();
             for (let n = 1; n <= 2; n++) {
               win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: n });
               win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: n });
             }
           }
           return list;
         },
         until: (list) => list.some((m) => m.type === 'avb:text-active' || m.type === 'avb:text-refused'),
       }).catch(() => []);
       console.log('RESULT ' + JSON.stringify(out));
       app.quit();
     });`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolveRun) => {
    const child = spawn(electronPath, [probe], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr });
    });
  });
  server.close();

  const line = result.stdout.split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) {
    check('the browser probe ran', false, `${result.stdout}\n${result.stderr}`.slice(0, 1500));
  } else {
    const out = JSON.parse(line.slice('RESULT '.length));
    // Within a pixel: the frame's report and the page's own measure round differently.
    const near = (left, right) => Math.abs(left - right) <= 1;
    const hugs = (hover, box) => hover !== undefined && near(hover.x, box.x) && near(hover.y, box.y) && near(hover.w, box.w) && near(hover.h, box.h);
    const hoveredFor = (hover, measured, words) => {
      check(`hovering "${words}" outlines them, owned by their own Button`, hover?.scope === found[words].parent, JSON.stringify(hover));
      check(
        `the outline of "${words}" hugs the words, not the button`,
        hugs(hover, measured.words) && hover.w < measured.element.w,
        JSON.stringify({ hover, measured }),
      );
    };
    hoveredFor(out.firstHover, out.first, 'Start your free flight');
    check('the pointer on the button padding is the component, not its words', out.paddingHover === undefined, JSON.stringify(out.paddingHover));
    hoveredFor(out.secondHover, out.second, 'Second button');
    check(
      'a Heading that is only its words gets no outline of its own (its hover is the hover)',
      out.headingHover === undefined,
      JSON.stringify(out.headingHover),
    );
    check('words the Card writes itself are not outlined', out.badgeHover === undefined, JSON.stringify(out.badgeHover));
    hoveredFor(out.nestedHover, out.nested, 'Nested words');
    hoveredFor(out.maybeHover, out.maybe, 'Maybe words');
    check(
      'the selected button marks its words at rest, the size of the words',
      hugs(out.restMark, out.first.words),
      JSON.stringify({ mark: out.restMark, words: out.first.words }),
    );
    hoveredFor(out.selectedHover, out.first, 'Start your free flight');
    const active = out.opened.find((message) => message.type === 'avb:text-active');
    check('a double click on the words opens their editor', active?.key === found['Start your free flight'].key, JSON.stringify(out.opened));
  }
  if (failures.length) {
    console.error(`slot-text-hover-canvas: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`slot-text-hover-canvas: ${checked}/${checked} passed`);
})();

function parentOf(pathText) {
  return pathText.slice(0, pathText.lastIndexOf('.'));
}
