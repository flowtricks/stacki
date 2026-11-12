// The Apps panel's empty state is left-aligned: its icon tile, its sentence and
// the hint that points at the header's + menu all start at the panel's content
// inset, and the hint stays inside the panel. The state has no button of its
// own (adding an app is the + menu alone), so the base button rule cannot
// centre anything here; the old split button once sat centred under a
// left-aligned sentence.
//
//   node test/renderer/apps/appsEmptyLayout.test.js
//
// jsdom has no layout, so this is measured in a real browser: the empty state
// the panel renders (react-dom/server over the real component), under the app's
// stylesheets, in a 280px-wide panel.
const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('apps-empty-layout: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const pageDirectory = repoPath('node_modules/.stacki-test/apps-empty-layout');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const bundle = path.join(pageDirectory, 'panel.cjs');
  buildSync({
    entryPoints: [repoPath('src/features/apps/AppsPanel.tsx')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { EmptyApps } = require(bundle);
  const install = { admin: true, busy: false, connect() {}, buildApp() {} };
  const markup = renderToStaticMarkup(React.createElement(EmptyApps, { install }));
  fs.writeFileSync(
    path.join(pageDirectory, 'app.css'),
    [
      'src/features/style/tokens.css', // The sheets styles.css imports first (its @import is not followed in a concatenation).
      'src/ui/controls.css',
      'src/ui/dropdown.css',
      'src/ui/resetLabel.css',
      'src/app/styles.css',
      'src/features/apps/apps.css',
    ]
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css"><style>body{margin:0;background:#1a1a1a}</style>' +
      `<div class="apps-panel" style="width:280px"><div class="panel-body apps-body">${markup}</div></div>`,
  );
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 600, height: 600 });
       await win.loadFile(path.join(__dirname, 'index.html'));
       const result = await win.webContents.executeJavaScript(\`(() => {
         const left = (element) => Math.round(element.getBoundingClientRect().left);
         const text = document.querySelector('.apps-empty > p');
         return {
           tile: left(document.querySelector('.apps-empty-icon')),
           text: left(text),
           textAlign: getComputedStyle(text).textAlign,
           hint: (() => {
             const hint = document.querySelector('.apps-empty > .apps-note');
             const box = hint.getBoundingClientRect();
             return { left: Math.round(box.left), right: Math.round(box.right), text: hint.textContent, textAlign: getComputedStyle(hint).textAlign };
           })(),
           buttons: document.querySelectorAll('.apps-empty button').length,
           bodyRight: Math.round(document.querySelector('.apps-empty').getBoundingClientRect().right - parseFloat(getComputedStyle(document.querySelector('.apps-empty')).paddingRight)),
           panelRight: Math.round(document.querySelector('.apps-panel').getBoundingClientRect().right),
         };
       })()\`);
       console.log(JSON.stringify(result));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const measured = JSON.parse(line);
    const hint = measured.hint;
    check('the tile starts where the sentence does', measured.tile === measured.text, line);
    check('the sentence is left-aligned', measured.textAlign === 'left' || measured.textAlign === 'start', line);
    check('the hint points at the + menu', hint.text === 'Use + to add an app.', hint.text);
    check('the hint starts where the sentence does', hint.left === measured.text, `${hint.left} vs ${measured.text}`);
    check('the hint is left-aligned', hint.textAlign === 'left' || hint.textAlign === 'start', hint.textAlign);
    check('the hint stays inside the content column', hint.right <= measured.bodyRight, `${hint.right} vs ${measured.bodyRight}`);
    check('the empty state has no button of its own', measured.buttons === 0, line);
    check('it stays inside the panel', hint.right <= measured.panelRight, line);
  }
  if (failures.length) {
    console.error(`apps-empty-layout: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`apps-empty-layout: ${checked} passed  [real layout]`);
})();
