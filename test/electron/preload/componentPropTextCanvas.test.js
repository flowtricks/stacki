// Goal: on a page of Card components, double-clicking a Card's heading or paragraph opens its editor,
// and the save changes the prop literal on that Card's own tag in the page file, byte for byte
// nowhere else; one Undo writes the old bytes back. The regression: Card prints its words as
// `<Heading><Fragment set:html={heading} /></Heading>`, which the prop-text finder refused (the
// fragment's parent is a component), so the double click did nothing though a Button's label worked.
//   node test/electron/preload/componentPropTextCanvas.test.js
// Method: the real planner (`canvasPropEdits`) reads a page of two Cards and the Card, Heading and
// Paragraph sources and offers the targets. They go to the real built preload in a real Electron
// window over markup shaped as the preview renders it (each component's root tagged with the path
// of the node that drew it); real mouse events (click count 2) and typing drive it, and the save
// message the frame posts is applied through the planner's own edit. The prop write goes through
// the real main-process page edit handler on a temporary file, as the app's own prop edit does, and
// the revert it returns is the Undo.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { stampComment } = loadRenderer('shared/page/previewToken.ts');
const { canvasPropEdits } = loadRenderer('src/app/model/canvasPropText.ts');
const { createTreeIndex } = loadRenderer('src/editor/editorTree.ts');
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');

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
  'import Card from "@/components/item/Card.astro";',
  '---',
  '<Card heading="Lorem ipsum dolor sit amet" text="First body words that sit in a paragraph." />',
  '<Card heading="Second heading" text="Second body words." />',
  '',
].join('\n');
const FILES = {
  'src/components/item/Card.astro': [
    '---',
    'import Heading from "@/components/typography/Heading.astro";',
    'import Paragraph from "@/components/typography/Paragraph.astro";',
    'const { heading, headingTag = "h3", text } = Astro.props;',
    '---',
    '<div class="card_content">',
    '  <Heading tag={headingTag} variant="h5">',
    '    <Fragment set:html={heading} />',
    '  </Heading>',
    '  <Paragraph>',
    '    <Fragment set:html={text} />',
    '  </Paragraph>',
    '</div>',
  ].join('\n'),
  'src/components/typography/Heading.astro': '---\nconst { tag: Tag = "h2" } = Astro.props;\n---\n<Tag><slot /></Tag>',
  'src/components/typography/Paragraph.astro': '<p><slot /></p>',
};
const field = (name) => ({ name, type: 'string' });
const COMPONENTS = [
  { name: 'Card', path: 'ROOT/src/components/item/Card.astro', schema: [field('heading'), field('text')] },
  { name: 'Heading', path: 'ROOT/src/components/typography/Heading.astro', schema: [field('tag')] },
  { name: 'Paragraph', path: 'ROOT/src/components/typography/Paragraph.astro', schema: [] },
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
    console.log('component-prop-text-canvas: skipped  [needs a Chromium]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-component-prop-text-'));
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  for (const [file, text] of Object.entries({ ...FILES, [PAGE]: PAGE_SOURCE })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const pageFile = path.join(root, PAGE);
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));

  // The page edit the app's prop write makes: one set-attribute on the instance, against the page as it is on disk.
  const writes = [];
  const undo = [];
  let pending = Promise.resolve();
  const setProp = (nodeId, prop, value) => {
    pending = pending.then(async () => {
      const read = parsePageDiskRead(await harness.invoke('page:read', pageFile));
      const path = tree.path(nodeId).split('.').map(Number);
      let list = read.model.nodes;
      let target;
      for (const step of path) {
        target = list[step];
        list = target.children ?? [];
      }
      const reply = parsePageEditResult(
        await harness.invoke('page:edit', {
          pagePath: pageFile,
          authoredChecksum: read.checksum,
          edit: { tag: 'set-attribute', target: { path, kind: target.kind, span: { start: target.start, end: target.end } }, name: prop, value },
        }),
      );
      writes.push({ prop, value, ok: reply.ok });
      if (reply.ok) {
        undo.push(reply.value.inverse);
      }
    });
  };

  // The prop finder reads a prop's HTML through the DOM, as the renderer does. The globals come after the main
  // process is loaded: a compiler that sees a `window` takes itself for a browser's.
  const dom = new JSDOM('<body></body>');
  for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment']) {
    global[name] = name === 'document' ? dom.window.document : name === 'window' ? dom.window : dom.window[name];
  }
  const parsed = parsePage(PAGE_SOURCE, { locs: true });
  const tree = createTreeIndex(parsed.model.nodes);
  const document = { pathFor: (id) => tree.path(id) };
  const edits = await canvasPropEdits(document, {
    projectPath: 'ROOT',
    file: `ROOT/${PAGE}`,
    nodes: parsed.model.nodes,
    imports: parsed.model.imports,
    components: COMPONENTS,
    label: 'Component text',
    relative: (file) => file.slice('ROOT/'.length),
    read: async (file) => {
      const text = FILES[file.slice('ROOT/'.length)];
      const result = text === undefined ? undefined : parsePage(text, { locs: true });
      return result?.editable ? result.model : undefined;
    },
    setProp,
  });
  const find = (instance, prop) => edits.find((edit) => edit.target.scope === String(instance) && edit.prop?.name === prop);
  const secondHeading = find(1, 'heading');
  const firstText = find(0, 'text');
  check(
    'the planner offers the second Card heading and the first Card paragraph',
    secondHeading !== undefined && firstText !== undefined,
    JSON.stringify(edits.map((edit) => edit.target.key)),
  );
  if (!secondHeading || !firstText) {
    console.error(`component-prop-text-canvas: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }

  // The markup the preview renders: Heading's `h3` and Paragraph's `p` carry the path of the node in Card that drew them.
  const cardPath = (instance) => `src/components/item/Card.astro|0`;
  const headingPath = secondHeading.target.parent;
  const paragraphPath = firstText.target.parent;
  const card = (instance, heading, text) =>
    `<!--avb-s:${instance}--><div class="card_content" data-avb-p="${instance} ${cardPath(instance)}">` +
    `<h3 data-avb-p="${headingPath} src/components/typography/Heading.astro|0">${heading}</h3>` +
    `<p data-avb-p="${paragraphPath} src/components/typography/Paragraph.astro|0">${text}</p></div><!--avb-e:${instance}-->`;
  const checksum = crypto.createHash('sha256').update(PAGE_SOURCE).digest('hex');
  const markup =
    `<!doctype html><meta charset=utf-8><style>body{margin:0;font:20px/1.4 serif}.card_content{width:420px;margin-bottom:20px}h3,p{margin:0}</style><body>${stampComment({ file: PAGE, checksum })}` +
    card(0, 'Lorem ipsum dolor sit amet', 'First body words that sit in a paragraph.') +
    card(1, 'Second heading', 'Second body words.') +
    '</body>';
  const catalog = {
    type: 'avb:text-catalog',
    session: 'one',
    file: PAGE,
    checksum,
    targets: edits.map((edit) => edit.target),
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const body =
      url.pathname === '/host.html'
        ? '<!doctype html><meta charset=utf-8><style>html,body{margin:0}iframe{border:0;width:800px;height:700px;display:block}</style><iframe id="canvas" src="/canvas.html#avb-design"></iframe>' +
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

  const probeDirectory = repoPath('node_modules/.stacki-test/component-prop-text-canvas');
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
         show: false, width: 900, height: 750,
         webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true },
       });
       const out = {};
       const run = (code) => win.webContents.executeJavaScript(code);
       const frame = 'document.getElementById("canvas").contentWindow';
       const post = (message) => run(frame + '.postMessage(' + JSON.stringify(message) + ', "*")');
       await win.loadURL('http://127.0.0.1:${port}/host.html');
       await waitFor({ what: 'the page loaded', read: () => run('document.getElementById("canvas").contentDocument.querySelectorAll("h3").length'), until: (count) => count === 2 });
       await post({ type: 'avb:track', paths: ['0', '1'], scope: '', focus: '', focusOcc: 0 });
       await post(JSON.parse(fs.readFileSync(${JSON.stringify(catalogFile)}, 'utf8')));
       const centre = (selector, index) => run('(() => { const r = ' + frame + '.document.querySelectorAll(' + JSON.stringify(selector) + ')[' + index + '].getBoundingClientRect(); return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) }; })()');
       const posts = () => run('JSON.stringify(window.posts.filter((m) => /^avb:text/.test(m.type)))').then(JSON.parse);
       // With nothing selected, pointing at a Card's words outlines and names them at once; pointing at nothing does not.
       const point = (at) => win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
       const marksWithHover = (list) => list.filter((m) => m.type === 'avb:text-marks' && m.hover);
       out.hover = await waitFor({
         what: 'the heading was hovered with nothing selected',
         read: async () => {
           point(await centre('h3', 1));
           return marksWithHover(await posts());
         },
         until: (list) => list.length > 0,
       });
       await run('window.posts.length = 0');
       point({ x: 790, y: 690 });
       out.hoverGone = await waitFor({ what: 'the hover ended off the words', read: posts, until: (list) => list.some((m) => m.type === 'avb:text-marks' && !m.hover) });
       await run('window.posts.length = 0');
       // Selecting both Cards marks the words each can edit; four marks (two words a Card) mean the frame matched every target.
       await post({ type: 'avb:text-focus', paths: ['0', '1'] });
       out.marks = await waitFor({ what: 'the editable words were marked', read: () => run('document.getElementById("canvas").contentDocument.querySelector("[data-avb-text-marks]")?.children.length ?? 0'), until: (count) => count === 4 });
       const doubleClick = async (point) => {
         for (let n = 1; n <= 2; n++) {
           win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: n });
           win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: n });
         }
       };
       const edit = async (selector, index, typed) => {
         await run('window.posts.length = 0');
         // The frame answers a double click once its session has settled; until it does a click is not heard, so it is repeated while nothing answered.
         let attempts = 0;
         const answered = (list) => list.some((m) => m.type === 'avb:text-active' || m.type === 'avb:text-refused');
         const opened = await waitFor({
           what: 'the editor opened or refused',
           read: async () => {
             const list = await posts();
             if (!answered(list)) {
               attempts++;
               await doubleClick(await centre(selector, index));
             }
             return list;
           },
           until: answered,
         }).catch(async (error) => {
           console.log('DEBUG ' + JSON.stringify({ error: String(error).slice(0, 200), attempts, all: await run('JSON.stringify(window.posts.map((m) => m.type))') }));
           throw error;
         });
         out.attempts = (out.attempts || []).concat(attempts);
         win.webContents.focus();
         await win.webContents.insertText(typed);
         await post({ type: 'avb:text-close', session: 'one', action: 'apply' });
         const closed = await waitFor({ what: 'the save was posted', read: posts, until: (list) => list.some((m) => m.type === 'avb:text-save') });
         return { opened, closed };
       };
       out.heading = await edit('h3', 1, ' ADDED');
       out.paragraph = await edit('p', 0, ' ADDED');
       console.log('RESULT ' + JSON.stringify(out));
       app.quit();
     });`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = await new Promise((resolveRun) => {
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

  const line = run.stdout.split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) {
    check('the browser probe ran', false, `${run.stdout}\n${run.stderr}`.slice(0, 1500));
  } else {
    const result = JSON.parse(line.slice('RESULT '.length));
    const hovered = result.hover.at(-1)?.hover;
    check(
      'the Card heading is hovered before anything is selected, named for the component that draws it',
      hovered?.label === 'Heading' && hovered.w > 0 && hovered.h > 0,
      JSON.stringify(result.hover),
    );
    check(
      'pointing off the words ends the hover',
      result.hoverGone.some((message) => !message.hover),
      JSON.stringify(result.hoverGone),
    );
    check('the frame marks the Card heading and paragraph of both Cards as editable words', result.marks === 4, String(result.marks));
    const saved = (step, edit, what) => {
      const active = step.opened.find((message) => message.type === 'avb:text-active');
      check(`a double click on the ${what} opens its editor`, active?.key === edit.target.key, JSON.stringify(step.opened));
      const save = step.closed.find((message) => message.type === 'avb:text-save');
      check(`closing the ${what} editor posts a save for it`, save?.key === edit.target.key, JSON.stringify(step.closed));
      check(`the save carries the words typed in the ${what}`, typeof save?.value === 'string' && save.value.includes('ADDED'), JSON.stringify(save));
      return save;
    };
    const headingSave = saved(result.heading, secondHeading, 'second Card heading');
    const textSave = saved(result.paragraph, firstText, 'first Card paragraph');
    check('nothing was written while typing', fs.readFileSync(pageFile, 'utf8') === PAGE_SOURCE);
    if (headingSave && textSave) {
      await secondHeading.apply(headingSave.value);
      await pending;
      const afterHeading = fs.readFileSync(pageFile, 'utf8');
      const headingWords = headingSave.value.trim();
      check(
        'the heading write changes the second Card heading literal and no other byte',
        afterHeading === PAGE_SOURCE.replace('heading="Second heading"', `heading="${headingWords}"`),
        afterHeading,
      );
      await firstText.apply(textSave.value);
      await pending;
      const afterText = fs.readFileSync(pageFile, 'utf8');
      check(
        'the paragraph write changes the first Card text literal and no other byte',
        afterText === afterHeading.replace('text="First body words that sit in a paragraph."', `text="${textSave.value.trim()}"`),
        afterText,
      );
      check('each write was one applied page edit', writes.length === 2 && writes.every((write) => write.ok), JSON.stringify(writes));
      check(
        'the first Card heading and the second Card paragraph are untouched',
        afterText.includes('heading="Lorem ipsum dolor sit amet"') && afterText.includes('text="Second body words."'),
      );
      // One Undo per edit, newest first, writes the old bytes back.
      for (const inverse of [undo[1], undo[0]]) {
        const read = parsePageDiskRead(await harness.invoke('page:read', pageFile));
        const reply = parsePageEditResult(
          await harness.invoke('page:edit', { pagePath: pageFile, authoredChecksum: read.checksum, edit: { tag: 'revert', hunks: inverse } }),
        );
        check('an Undo applies', reply.ok === true, JSON.stringify(reply));
        if (inverse === undo[1]) {
          check('the first Undo restores the page before the paragraph edit', fs.readFileSync(pageFile, 'utf8') === afterHeading);
        }
      }
      check('the second Undo restores every byte of the page', fs.readFileSync(pageFile, 'utf8') === PAGE_SOURCE);
    }
  }
  harness.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  if (failures.length) {
    console.error(`component-prop-text-canvas: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`component-prop-text-canvas: ${checked}/${checked} passed`);
})();
