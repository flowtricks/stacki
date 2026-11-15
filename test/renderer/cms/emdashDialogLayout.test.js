// Goal: the EmDash dialog never scrolls sideways, at any width the window can give it. A long install command, a long file
// name and a long unbroken line of install output wrap or are cut with an ellipsis inside the dialog; the dialog, its
// body and every code block have scrollWidth no larger than clientWidth, at 320 px and at 480 px, in the preview with its
// details open and in the running state with a very long log line; and only the body scrolls, vertically.
// Method: jsdom has no layout, so the real dialog is rendered in Electron with the stylesheets the app loads, over a fake
// preload bridge (a long plan, a run that never ends, a log pushed by the test), and the boxes are measured after each
// step shows what it should (bounded waits, test/helpers/waitFor.js). Skipped where no Chromium is available.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath, sourceSpecifier } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('emdash-dialog-layout: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const esbuild = require('esbuild');
  const pageDirectory = repoPath('node_modules/.stacki-test/emdash-dialog-layout');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const entry = path.join(pageDirectory, 'entry.jsx');
  fs.writeFileSync(
    entry,
    `import React from 'react'
     import { createRoot } from 'react-dom/client'
     import { EmDashDialog } from ${sourceSpecifier('src/features/cmsConnections/EmDashDialog.tsx')}
     const listeners = new Set()
     window.pushLog = (text) => listeners.forEach((listener) => listener(text))
     window.avb = {
       emDashInstallPlan: async () => ({
         kind: 'ready', manager: 'pnpm', saveFirst: true, warnings: ['otherAdapter'], manual: ['astroConfig', 'liveConfig', 'secrets', 'admin'],
         command: 'pnpm add emdash @astrojs/node @astrojs/react react react-dom --config.strict-dep-builds=false --some-very-long-flag-name=with-a-very-long-value-that-has-no-break',
         files: [{ path: 'package.json', change: 'edit' }, { path: 'src/features/very/deeply/nested/folder/with/a/really-long-file-name-that-keeps-going.config.ts', change: 'create' }],
       }),
       emDashInstall: () => new Promise(() => undefined),
       emDashInstallCancel: async () => ({ ok: true }),
       onEmDashInstallLog: (callback) => { listeners.add(callback); return () => listeners.delete(callback) },
     }
     createRoot(document.getElementById('root')).render(
       React.createElement(EmDashDialog, { projectPath: '/site', project: { kind: 'absent' }, onProject() {}, onClose() {} }))`,
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
      'src/ui/progressRing.css',
      'src/ui/skeleton.css',
      'src/features/cmsConnections/cmsConnections.css',
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
     app.on('window-all-closed', () => app.quit());
     const { MOTION_SETTLED_EXPRESSION, waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     const MEASURE = \`(() => {
       const over = (element) => element.scrollWidth > element.clientWidth + 1;
       const dialog = document.querySelector('.emdash-dialog');
       const body = document.querySelector('.emdash-dialog-body');
       return {
         dialogWidth: Math.round(dialog.getBoundingClientRect().width),
         dialogOver: over(dialog),
         bodyOver: over(body),
         bodyOverflowX: getComputedStyle(body).overflowX,
         bodyScrolls: body.scrollHeight > body.clientHeight,
         dialogHeight: Math.round(dialog.getBoundingClientRect().height),
         viewportHeight: innerHeight,
         blocks: [...dialog.querySelectorAll('pre')].map((block) => ({ over: over(block), width: block.clientWidth, whiteSpace: getComputedStyle(block).whiteSpace })),
         names: [...dialog.querySelectorAll('.emdash-install-files code')].map((name) => ({ over: over(name), cut: getComputedStyle(name).textOverflow })),
       };
     })()\`;
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 900, height: 700 });
       await win.loadFile(path.join(__dirname, 'index.html'));
       const run = (code) => win.webContents.executeJavaScript(code);
       const shows = (what, expression) => waitFor({ what, read: () => run('Boolean(' + expression + ')'), until: (shown) => shown });
       const settled = () => waitFor({ what: 'the motion settled', read: () => run(MOTION_SETTLED_EXPRESSION), until: (still) => still });
       await shows('the preview is in', "document.querySelector('.emdash-install .primary')");
       await settled();
       await run("document.querySelectorAll('.emdash-install details > summary').forEach((summary) => { summary.parentElement.open = true; })");
       const results = {};
       for (const width of [320, 480]) {
         await run("(() => { let style = document.getElementById('width'); if (!style) { style = document.createElement('style'); style.id = 'width'; document.head.append(style); } style.textContent = '.modal.emdash-dialog { width: ${'$'}{WIDTH}px !important; }'.replace('${'$'}{WIDTH}', '" + width + "'); })()");
         await settled();
         results['preview' + width] = await run(MEASURE);
       }
       await run("document.querySelector('.emdash-install .primary').click()");
       await shows('running', "document.querySelector('.progress-ring-turning')");
       await run("window.pushLog('x'.repeat(4000) + '\\\\n' + 'a/very/long/path/'.repeat(80) + '\\\\n')");
       await shows('the log shows', "document.querySelector('.emdash-install-log pre') && document.querySelector('.emdash-install-log pre').textContent.length > 3000");
       for (const width of [320, 480]) {
         await run("document.getElementById('width').textContent = '.modal.emdash-dialog { width: " + width + "px !important; }'");
         await settled();
         results['running' + width] = await run(MEASURE);
       }
       console.log(JSON.stringify(results));
       app.quit();
     }).catch((error) => {
       console.log(JSON.stringify({ probeError: String(error) }));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const ran = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (ran.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (ran.stderr || ran.stdout || '').slice(0, 800));
  } else {
    const results = JSON.parse(line);
    if (results.probeError !== undefined) {
      console.error(`emdash-dialog-layout: the probe failed: ${results.probeError}`);
      process.exit(1);
    }
    for (const [name, measured] of Object.entries(results)) {
      check(`${name}: the dialog does not scroll sideways`, measured.dialogOver === false, JSON.stringify(measured));
      check(`${name}: nor does its body`, measured.bodyOver === false && measured.bodyOverflowX === 'hidden', JSON.stringify(measured));
      check(
        `${name}: every code block fits`,
        measured.blocks.length > 0 && measured.blocks.every((block) => block.over === false),
        JSON.stringify(measured.blocks),
      );
      check(
        `${name}: code wraps`,
        measured.blocks.every((block) => block.whiteSpace === 'pre-wrap'),
        JSON.stringify(measured.blocks),
      );
      check(
        `${name}: file names are cut, not wrapped or overflowing`,
        measured.names.every((entry) => entry.over === false || entry.cut === 'ellipsis'),
        JSON.stringify(measured.names),
      );
      check(`${name}: the dialog stays inside the window`, measured.dialogHeight <= measured.viewportHeight, JSON.stringify(measured));
      check(`${name}: the width is the one asked for`, measured.dialogWidth === Number(name.replace(/\D/g, '')), JSON.stringify(measured));
    }
  }
  if (failures.length > 0) {
    console.error(`emdash-dialog-layout: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`emdash-dialog-layout: ${checked} checks passed`);
})();
