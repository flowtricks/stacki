// Goal: the strips hovering a Spacing side draws match the page a real browser lays out.
//
//   node test/electron/preload/spacingBandsLayout.test.js
//
// The owner pointed at `margin-top` and saw the band below the heading, not above it. jsdom lays nothing
// out, so margin collapse, flex parents and overflow clipping are only real in Chromium.
//
// Method: a real Electron window serves a host page with the canvas page in an iframe, the built preload
// running in both as in the app (see revealScrollsDown.test.js). The host tracks the fixture paths and reads
// the `avb:rects` the frame sends; spacingBands (the app's own function) turns those into strips, and each
// strip is checked against the element's real box and the real gap to its neighbour:
//   - a heading with margin-top 20px from a variable, under a sibling: the top strip is the 20px above it
//     and no strip is drawn below it,
//   - a margin as large as its sibling's: reported as collapsed, drawn as a marker, the larger keeps its strip,
//   - a first child whose margin passes through its parent: collapses with the parent,
//   - a child in an overflow:hidden parent, whose margin stays inside: no collapse, strip drawn,
//   - flex and grid items: never collapse, strip drawn,
//   - a margin from a `:where()` rule and from a `* + *` rule: the used margin, not the declared one.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const ROOT = '9';
const BODY = '9.1';
const node = (id, markup) => `<!--avb-s:${id}-->${markup}<!--avb-e:${id}-->`;
const FRAME_PAGE = `<!doctype html><!--avb-s:${ROOT}--><html data-avb-p="${ROOT}"><head><meta charset=utf-8>
<style>
  :root { --space-md: 20px; }
  html, body { margin: 0; }
  .block { height: 30px; background: #ccc; }
  .stack { padding: 1px 0; }
  .var-top { margin-top: var(--space-md); height: 40px; background: #36c; }
  :where(.owl) { margin-top: 24px; height: 40px; background: #3c6; }
  .owl-parent > * + * { margin-top: 18px; }
  .clip { overflow: hidden; height: 120px; }
  .flexbox { display: flex; flex-direction: column; }
  .gridbox { display: grid; }
</style></head><!--avb-s:${BODY}--><body data-avb-p="${BODY}">
  <div class="stack">
    ${node(0, '<h2 class="block" style="margin:0 0 20px">above</h2>')}
    ${node(1, '<h2 class="var-top" style="margin-bottom:16px">heading</h2>')}
  </div>
  <div class="stack">
    ${node(2, '<h2 class="block" style="margin:0 0 8px">above</h2>')}
    ${node(3, '<h2 class="var-top">heading</h2>')}
  </div>
  <section style="margin-top:12px">${node(4, '<h2 class="var-top">first child</h2>')}</section>
  <div class="clip">${node(5, '<h2 class="var-top">clipped</h2>')}</div>
  <div class="flexbox">${node(6, '<h2 class="block" style="margin:0 0 20px">a</h2>')}${node(7, '<h2 class="var-top">flex item</h2>')}</div>
  <div class="gridbox">${node(8, '<h2 class="var-top">grid item</h2>')}</div>
  <div class="stack">${node(9.5, '<h2 class="block" style="margin:0">above</h2>')}${node(10, '<h2 class="owl">where</h2>')}</div>
  <div class="owl-parent stack">${node(11, '<p class="block" style="margin:0">one</p>')}${node(12, '<p class="block">two</p>')}</div>
</body><!--avb-e:${BODY}--></html><!--avb-e:${ROOT}-->`;

