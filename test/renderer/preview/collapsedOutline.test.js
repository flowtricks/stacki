// A selected element with no size still shows where it is: an outline and its name tag.
//
//   node test/renderer/preview/collapsedOutline.test.js
//
// Goal: pin the bug where an empty `div` (0px wide, 0px tall) was selected in the navigator and the canvas drew nothing. The frame
// measured no box for it, so no rectangle reached the overlay, and a 0px outline would have been invisible anyway.
//
// Methodology: a hidden Electron window (real Chromium layout) loads the frame's own measuring module (rectsForPath, bundled from
// electron/preload/frameMeasure.ts) over a page of collapsed cases: an empty block in a centred flex column, an empty inline element,
// an empty `display: contents` element, a wrapper whose only child is absolutely positioned, and a `display: none` element. Each
// reported rectangle then goes through markerBox (src/features/preview/outlineBoxes.ts) into a `.node-outline` drawn with the app's real
// stylesheet, and the test reads the drawn outline and its name tag back. Nothing waits on timing; the page is static. The unit
// checks on markerBox itself run in Node, including the invalid inputs.
const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const { collapseKind, sizeText, onePerPlace, copiesToDraw } = loadRenderer('src/features/preview/outlineBoxes.ts');
const point = { x: 40, y: 60, w: 0, h: 0 };
check('a box with no width and no height is a point', collapseKind(point) === 'point');
check('a box with width and no height is flat', collapseKind({ x: 0, y: 0, w: 300, h: 0 }) === 'flat');
check('a box with height and no width is flat', collapseKind({ x: 0, y: 0, w: 0, h: 20 }) === 'flat');
check('a sized box is not collapsed', collapseKind({ x: 0, y: 0, w: 300, h: 200 }) === 'none');
check('a fraction of a pixel counts as no size', collapseKind({ x: 0, y: 0, w: 0.4, h: 0.4 }) === 'point');
check('a point says 0 × 0', sizeText(point) === '0 × 0', sizeText(point));
check('a flat box says its real width', sizeText({ x: 0, y: 0, w: 300.4, h: 0 }) === '300 × 0');
let badWidth = '';
try {
  collapseKind({ x: 0, y: 0, w: Number.NaN, h: 0 });
} catch (error) {
  badWidth = String(error);
}
check('a width that is not a number is a bug', badWidth.includes('a box has a finite width'), badWidth);
let badHeight = '';
try {
  sizeText({ x: 0, y: 0, w: 0, h: Number.POSITIVE_INFINITY });
} catch (error) {
  badHeight = String(error);
}
check('a height that is not finite is a bug', badHeight.includes('a box has a finite height'), badHeight);
check('a lone collapsed box is drawn', onePerPlace([point]).length === 1);
check(
  'a hollow copy beside a sized one is not',
  onePerPlace([point, { x: 0, y: 0, w: 50, h: 20 }]).length === 1 && onePerPlace([point, { x: 0, y: 0, w: 50, h: 20 }])[0].w === 50,
);
check('a collapsed copy picked by occurrence is drawn', copiesToDraw([point], 0).length === 1);

