// Goal: the dashed marks of a selected component's text appear only in the copy of it that is selected, and a dashed mark under the
// pointer turns into a named hover outline instead of vanishing. The reports: four Cards drawn by a `.map`, the first selected, and
// every Card's heading and paragraph dashed, because the frame was told only the instance's path, which every copy shares; and a
// dashed mark that disappeared under the pointer with nothing in its place.
//   node test/electron/preload/loopCopyMarksCanvas.test.js
// Method: the real planners read a page that loops a Card with a data-bound heading and body and slot words, and publish the
// catalog. The real built preload runs in a hidden Electron window over markup shaped as the preview renders it, in three shapes:
// one root a copy, two roots a copy (a fragment), and a loop inside a loop (copies numbered across both). The host sends
// `avb:text-focus` as the app does, with the selected copy. The dashed boxes the frame draws are compared with each copy's own
// area for every copy, for no copy (every copy, as the selection outline draws it) and for a number past the end (the first, as
// the outline draws it). Real mouse input then hovers marked words (the dash gives way to a reported hover, and comes back),
// crosses a bold span inside the bound paragraph (the hover holds), clicks words in another copy while the first is still the
// selection (the pick is in the clicked copy at once and stays there) and double clicks them (the editor opens in that copy).
// The overlays the app draws from the frame's own messages are rendered to check the hover is a tagged outline beside the
// selection's. The pointer part runs on macOS only, like every pointer probe (docs/release-runbook.md).
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { buildSync } = require('esbuild');
const loadRenderer = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { stampComment } = loadRenderer('shared/page/previewToken.ts');
const { canvasTextPlans } = loadRenderer('src/features/preview/canvasTextSource.ts');
const { canvasPropEdits } = loadRenderer('src/app/model/canvasPropText.ts');
const { createTreeIndex } = loadRenderer('src/editor/editorTree.ts');
const { canvasTextFocus, parseCanvasTextFocus } = loadRenderer('shared/properties/canvasTextOverlay.ts');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const finish = (note = '') => {
  if (failures.length) {
    console.error(`loop-copy-marks-canvas: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`loop-copy-marks-canvas: ${checked}/${checked} passed${note}`);
};

const PAGE = 'src/pages/index.astro';
const PAGE_SOURCE = [
  '---',
  'import Card from "@/components/Card.astro";',
  '---',
  '<section>{posts.map((post) => <Card heading={post.title} body={post.body}>Read it all</Card>)}</section>',
  '',
].join('\n');
const CARD = ['---', 'const { heading, body } = Astro.props;', '---', '<div class="card"><h3>{heading}</h3><p set:html={body} /><a><slot /></a></div>'].join(
  '\n',
);
const COPIES = 4;
// Each copy's cell of a 2 by 2 grid; every mark of a copy lies inside its cell.
const CELL = { w: 420, h: 260 };
const cell = (index) => ({ x: (index % 2) * CELL.w, y: Math.floor(index / 2) * CELL.h });

async function plan() {
  const model = parsePage(PAGE_SOURCE, { locs: true }).model;
  const tree = createTreeIndex(model.nodes);
  const pathFor = (id) => tree.path(id);
  const slots = canvasTextPlans(PAGE_SOURCE, model.nodes, pathFor).map((entry) => entry.target);
  const field = (name) => ({ name, type: 'string', required: false });
  const bound = await canvasPropEdits(
    { file: PAGE, source: PAGE_SOURCE, nodes: model.nodes, pathFor },
    {
      projectPath: '/site',
      file: `/site/${PAGE}`,
      nodes: model.nodes,
      imports: model.imports,
      label: 'Component text',
      components: [{ name: 'Card', path: '/site/src/components/Card.astro', origin: { kind: 'project' }, schema: [field('heading'), field('body')] }],
      relative: (file) => file.slice('/site/'.length),
      read: async (file) => (file.endsWith('Card.astro') ? parsePage(CARD, { locs: true }).model : undefined),
      setProp: () => undefined,
    },
  );
  return { slots, blocked: bound.map(({ target }) => ({ key: target.key, path: target.path, scope: target.scope })) };
}

const marked = (pathText, inner) => `<!--avb-s:${pathText}-->${inner}<!--avb-e:${pathText}-->`;

// One copy of the Card, drawn in its cell. `roots` 2 splits it into two root elements inside the one marker run of the copy.
function copyMarkup(index, { instance, blocked, slot, roots }) {
  const byProp = (name) => blocked.find((entry) => entry.key.split(':')[2] === name).path;
  const at = cell(index);
  const own = `data-avb-p="src/components/Card.astro|0 ${instance}"`;
  const heading = `<h3 data-avb-p="src/components/Card.astro|0.0">${marked(byProp('heading'), `Heading ${index}`)}</h3>`;
  const body = `<p data-avb-p="${byProp('body')}">${marked(byProp('body'), `Lorem ipsum <strong>dolor sit</strong> amet ${index}`)}</p>`;
  const link = `<a data-avb-p="src/components/Card.astro|0.2">${marked(slot.path, 'Read it all')}</a>`;
  const box = (top, height) => `style="position:absolute;left:${at.x + 20}px;top:${at.y + top}px;width:360px;height:${height}px"`;
  const inner =
    roots === 2
      ? `<header class="card" ${own} ${box(40, 60)}>${heading}</header><div class="card" ${own} ${box(110, 120)}>${body}${link}</div>`
      : `<div class="card" ${own} ${box(40, 190)}>${heading}${body}${link}</div>`;
  return marked(instance, inner);
}

function overlays() {
  const output = repoPath('node_modules/.stacki-test/loop-copy-marks-overlays.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  buildSync({
    stdin: { contents: `export { PreviewOverlays } from './src/features/preview/PreviewOverlays';`, resolveDir: repoPath('.'), loader: 'ts' },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { PreviewOverlays } = require(output);
  return ({ instance, boxes, copy, marks }) =>
    renderToStaticMarkup(
      React.createElement(PreviewOverlays, {
        rects: { [instance]: boxes },
        spacing: {},
        scale: 1,
        selPath: instance,
        selOcc: copy,
        hoverPath: instance,
        hoverOcc: copy,
        focusPath: undefined,
        focusWhole: false,
        textMarks: marks,
        overlayInfo: () => ({
          label: 'Card',
          kind: 'component',
          tag: undefined,
          astroAsset: false,
          dynamicTag: false,
          nodeKind: 'component',
          childCount: 1,
          isLayout: false,
          bound: false,
        }),
      }),
    );
}

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();

  check(
    'the focus message carries the selected copy',
    parseCanvasTextFocus(canvasTextFocus(['0.0.0'], 2)).occurrence === 2,
    JSON.stringify(canvasTextFocus(['0.0.0'], 2)),
  );
  check('no copy named stays no copy', !('occurrence' in parseCanvasTextFocus(canvasTextFocus(['0.0.0']))));
  for (const bad of [-1, 1.5, '1', true, 1e9]) {
    let refused = false;
    try {
      parseCanvasTextFocus({ type: 'avb:text-focus', paths: ['0'], occurrence: bad });
    } catch {
      refused = true;
    }
    check(`a copy of ${JSON.stringify(bad)} is refused at the boundary`, refused);
  }

  const { slots, blocked } = await plan();
  const slot = slots.find((target) => target.value === 'Read it all' && target.from === 'slot');
  check('the planners offer the slot words and both bound props', slot !== undefined && blocked.length === 2, JSON.stringify({ slots, blocked }));
  if (slot === undefined || blocked.length !== 2) {
    finish();
    return;
  }
  const instance = slot.scope;
  if (typeof electronPath !== 'string') {
    finish('; window checks skipped  [needs a Chromium]');
    return;
  }
  if (process.platform !== 'darwin') {
    finish('; window checks skipped  [macOS only]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const checksum = crypto.createHash('sha256').update(PAGE_SOURCE).digest('hex');
  const sectionPath = '0';
  const copies = (roots) => Array.from({ length: COPIES }, (_, index) => copyMarkup(index, { instance, blocked, slot, roots }));
  // A loop inside a loop: the outer one's two passes each hold two copies, which the canvas numbers 0 to 3 across both.
  const nested = (list) => `<div class="group">${list[0]}${list[1]}</div><div class="group">${list[2]}${list[3]}</div>`;
  const PAGES = { single: copies(1).join(''), fragment: copies(2).join(''), nested: nested(copies(1)) };
  const catalog = { type: 'avb:text-catalog', session: 'one', file: PAGE, checksum, targets: slots, blocked };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const shape = url.searchParams.get('shape');
    const body =
      url.pathname === '/host.html'
        ? `<!doctype html><meta charset=utf-8><style>html,body{margin:0}iframe{border:0;width:900px;height:600px;display:block}</style><iframe id="canvas" src="/canvas.html?shape=${shape}#avb-design"></iframe>` +
          '<script>window.posts=[];addEventListener("message",(e)=>posts.push(e.data));</script>'
        : url.pathname === '/canvas.html' && PAGES[shape] !== undefined
          ? '<!doctype html><meta charset=utf-8><style>body{margin:0;font:18px/1.4 sans-serif}h3,p{margin:0 0 10px}a{display:inline-block;padding:0}</style>' +
            `<body>${stampComment({ file: PAGE, checksum })}${marked(sectionPath, `<section data-avb-p="${sectionPath}">${PAGES[shape]}</section>`)}</body>`
          : undefined;
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? '');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const probeDirectory = repoPath('node_modules/.stacki-test/loop-copy-marks-canvas');
  fs.mkdirSync(probeDirectory, { recursive: true });
  const probe = path.join(probeDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow, ipcMain } = require('electron');
     app.disableHardwareAcceleration();
     app.commandLine.appendSwitch('use-mock-keychain');
     app.setPath('userData', require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'stacki-loop-marks-')));
     ipcMain.on('boot:read', (event) => { event.returnValue = undefined; });
     app.on('window-all-closed', () => app.quit());
     const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     const INSTANCE = ${JSON.stringify(instance)};
     const CATALOG = ${JSON.stringify(catalog)};
     app.whenReady().then(async () => {
       const win = new BrowserWindow({
         show: false, width: 1000, height: 700,
         webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true },
       });
       const out = { shapes: {} };
       const run = (code) => win.webContents.executeJavaScript(code);
       const frame = 'document.getElementById("canvas").contentWindow';
       const inFrame = (code) => run(frame + '.eval(' + JSON.stringify(code) + ')');
       const post = (message) => run(frame + '.postMessage(' + JSON.stringify(message) + ', "*")');
       const focus = (copy) => post({ type: 'avb:text-focus', paths: [INSTANCE], ...(copy === undefined ? {} : { occurrence: copy }) });
       const marks = () => inFrame('Array.from(document.querySelector("[data-avb-text-marks]")?.children ?? []).map((m) => { const r = m.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })');
       const state = () => run('window.posts.filter((m) => m.type === "avb:text-marks").at(-1)');
       // Waits for the marks to settle on an expected number; the last reading is what is checked either way.
       const settled = async (what, count) => {
         let last = [];
         await waitFor({ what, read: async () => { last = await marks(); return last; }, until: (list) => list.length === count, pollCountMax: 40 }).catch(() => undefined);
         return last;
       };
       const send = (type, at, extra) => win.webContents.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), ...extra });
       const point = (at) => send('mouseMove', at);
       const press = (at, clickCount = 1) => { send('mouseDown', at, { button: 'left', clickCount }); send('mouseUp', at, { button: 'left', clickCount }); };
       const untilState = async (what, accept) => {
         let last;
         await waitFor({ what, read: async () => { last = await state(); return last ?? null; }, until: (message) => message !== null && accept(message), pollCountMax: 40 }).catch(() => undefined);
         return last ?? null;
       };
       const away = { x: 880, y: 580 };
       // The box of the words in the copy's element: their own range.
       const wordsOf = (selector, index) => inFrame('(() => { const el = document.querySelectorAll(' + JSON.stringify(selector) + ')[' + index + ']; const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
       const middle = (box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
       for (const shape of ['single', 'fragment', 'nested']) {
         await win.loadURL('http://127.0.0.1:${port}/host.html?shape=' + shape);
         await waitFor({ what: 'the page loaded', read: () => run(frame + '.document.querySelectorAll("h3").length'), until: (count) => count === ${COPIES} });
         await post({ type: 'avb:track', paths: [INSTANCE], scope: '', focus: '', focusOcc: 0 });
         await post(CATALOG);
         const shown = { perCopy: [] };
         await focus(undefined);
         shown.every = await settled('every copy is marked', ${COPIES * 3});
         // The marks settled in one copy's cell: three of them, none anywhere else. The last reading is what is checked.
         const inCopy = async (copy) => {
           const left = (copy % 2) * ${CELL.w};
           const top = Math.floor(copy / 2) * ${CELL.h};
           let last = [];
           await waitFor({ what: 'copy ' + copy + ' is marked', read: async () => { last = await marks(); return last; }, until: (list) => list.length === 3 && list.every((m) => m.x >= left && m.x < left + ${CELL.w} && m.y >= top && m.y < top + ${CELL.h}), pollCountMax: 40 }).catch(() => undefined);
           return last;
         };
         for (let copy = 0; copy < ${COPIES}; copy += 1) {
           await focus(copy);
           shown.perCopy.push(await inCopy(copy));
         }
         await focus(99);
         shown.pastEnd = await inCopy(0);
         await post({ type: 'avb:text-focus', paths: [] });
         shown.none = await settled('nothing selected marks nothing', 0);
         out.shapes[shape] = shown;
       }

       // The pointer, over the plain page.
       await win.loadURL('http://127.0.0.1:${port}/host.html?shape=single');
       await waitFor({ what: 'the page loaded', read: () => run(frame + '.document.querySelectorAll("h3").length'), until: (count) => count === ${COPIES} });
       await post({ type: 'avb:track', paths: [INSTANCE], scope: '', focus: '', focusOcc: 0 });
       await post(CATALOG);
       await focus(0);
       await settled('the first copy is marked', 3);
       const slotWords = await wordsOf('a', 0);
       out.slotWords = slotWords;
       point(away);
       point(middle(slotWords));
       out.slotHover = await untilState('the slot words are hovered', (m) => m.hover !== undefined);
       out.slotHoverMarks = await settled('the hovered dash gives way', 2);
       point(away);
       out.slotLeft = await untilState('the hover ends', (m) => m.hover === undefined);
       out.slotLeftMarks = await settled('the dash is back', 3);
       // The bound paragraph: from its plain words onto the bold span inside it and back, the hover is one and holds.
       const bold = await wordsOf('p strong', 0);
       const paragraph = await wordsOf('p', 0);
       out.paragraph = await inFrame('(() => { const r = document.querySelector("p").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
       point({ x: paragraph.x + 5, y: paragraph.y + paragraph.h / 2 });
       out.plainHover = await untilState('the bound paragraph is hovered', (m) => m.hover !== undefined);
       await run('window.posts.length = 0');
       point(middle(bold));
       point({ x: bold.x + bold.w + 8, y: bold.y + bold.h / 2 });
       point(middle(bold));
       out.boldMarks = await settled('the paragraph keeps its hover over the bold span', 2);
       out.boldPosts = await run('window.posts.filter((m) => m.type === "avb:text-marks")');
       // Another copy is only the pointer's: no dash there, and no text hover of its own.
       point(away);
       await untilState('the hover ends', (m) => m.hover === undefined);
       await run('window.posts.length = 0');
       point(middle(await wordsOf('a', 1)));
       out.otherMarks = await settled('the first copy keeps its marks', 3);
       out.otherHover = (await state()) ?? null;
       // A click on the third copy's words while the first is still the selection: picked there at once, and still there after.
       const third = middle(await wordsOf('a', 2));
       point(third);
       // A hidden window can drop a synthetic press, so it is repeated while no click reached the page.
       let pressedAtMs = 0;
       await waitFor({
         what: 'the click reached the page',
         read: async () => {
           const clicked = await run('window.posts.some((m) => m.type === "avb:click-node")');
           if (!clicked && Date.now() - pressedAtMs >= 1000) { pressedAtMs = Date.now(); press(third); }
           return clicked;
         },
         until: Boolean,
       }).catch(() => undefined);
       out.pickedBefore = await untilState('the clicked copy is picked', (m) => m.picked !== undefined);
       out.pickedBeforeMarks = await marks();
       await focus(2);
       out.pickedAfterMarks = await settled('the marks move to the clicked copy', 2);
       out.pickedAfter = await state();
       out.thirdWords = await wordsOf('a', 2);
       // A double click on the fourth copy's words opens the editor in that copy.
       const fourth = middle(await wordsOf('a', 3));
       await run('window.posts.length = 0');
       let attemptedAtMs = 0;
       await waitFor({
         what: 'the editor opened',
         read: async () => {
           const active = await run('window.posts.some((m) => m.type === "avb:text-active" || m.type === "avb:text-refused")');
           if (!active && Date.now() - attemptedAtMs >= 1000) { attemptedAtMs = Date.now(); point(fourth); press(fourth, 1); press(fourth, 2); }
           return active;
         },
         until: Boolean,
       }).catch(() => undefined);
       out.editorCopy = await inFrame('(() => { const editor = document.querySelector("[data-avb-text-editor]"); return editor === null ? -1 : Array.from(document.querySelectorAll(".card")).findIndex((card) => card.contains(editor)); })()');
       out.editorPosts = await run('window.posts.filter((m) => m.type === "avb:click-node").map((m) => ({ path: m.path, occurrence: m.occurrence }))');
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
    finish();
    return;
  }
  const out = JSON.parse(line.slice('RESULT '.length));
  const inCell = (mark, copy) => {
    const at = cell(copy);
    return mark.x >= at.x && mark.x < at.x + CELL.w && mark.y >= at.y && mark.y < at.y + CELL.h;
  };
  const onlyIn = (marks, copy, count) => marks.length === count && marks.every((mark) => inCell(mark, copy));
  for (const [shape, shown] of Object.entries(out.shapes)) {
    check(`${shape}: a selection naming no copy marks every copy, as its outline does`, shown.every.length === COPIES * 3, JSON.stringify(shown.every));
    shown.perCopy.forEach((marks, copy) => {
      check(`${shape}: with copy ${copy} selected, only its heading, paragraph and slot words are dashed`, onlyIn(marks, copy, 3), JSON.stringify(marks));
    });
    check(`${shape}: a copy past the end is the first`, onlyIn(shown.pastEnd, 0, 3), JSON.stringify(shown.pastEnd));
    check(`${shape}: nothing selected, nothing dashed`, shown.none.length === 0, JSON.stringify(shown.none));
  }
  const near = (left, right) => Math.abs(left - right) <= 1;
  const hugs = (hover, box) => hover !== undefined && near(hover.x, box.x) && near(hover.y, box.y) && near(hover.w, box.w) && near(hover.h, box.h);
  const slotHover = out.slotHover?.hover;
  check(
    'dashed slot words under the pointer are reported as a named hover',
    hugs(slotHover, out.slotWords) && slotHover.label !== '',
    JSON.stringify(slotHover),
  );
  check('the hovered dash gives way, the other two stay', onlyIn(out.slotHoverMarks, 0, 2), JSON.stringify(out.slotHoverMarks));
  check('moving away ends the hover and brings the dash back', out.slotLeft?.hover === undefined && onlyIn(out.slotLeftMarks, 0, 3), JSON.stringify(out));
  const plain = out.plainHover?.hover;
  check('a dashed bound paragraph under the pointer is a named hover', hugs(plain, out.paragraph) && plain.label !== '', JSON.stringify(plain));
  check(
    'crossing a bold span inside it never drops or changes the hover',
    out.boldPosts.every((message) => hugs(message.hover, out.paragraph)) && onlyIn(out.boldMarks, 0, 2),
    JSON.stringify({ posts: out.boldPosts, marks: out.boldMarks }),
  );
  if (slotHover !== undefined) {
    const html = overlays()({
      instance,
      boxes: Array.from({ length: COPIES }, (_, index) => ({ ...cell(index), w: 380, h: 230 })),
      copy: 0,
      marks: { hover: slotHover, picked: undefined },
    });
    check('the app draws one selection outline, on the selected copy alone', (html.match(/class="node-outline sel /g) ?? []).length === 1, html);
    check(
      'and the hovered words as a hover outline with its tag, the selection keeping its own',
      /class="node-outline hover \w+ text-mark"[^>]*><span class="node-outline-tag/.test(html) &&
        /class="node-outline sel [^>]*><span class="node-outline-tag/.test(html),
      html,
    );
  }
  check(
    'words of a copy that is not selected draw no hover of their own',
    out.otherHover === null || out.otherHover.hover === undefined,
    JSON.stringify(out.otherHover),
  );
  check('and the selected copy keeps its three marks', onlyIn(out.otherMarks, 0, 3), JSON.stringify(out.otherMarks));
  check(
    'a click in another copy picks the clicked words at once, not the same words of the copy still selected',
    hugs(out.pickedBefore?.picked, out.thirdWords),
    JSON.stringify({ picked: out.pickedBefore, words: out.thirdWords, marks: out.pickedBeforeMarks }),
  );
  check('when the selection arrives the pick stays in that copy', hugs(out.pickedAfter?.picked, out.thirdWords), JSON.stringify(out.pickedAfter));
  check('and the marks have moved to that copy', onlyIn(out.pickedAfterMarks, 2, 2), JSON.stringify(out.pickedAfterMarks));
  check('a double click opens the editor in the clicked copy', out.editorCopy === 3, JSON.stringify(out.editorCopy));
  check(
    'and selects that copy',
    out.editorPosts.some((message) => message.path === instance && message.occurrence === 3),
    JSON.stringify(out.editorPosts),
  );
  finish();
})();
