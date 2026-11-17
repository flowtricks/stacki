// Goal: on a page shaped like a real site, double-clicking text printed from data opens its editor and
// the save writes the string the data comes from; text that cannot be written is refused by name and
// never ignored. The regression: `const { aiCallout1 } = await getPage("home")` (data destructured from
// an awaited call, spread from a namespace import inside the function) was traced to nothing, so the
// double click did nothing at all.
//   node test/electron/preload/boundTextCanvas.test.js
// Method: a fixture project mirrors the site's structure (a page importing getPage, a content index that
// re-exports it, getPage choosing a module by its literal argument, a content module with a curly quote
// and an ampersand, a RichText component with a slot). The real planner traces it from real files; the
// catalog it builds goes to the real built preload in a real Electron window over the markup the preview
// renders; real mouse events (click count 2) and typing drive it; what the frame posts is read back and
// the save is applied through the same plan, on a copy of the files.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const loadRenderer = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { stampComment } = loadRenderer('shared/page/previewToken.ts');
const { canvasBoundEdits } = loadRenderer('src/app/model/canvasBoundText.ts');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const BODY =
  'AI has raised the stakes: Webflow’s platform — for humans & machines, with a very long sentence that keeps going so the paragraph wraps onto more than one line of the canvas.';
const FILES = {
  'src/pages/index.astro': [
    '---',
    'import { getPage } from "@lib/content";',
    'const { aiCallout1, joined } = await getPage("home");',
    '---',
    '<RichText size="xl" class="lead">',
    '  <p>{aiCallout1.body}</p>',
    '</RichText>',
    '<RichText>',
    '  <p>{joined}</p>',
    '</RichText>',
    '',
  ].join('\n'),
  'src/components/RichText.astro': '---\nconst { size = "base" } = Astro.props;\n---\n<div class={`rich-text rich-text--${size}`}><slot /></div>\n',
  'src/lib/content/index.ts': 'export { getPage } from "./pages";\n',
  'src/lib/content/pages.ts': [
    'import * as homeContent from "@lib/homepage/content";',
    'export async function getPage(id: "home"): Promise<typeof homeContent>;',
    'export async function getPage(id: "home" | "other") {',
    '  if (id === "home") {',
    '    return { ...homeContent, document: {} };',
    '  }',
    '  return {};',
    '}',
    '',
  ].join('\n'),
  'src/lib/homepage/content.ts': `export const aiCallout1 = {\n  body: ${JSON.stringify(BODY)},\n  cta: { label: "Go", href: "/" },\n};\nexport const joined = "a" + "b";\n`,
};
const PAGE = 'src/pages/index.astro';

function resolve(root, from, spec) {
  const base = spec.startsWith('@lib/') ? path.join(root, 'src/lib', spec.slice(5)) : path.resolve(root, path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      // Project paths cross the bridge with `/`, as `src:resolvePath` answers them, on Windows too.
      return path.relative(root, candidate).split(path.sep).join('/');
    }
  }
  return undefined;
}

// The markup the preview renders for the page: a component's root tagged with its file and the instance,
// its slot's elements with the page's own paths, each node between its marker comments.
const rendered = (checksum, escaped) =>
  `<!doctype html><meta charset=utf-8><style>body{margin:0;font:20px/1.4 serif}.rich-text{width:420px}</style><body>${stampComment({ file: PAGE, checksum })}` +
  `<!--avb-s:0--><div class="rich-text rich-text--xl lead" data-avb-p="src/components/RichText.astro|0 0">` +
  `<!--avb-s:0.0--><p data-avb-p="0.0">${escaped(BODY)}</p><!--avb-e:0.0--></div><!--avb-e:0-->` +
  `<!--avb-s:1--><div class="rich-text rich-text--base" data-avb-p="src/components/RichText.astro|0 1">` +
  `<!--avb-s:1.0--><p data-avb-p="1.0">ab</p><!--avb-e:1.0--></div><!--avb-e:1-->` +
  `</body>`;