const PATHS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9.5', '10', '11', '12'];

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('spacing-bands-layout: skipped  [needs a Chromium]');
    return;
  }
  const preload = repoPath('dist/electron/preload/preload.js');
  check('the preload is built', fs.existsSync(preload), preload);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/frame.html') {
      response.end(FRAME_PAGE);
    } else {
      response.end(
        '<!doctype html><meta charset=utf-8><style>html,body{margin:0}iframe{border:0;width:800px;height:900px;display:block}</style><iframe id="canvas" src="/frame.html#avb-design"></iframe><script>window.latest=undefined;addEventListener("message",(e)=>{if(e.data&&e.data.type==="avb:rects"){window.latest=e.data}})</script>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const probeDirectory = repoPath('node_modules/.stacki-test/spacing-bands-layout');
  fs.mkdirSync(probeDirectory, { recursive: true });
  const probe = path.join(probeDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow, ipcMain } = require('electron');
     app.disableHardwareAcceleration();
     ipcMain.on('boot:read', (event) => { event.returnValue = undefined; });
     app.on('window-all-closed', () => app.quit());
     const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 900, height: 950, webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true } });
       const run = (code) => win.webContents.executeJavaScript(code);
       await win.loadURL('http://127.0.0.1:${port}/host.html');
       const track = ${JSON.stringify(JSON.stringify({ type: 'avb:track', paths: PATHS, scope: '', focus: '', focusOcc: 0 }))};
       await waitFor({
         what: 'the frame reports its boxes',
         read: async () => {
           await run('document.getElementById("canvas").contentWindow.postMessage(' + track + ', "*")');
           return run('window.latest ? JSON.stringify(window.latest) : ""');
         },
         until: (text) => text !== '' && Object.keys(JSON.parse(text).spacing).length >= ${PATHS.length},
       });
       console.log(await run('JSON.stringify(window.latest)'));
       app.quit();
     });`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = await new Promise((resolve) => {
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

  const line = run.stdout.split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const { rects, spacing } = JSON.parse(line);
    const { spacingBands } = loadRenderer('src/features/preview/spacingBands.ts');
    const stripFor = (nodePath, side) => spacingBands(rects[nodePath][0], spacing[nodePath][0], 'margin', [side])[0];
    const boxOf = (nodePath) => rects[nodePath][0];

    // The reported heading: 20px from a variable, under a sibling with a 20px bottom margin.
    const sibling = boxOf('0');
    const heading = boxOf('1');
    check(
      'the page put the heading 20px below its sibling (the two margins collapsed)',
      Math.round(heading.y - (sibling.y + sibling.h)) === 20,
      JSON.stringify({ sibling, heading }),
    );
    check('the top margin resolves from the variable', spacing['1'][0].margin.top === 20, JSON.stringify(spacing['1'][0].margin));
    check(
      'and is reported collapsing with the previous element',
      spacing['1'][0].collapse?.top?.partner === 'previous',
      JSON.stringify(spacing['1'][0].collapse),
    );
    const collapsed = stripFor('1', 'top');
    check(
      'so hovering margin-top draws a marker at the heading top',
      collapsed && collapsed.collapsedInto === 'previous' && collapsed.h === 2 && collapsed.y === heading.y - 2,
      JSON.stringify(collapsed),
    );
    check('hovering margin-top never draws a strip below the heading', collapsed && collapsed.y < heading.y, JSON.stringify(collapsed));
    const bottom = stripFor('1', 'bottom');
    check('margin-bottom draws its 16px strip below', bottom && bottom.y === heading.y + heading.h && bottom.h === 16, JSON.stringify(bottom));

    // Under a smaller margin: the heading's 20px is the larger, so it keeps its strip.
    const larger = stripFor('3', 'top');
    check('the larger of two margins keeps its strip', larger && larger.collapsedInto === undefined && larger.h === 20, JSON.stringify(larger));
    check('and the strip is exactly the gap the page left', Math.round(boxOf('3').y - (boxOf('2').y + boxOf('2').h)) === 20);

    // A first child: its margin passes through the section, which has a 12px margin of its own.
    check('a first child collapses with its parent', spacing['4'][0].collapse?.top?.partner === 'parent', JSON.stringify(spacing['4'][0].collapse));
    check('and its strip is still 20px, above the parent', stripFor('4', 'top').h === 20 && stripFor('4', 'top').y === boxOf('4').y - 20);

    // Inside an overflow:hidden parent the margin stays inside it.
    check(
      'a margin inside an overflow:hidden parent collapses with nothing',
      spacing['5'][0].collapse?.top === undefined,
      JSON.stringify(spacing['5'][0].collapse),
    );
    check('and its strip is drawn whole', stripFor('5', 'top').h === 20 && stripFor('5', 'top').collapsedInto === undefined);

    // Flex and grid items never collapse.
    check('a flex item does not collapse', spacing['7'][0].collapse === undefined, JSON.stringify(spacing['7'][0].collapse));
    check('and draws a whole strip', stripFor('7', 'top').h === 20 && stripFor('7', 'top').collapsedInto === undefined);
    check('a grid item does not collapse', spacing['8'][0].collapse === undefined);

    // Margins from rules the author did not write on the element.
    check('a margin from a :where() rule is the used one', spacing['10'][0].margin.top === 24, JSON.stringify(spacing['10'][0].margin));
    check('and its strip is the 24px above the box', stripFor('10', 'top').h === 24);
    check('a margin from a `* + *` rule is the used one', spacing['12'][0].margin.top === 18, JSON.stringify(spacing['12'][0].margin));
    check('and the first of them, which the rule skips, has none', spacing['11'][0].margin.top === 0);
  }

  if (failures.length > 0) {
    console.error(`spacing-bands-layout: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`spacing-bands-layout: ${checked} checks passed`);
})();