const CASES = [
  [
    'an empty block with no size in a centred flex column',
    '<div style="display:flex;flex-direction:column;align-items:center;width:400px;padding:20px"><div id="c0" data-avb-p="0.0"></div></div>',
    true,
  ],
  ['an empty inline-block', '<p style="padding:20px">text <span id="c1" data-avb-p="0.1" style="display:inline-block"></span> more</p>', true],
  ['an empty inline element', '<p style="padding:20px">text <span id="c2" data-avb-p="0.2"></span> more</p>', true],
  ['an empty display: contents element', '<div style="padding:20px"><i>before</i><div id="c3" data-avb-p="0.3" style="display:contents"></div></div>', true],
  [
    'a wrapper whose only child is absolutely positioned',
    '<div id="c4" data-avb-p="0.4" style="display:inline-block"><b style="position:absolute;left:300px;top:300px;width:50px;height:50px">x</b></div>',
    true,
  ],
  ['a display: none element', '<div id="c5" data-avb-p="0.5" style="display:none"></div>', false],
];

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadFile(path.join(__dirname, 'index.html'));
  const result = await win.webContents.executeJavaScript('window.__measure()');
  console.log('RESULT ' + JSON.stringify(result));
  if (process.env.COLLAPSED_SHOT) {
    const image = await win.webContents.capturePage();
    require('fs').writeFileSync(process.env.COLLAPSED_SHOT, image.toPNG());
  }
  app.quit();
});`;

const MEASURE = `
window.__measure = () => {
  const out = [];
  for (const [index, mark] of window.__cases.entries()) {
    const rects = window.__frame.rectsForPath('0.' + index) || [];
    const drawn = [];
    for (const rect of rects) {
      const box = rect;
      const kind = window.__boxes.collapseKind(box);
      const outline = document.createElement('div');
      outline.className = 'node-outline sel element collapsed is-' + kind;
      outline.style.cssText = 'left:' + box.x + 'px;top:' + box.y + 'px;width:' + box.w + 'px;height:' + box.h + 'px';
      outline.innerHTML = '<span class="node-outline-tag ' + (box.y < 20 ? 'inside' : '') + '">div <span class="node-outline-size">' + window.__boxes.sizeText(box) + '</span></span>';
      document.body.append(outline);
      const outer = outline.getBoundingClientRect();
      const tag = outline.firstChild.getBoundingClientRect();
      const arm = (pseudo) => {
        const style = getComputedStyle(outline, pseudo);
        return { w: parseFloat(style.width) || 0, h: parseFloat(style.height) || 0 };
      };
      drawn.push({
        rect,
        kind,
        outline: { w: outer.width, h: outer.height },
        tag: { w: tag.width, h: tag.height },
        text: outline.firstChild.textContent,
        across: arm('::before'),
        down: arm('::after'),
      });
    }
    out.push({ rects: rects.length, drawn });
  }
  return out;
};`;

(async () => {
  const esbuild = require('esbuild');
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('collapsed-outline: skipped  [needs a Chromium]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/collapsed-outline');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.ts');
  fs.writeFileSync(
    entry,
    `import * as frame from '${path.join(ROOT, 'electron/preload/frameMeasure.ts')}';
import * as boxes from '${path.join(ROOT, 'src/features/preview/outlineBoxes.ts')}';
(window as unknown as Record<string, unknown>)['__frame'] = frame;
(window as unknown as Record<string, unknown>)['__boxes'] = boxes;`,
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(directory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(directory, 'measure.js'), `window.__cases = ${JSON.stringify(CASES.map((entry) => entry[0]))};${MEASURE}`);
  const css = ['src/features/style/tokens.css', 'src/app/styles.css'].map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  fs.writeFileSync(path.join(directory, 'app.css'), css);
  const body = CASES.map(
    ([, html], index) => `<section style="position:relative;height:80px">${html.replace(/data-avb-p="0\.\d"/, `data-avb-p="0.${index}"`)}</section>`,
  ).join('');
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css"><style>body{margin:0;background:#fff}</style>${body}<script src="bundle.js"></script><script src="measure.js"></script>`,
  );
  fs.writeFileSync(path.join(directory, 'probe.js'), PROBE);
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [path.join(directory, 'probe.js')], { encoding: 'utf8', timeout: 120000, env });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const results = JSON.parse(line.slice('RESULT '.length));
    for (const [index, [name, , shown]] of CASES.entries()) {
      const entry = results[index];
      if (!shown) {
        check(`${name}: nothing to draw`, entry.rects === 0, JSON.stringify(entry));
        continue;
      }
      check(`${name}: the frame reports a place`, entry.rects > 0, JSON.stringify(entry));
      const first = entry.drawn[0];
      if (!first) {
        continue;
      }
      const detail = JSON.stringify(first);
      check(`${name}: the real size is kept, not grown to a box`, first.kind === 'point' ? first.outline.w < 1 && first.outline.h < 1 : true, detail);
      if (first.kind === 'point') {
        check(`${name}: the crosshair arm across is a hairline`, first.across.h <= 1, detail);
        check(`${name}: the crosshair arm across is findable`, first.across.w >= 10, detail);
        check(`${name}: the crosshair arm down is a hairline`, first.down.w <= 1, detail);
        check(`${name}: the crosshair arm down is findable`, first.down.h >= 10, detail);
        check(`${name}: the tag says it is 0 × 0`, first.text.includes('0 × 0'), detail);
      }
      check(`${name}: its name tag is drawn`, first.tag.w > 0, JSON.stringify(first));
      check(`${name}: its name tag has a height`, first.tag.h > 0, JSON.stringify(first));
    }
  }
  if (failures.length) {
    console.error(`collapsed-outline: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`collapsed-outline: ${checked} passed  [real layout]`);
})();