const escapeHTML = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('bound-text-canvas: skipped  [needs a Chromium]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-bound-text-'));
  for (const [file, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const source = FILES[PAGE];
  const parsed = parsePage(source, { locs: true });
  const writes = [];
  const document = {
    file: PAGE,
    projectPath: root,
    source,
    nodes: parsed.model.nodes,
    pathFor: (id) => id.replace(/^n/, ''),
    apply: async () => {
      throw new Error('the page markup must not be edited');
    },
    report: () => {},
    loadContent: async () => [],
  };
  const host = {
    readModule: async (from, spec) => {
      const rel = resolve(root, from, spec);
      return rel === undefined ? undefined : { file: rel, text: fs.readFileSync(path.join(root, rel), 'utf8') };
    },
    readFile: async (file) => fs.readFileSync(path.join(root, file), 'utf8'),
    writeModule: async ({ file, before, after }) => {
      if (fs.readFileSync(path.join(root, file), 'utf8') !== before) {
        throw new Error('changed');
      }
      fs.writeFileSync(path.join(root, file), after);
      writes.push(file);
    },
    undo: async () => {},
  };
  const edits = await canvasBoundEdits(document, host, { saved: () => '', undo: 'Undo', sourceChanged: 'changed' });
  const sourceEdit = edits.find((edit) => edit.bound.kind === 'source');
  const blockedEdit = edits.find((edit) => edit.bound.kind === 'blocked');
  check(
    'the planner traces the page through the awaited call to the content module',
    sourceEdit?.bound.file === 'src/lib/homepage/content.ts',
    JSON.stringify(edits.map((edit) => edit.bound)),
  );
  check('and offers the words as the canvas shows them', sourceEdit?.target.value === BODY);
  check('the joined text is refused by name, not left out', blockedEdit?.bound.reason === 'concatenation', JSON.stringify(blockedEdit?.bound));
  if (!sourceEdit || !blockedEdit) {
    console.error(`bound-text-canvas: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  const checksum = crypto.createHash('sha256').update(source).digest('hex');
  const catalog = {
    type: 'avb:text-catalog',
    session: 'one',
    file: PAGE,
    checksum,
    targets: edits.filter((edit) => edit.bound.kind === 'source').map((edit) => edit.target),
    blocked: edits.filter((edit) => edit.bound.kind === 'blocked').map((edit) => ({ key: edit.target.key, path: edit.target.path })),
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const body =
      url.pathname === '/host.html'
        ? '<!doctype html><meta charset=utf-8><style>html,body{margin:0}iframe{border:0;width:800px;height:700px;display:block}</style><iframe id="canvas" src="/canvas.html#avb-design"></iframe>' +
          '<script>window.posts=[];addEventListener("message",(e)=>posts.push(e.data));</script>'
        : url.pathname === '/canvas.html'
          ? rendered(checksum, escapeHTML)
          : undefined;
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? '');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const probeDirectory = repoPath('node_modules/.stacki-test/bound-text-canvas');
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
       const run = (code) => win.webContents.executeJavaScript(code);
       const frame = 'document.getElementById("canvas").contentWindow';
       const post = (message) => run(frame + '.postMessage(' + JSON.stringify(message) + ', "*")');
       await win.loadURL('http://127.0.0.1:${port}/host.html');
       const answered = ${JSON.stringify(`new Promise((resolve) => {
         const f = document.getElementById('canvas').contentWindow;
         const heard = (event) => { if (event.data && event.data.type === 'test:pong') { removeEventListener('message', heard); resolve(true); } };
         addEventListener('message', heard);
         f.postMessage({ type: 'test:ping' }, '*');
         setTimeout(() => { removeEventListener('message', heard); resolve(false); }, 250);
       })`)};
       await waitFor({ what: 'the page loaded', read: () => run('document.getElementById("canvas").contentDocument.querySelectorAll("p").length'), until: (count) => count === 2 });
       await post({ type: 'avb:track', paths: ['0', '0.0', '1', '1.0'], scope: '', focus: '', focusOcc: 0 });
       await post(JSON.parse(fs.readFileSync(${JSON.stringify(catalogFile)}, 'utf8')));
       await new Promise((resolve) => setTimeout(resolve, 600));
       const centre = (index) => run('(() => { const r = ' + frame + '.document.querySelectorAll("p")[' + index + '].getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }; })()');
       const click = async (point, count) => {
         for (let n = 1; n <= count; n++) {
           win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: n });
           win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: n });
         }
         await new Promise((resolve) => setTimeout(resolve, 500));
       };
       const posts = () => run('JSON.stringify(window.posts.filter((m) => /^avb:text/.test(m.type)))').then(JSON.parse);
       const out = {};
       // A double click on blocked text.
       await click(await centre(1), 2);
       out.afterBlocked = await posts();
       await run('window.posts.length = 0');
       // A single click only selects: no editor.
       await click(await centre(0), 1);
       out.afterSingle = await posts();
       // The double click on the bound text, then typing, then closing the editor.
       await click(await centre(0), 2);
       out.afterDouble = await posts();
       win.webContents.focus();
       await win.webContents.insertText(' ADDED’s');
       await new Promise((resolve) => setTimeout(resolve, 200));
       await post({ type: 'avb:text-close', session: 'one', action: 'apply' });
       await new Promise((resolve) => setTimeout(resolve, 500));
       out.afterSave = await posts();
       out.paragraph = await run(frame + '.document.querySelectorAll("p")[0].textContent');
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
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const result = JSON.parse(line.slice('RESULT '.length));
    const types = (messages) => messages.map((message) => message.type + (message.reason ? `:${message.reason}` : ''));
    check(
      'a double click on text that cannot be written is refused by name',
      types(result.afterBlocked).includes('avb:text-refused:source-blocked'),
      JSON.stringify(result.afterBlocked),
    );
    check(
      'the refusal carries the blocked text’s key',
      result.afterBlocked.some((message) => message.key === blockedEdit.target.key),
      JSON.stringify(result.afterBlocked),
    );
    check('a single click on bound text does not open the editor', !types(result.afterSingle).includes('avb:text-active'), JSON.stringify(result.afterSingle));
    const active = result.afterDouble.find((message) => message.type === 'avb:text-active');
    check('a double click on the bound text opens its editor', active?.key === sourceEdit.target.key, JSON.stringify(result.afterDouble));
    check('and reports the box the cue anchors to', active?.rect?.w > 0 && active?.rect?.h > 0, JSON.stringify(active));
    const save = result.afterSave.find((message) => message.type === 'avb:text-save');
    check('closing the editor posts a save for that text', save?.key === sourceEdit.target.key, JSON.stringify(result.afterSave));
    check('the save carries the words typed, curly quote included', typeof save?.value === 'string' && save.value.includes('ADDED’s'), JSON.stringify(save));
    if (save) {
      await sourceEdit.apply(save.value);
      const after = fs.readFileSync(path.join(root, 'src/lib/homepage/content.ts'), 'utf8');
      check(
        'applying it writes the content module and nothing else',
        writes.length === 1 && writes[0] === 'src/lib/homepage/content.ts',
        JSON.stringify(writes),
      );
      check(
        'the literal carries the typed words, byte for byte elsewhere',
        after === FILES['src/lib/homepage/content.ts'].replace(JSON.stringify(BODY), JSON.stringify(save.value)),
        after,
      );
      check('the page and the component are untouched', fs.readFileSync(path.join(root, PAGE), 'utf8') === source);
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  if (failures.length) {
    console.error(`bound-text-canvas: ${failures.length}/${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`bound-text-canvas: ${checked}/${checked} passed`);
})();
