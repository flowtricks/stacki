// Goal: the "Move styles" list in Create component stays short and says when there is more. A short list (3 classes)
// shows whole with no scroller; a long one (40) stops at five and a half rows, so the last visible row is cut through
// its middle and not on a row boundary, scrolls inside its own rounded box (the title and help text stay outside it)
// with a stable scrollbar gutter, keeps the focused checkbox in view when tabbing, draws a class in the ordinary text
// colour (never the yellow of highlighted CSS) and its source in the dim text colour, in the dialog's window.
// Method: jsdom has no layout, so the real dialog is rendered in Electron with the stylesheets the app loads
// (the manner of test/renderer/cms/emdashDialogLayout.test.js), measured, and a screenshot of each case is written to
// node_modules/.stacki-test/move-styles-list/screens. Skipped where no Chromium is available.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, repoPath, sourceSpecifier } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');

const { measureSpeedFactor } = loadRenderer('test/helpers/scaleFixtures.ts');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('move-styles-list: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const esbuild = require('esbuild');
  const pageDirectory = repoPath('node_modules/.stacki-test/move-styles-list');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const entry = path.join(pageDirectory, 'entry.jsx');
  fs.writeFileSync(
    entry,
    `import React from 'react'
     import { createRoot } from 'react-dom/client'
     import { CreateComponentModal } from ${sourceSpecifier('src/features/palette/PaletteDialogs.tsx')}
     const candidates = (count) => Array.from({ length: count }, (_, index) => ({
       name: 'class-name-' + index,
       homes: [index % 2 === 0 ? { kind: 'page' } : { kind: 'stylesheet', rel: 'src/styles/base.css' }],
       reach: { kind: 'onlyHere' },
       checked: true,
     }))
     const root = createRoot(document.getElementById('root'))
     window.renderDialog = (count) => root.render(React.createElement(CreateComponentModal, {
       key: count,
       source: { kind: 'ready', name: 'Card', label: '<article>', plan: () => ({ values: [] }), styles: async () => candidates(count) },
       components: [], root: 'src/components', onClose() {}, onCreate() {},
     }))`,
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(pageDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(pageDirectory, 'app.css'),
    [
      'src/features/style/tokens.css',
      'src/ui/controls.css',
      'src/ui/dropdown.css',
      'src/app/styles.css',
      'src/ui/popup.css',
      'src/ui/menu.css',
      'src/ui/codeBlock.css',
      'src/features/palette/createComponent.css',
    ]
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css"><style>body{margin:0;background:#1a1a1a;color:#eee}</style><div id="root"></div><script src="bundle.js"></script>',
  );
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.disableHardwareAcceleration();
     const { MOTION_SETTLED_EXPRESSION, waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     const MEASURE = \`(() => {
       const list = document.querySelector('.move-styles .extract-value-list');
       const row = list.querySelector('.extract-value');
       const name = list.querySelector('.extract-value-name');
       const home = list.querySelector('.move-style-home');
       const modal = document.querySelector('.modal.create-component').getBoundingClientRect();
       const style = getComputedStyle(list);
       const rowHeight = row.getBoundingClientRect().height;
       const scrolled = list.scrollTop;
       return {
         rows: list.querySelectorAll('.extract-value').length,
         clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, rowHeight,
         visibleRows: (list.clientHeight - parseFloat(style.paddingTop)) / (rowHeight + parseFloat(style.rowGap)),
         overflowY: style.overflowY, gutter: style.scrollbarGutter, radius: style.borderTopLeftRadius,
         nameColour: getComputedStyle(name).color, nameFont: getComputedStyle(name).fontFamily,
         homeColour: getComputedStyle(home).color,
         textColour: getComputedStyle(row).color,
         titleInsideList: list.contains(document.querySelector('.move-styles .extract-values-head')),
         footInsideList: list.contains(document.querySelector('.move-styles .extract-values-foot')),
         modalBottom: modal.bottom, viewportHeight: innerHeight,
         coloured: [...name.querySelectorAll('[style]')].map((span) => span.getAttribute('style')),
       };
     })()\`;
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 900, height: 700 });
       await win.loadFile(path.join(__dirname, 'index.html'));
       const run = (code) => win.webContents.executeJavaScript(code);
       const screens = path.join(__dirname, 'screens');
       require('fs').mkdirSync(screens, { recursive: true });
       const results = {};
       for (const count of [3, 40]) {
         await run('window.renderDialog(' + count + ')');
         await waitFor({ what: 'the list', read: () => run("document.querySelectorAll('.move-styles .extract-value').length"), until: (shown) => shown === count });
         // The dialog scales open: measure once no popup is opening and no finite animation is running.
         await waitFor({ what: 'the dialog finished opening', read: () => run(MOTION_SETTLED_EXPRESSION), until: (settled) => settled === true });
         results['rows' + count] = await run(MEASURE);
         require('fs').writeFileSync(path.join(screens, 'rows-' + count + '.png'), (await win.webContents.capturePage()).toPNG());
       }
       // A long list stays quick: 400 rows mount and show their first rows well inside a second.
       const started = Date.now();
       await run('window.renderDialog(400)');
       await waitFor({ what: 'the long list', read: () => run("document.querySelectorAll('.move-styles .extract-value').length"), until: (shown) => shown === 400 });
       results.longMs = Date.now() - started;
       await run('window.renderDialog(40)');
       await waitFor({ what: 'the list again', read: () => run("document.querySelectorAll('.move-styles .extract-value').length"), until: (shown) => shown === 40 });
       // Tabbing to the 20th checkbox scrolls the list so that row is inside it.
       results.focus = await run(\`(() => {
         const list = document.querySelector('.move-styles .extract-value-list');
         const box = list.querySelectorAll('input[type=checkbox]')[20];
         box.focus();
         const inside = box.getBoundingClientRect(); const frame = list.getBoundingClientRect();
         return { scrollTop: list.scrollTop, inView: inside.top >= frame.top && inside.bottom <= frame.bottom };
       })()\`);
       await waitFor({ what: 'the scrolled list at rest', read: () => run(MOTION_SETTLED_EXPRESSION), until: (settled) => settled === true });
       require('fs').writeFileSync(path.join(screens, 'rows-40-scrolled.png'), (await win.webContents.capturePage()).toPNG());
       console.log(JSON.stringify(results));
       app.quit();
     }).catch((error) => { console.log(JSON.stringify({ probeError: String(error) })); app.quit(); });`,
  );
  const ran = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (ran.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (ran.stderr || ran.stdout || '').slice(0, 800));
  } else {
    const results = JSON.parse(line);
    if (results.probeError !== undefined) {
      console.error(`move-styles-list: the probe failed: ${results.probeError}`);
      process.exit(1);
    }
    const short = results.rows3;
    const long = results.rows40;
    check('3 rows show whole, with nothing to scroll', short.scrollHeight <= short.clientHeight, JSON.stringify(short));
    check('40 rows scroll inside the list', long.scrollHeight > long.clientHeight, JSON.stringify(long));
    check('the list is a vertical scroller with a stable gutter', long.overflowY === 'auto' && long.gutter === 'stable', JSON.stringify(long));
    check('and the short one reserves the same gutter', short.gutter === 'stable', JSON.stringify(short));
    const fraction = long.visibleRows - Math.floor(long.visibleRows);
    check('the height cuts through a row, near its middle', fraction > 0.35 && fraction < 0.65, String(long.visibleRows));
    check('the height is not a multiple of the row height', long.clientHeight % long.rowHeight > 4, JSON.stringify(long));
    check('five rows show whole and the sixth is half', Math.floor(long.visibleRows) === 5, String(long.visibleRows));
    check('the box keeps its rounded corners', parseFloat(long.radius) > 0, long.radius);
    check('title and help text stay outside the scroller', !long.titleInsideList && !long.footInsideList, JSON.stringify(long));
    check('the dialog stays inside the window', long.modalBottom <= long.viewportHeight, JSON.stringify(long));
    check('a class is in the row text colour, not a syntax colour', long.nameColour === long.textColour, JSON.stringify(long));
    check('no highlighted token inside a class name', long.coloured.length === 0, JSON.stringify(long.coloured));
    check('a class stays monospace', /mono|Mono|Consolas|monospace/.test(long.nameFont), long.nameFont);
    check('its source is the dimmer colour', long.homeColour !== long.nameColour, JSON.stringify([long.homeColour, long.nameColour]));
    // The bound is a second and a half on the reference machine, scaled by how slow this one runs a fixed workload.
    const longMsBound = 1500 * measureSpeedFactor();
    check('400 rows mount quickly', results.longMs < longMsBound, `${results.longMs} ms against ${Math.round(longMsBound)} ms`);
    check('tabbing to a far row scrolls it into view', results.focus.inView && results.focus.scrollTop > 0, JSON.stringify(results.focus));
  }
  if (failures.length > 0) {
    console.error(`move-styles-list: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`move-styles-list: ${checked} checks passed`);
})();
