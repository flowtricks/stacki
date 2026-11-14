// Goal: choosing Base in the context dropdown lands the canvas where Base is the layer in
// effect, by the project's own query convention (src/features/style/model/baseWidth.ts):
// one pixel under the smallest of mobile-first width queries, one over the largest of
// desktop-first ones, and the desktop preset when there is no single convention. The
// boundary is the one a pick of that query lands on (canvasWidthForQuery), so the two never
// disagree, and switching from Base back to a query lands on that query's own width.
// Method: the pure model over each convention and its negative space (mixed sides, a range,
// an unmeasurable unit, no width query, a non-width query that must be ignored, a width the
// canvas cannot draw). Then the landed widths are checked against a real browser: Electron
// draws an iframe at each width and its matchMedia must report none of the convention's
// queries matching. That half is skipped, with a note, where no Electron is installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadRenderer = require('../../helpers/rendererModule.js');

const { baseCanvasTarget } = loadRenderer('src/features/style/model/baseWidth.ts');
const { canvasWidthForQuery } = loadRenderer('src/features/style/model/queryWidth.ts');
const ROOT_PX = 16;

const MOBILE_FIRST = ['@media (width >= 30rem)', '@media (width >= 48rem)', '@media (width >= 64rem)'];
const DESKTOP_FIRST = ['@media (max-width: 767px)', '@media (max-width: 991px)', '@media (width < 30rem)'];
const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

test('mobile first: Base lands one pixel under the smallest query, which it no longer matches', () => {
  assert.deepEqual(baseCanvasTarget(['', ...MOBILE_FIRST], ROOT_PX), { kind: 'width', widthPx: 479 });
  const boundary = canvasWidthForQuery(MOBILE_FIRST[0], ROOT_PX);
  assert.deepEqual(boundary, { kind: 'width', widthPx: 480 }, 'and picking that query lands one pixel above, on its boundary');
});

test('desktop first: Base lands one pixel over the largest query', () => {
  assert.deepEqual(baseCanvasTarget(DESKTOP_FIRST, ROOT_PX), { kind: 'width', widthPx: 992 });
});

test('a query that says nothing about width is not part of the convention', () => {
  assert.deepEqual(baseCanvasTarget([...MOBILE_FIRST, REDUCED_MOTION, '@supports (display: grid)', '@container card (width > 20rem)'], ROOT_PX), {
    kind: 'width',
    widthPx: 479,
  });
});

test('no single convention goes to the desktop preset', () => {
  assert.deepEqual(baseCanvasTarget(['', REDUCED_MOTION], ROOT_PX), { kind: 'desktop' }, 'no width query');
  assert.deepEqual(baseCanvasTarget([], ROOT_PX), { kind: 'desktop' }, 'no query at all');
  assert.deepEqual(baseCanvasTarget([MOBILE_FIRST[0], DESKTOP_FIRST[0]], ROOT_PX), { kind: 'desktop' }, 'lower and upper mixed');
  assert.deepEqual(baseCanvasTarget(['@media (30rem <= width < 48rem)'], ROOT_PX), { kind: 'desktop' }, 'a range');
  assert.deepEqual(baseCanvasTarget([...MOBILE_FIRST, '@media (min-width: 40em)'], ROOT_PX), { kind: 'desktop' }, 'a width it cannot measure');
  assert.deepEqual(baseCanvasTarget(['@media (width >= 30rem), print'], ROOT_PX), { kind: 'desktop' }, 'a query list');
});

test('a Base width the canvas cannot draw leaves the canvas where it is', () => {
  assert.deepEqual(baseCanvasTarget(['@media (min-width: 280px)'], ROOT_PX), { kind: 'keep' });
});

// The real browser's answer at each landed width: Electron, an iframe that wide, matchMedia.
test("at the landed width the browser matches none of the convention's queries", (context) => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    context.skip('no Electron to ask');
    return;
  }
  const cases = [
    { queries: MOBILE_FIRST, target: baseCanvasTarget(MOBILE_FIRST, ROOT_PX) },
    { queries: DESKTOP_FIRST, target: baseCanvasTarget(DESKTOP_FIRST, ROOT_PX) },
  ].map(({ queries, target }) => {
    assert.equal(target.kind, 'width');
    return { widthPx: target.widthPx, conditions: queries.map((query) => query.replace(/^@media\s+/, '')) };
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-base-width-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 1400, height: 400 });
       await win.loadURL('data:text/html,<!doctype html><body style="margin:0"></body>');
       const cases = ${JSON.stringify(cases)};
       const answers = await win.webContents.executeJavaScript(\`(async () => {
         const out = [];
         for (const item of \${JSON.stringify(cases)}) {
           const frame = document.createElement('iframe');
           frame.style.cssText = 'border:0;height:100px;width:' + item.widthPx + 'px';
           document.body.appendChild(frame);
           await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
           out.push({ widthPx: frame.contentWindow.innerWidth, matches: item.conditions.map((condition) => frame.contentWindow.matchMedia(condition).matches) });
           frame.remove();
         }
         return out;
       })()\`);
       process.stdout.write('ANSWERS' + JSON.stringify(answers) + '\\n');
       app.quit();
     });`,
  );
  const { spawnSync } = require('node:child_process');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 60_000, env: environment });
  const line = (run.stdout ?? '').split('\n').find((text) => text.startsWith('ANSWERS'));
  assert.ok(line, `the browser answered: ${run.stderr ?? ''}`);
  const answers = JSON.parse(line.slice('ANSWERS'.length));
  for (const [index, answer] of answers.entries()) {
    assert.equal(answer.widthPx, cases[index].widthPx, 'the frame is the landed width');
    assert.deepEqual(
      answer.matches,
      cases[index].conditions.map(() => false),
      `at ${answer.widthPx}px no query of ${cases[index].conditions.join(', ')} matches`,
    );
  }
});
