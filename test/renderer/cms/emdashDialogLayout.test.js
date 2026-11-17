// Goal: the EmDash dialog is one grid in every state and never scrolls sideways. The header's mark, the heading, the status
// row, the disclosures, the code cards and the buttons share one left edge (within 1 px) and one right edge, at the dialog's
// widths (480 and 560 px) in the preview, while running, after a failure and after a success; Cancel and the primary button
// end at the content's right edge; the status row is one centred line (ring, text on its left, Cancel on its right); the
// heading never repeats the status text; a command's highlighted tokens are never split (react-dom stays whole); the
// dialog, its body and every code block have scrollWidth no larger than clientWidth, also at 320 px with a very long log
// line; and only the body scrolls, vertically.
// Method: jsdom has no layout, so the real dialog is rendered in Electron with the stylesheets the app loads, over a fake
// preload bridge (a plan, a run the test resolves, a log the test pushes), the boxes are measured after each step shows
// what it should (bounded waits, test/helpers/waitFor.js), and a screenshot of each state is written to
// node_modules/.stacki-test/emdash-dialog-layout/screens for a person to look at. Skipped where no Chromium is available.

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
         command: 'pnpm add emdash @astrojs/node @astrojs/react react react-dom --config.strict-dep-builds=false',
         files: [{ path: 'package.json', change: 'edit' }, { path: 'src/features/very/deeply/nested/folder/with/a/really-long-file-name-that-keeps-going.config.ts', change: 'create' }],
       }),
       emDashInstall: () => new Promise((resolve) => { window.resolveInstall = resolve }),
       emDashInstallCancel: async () => ({ ok: true }),
       onEmDashInstallLog: (callback) => { listeners.add(callback); return () => listeners.delete(callback) },
     }
     const root = createRoot(document.getElementById('root'))
     let generation = 0
     window.renderDialog = (project) => root.render(
       React.createElement(EmDashDialog, { key: generation++, projectPath: '/site', project, onProject() {}, onClose() {} }))
     window.renderDialog({ kind: 'absent' })
     window.avb.emDashAdminUrl = async () => ({ url: 'http://127.0.0.1:4321' })`,
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
       const left = (element) => (element ? Math.round(element.getBoundingClientRect().left * 10) / 10 : undefined);
       const right = (element) => (element ? Math.round(element.getBoundingClientRect().right * 10) / 10 : undefined);
       const padding = parseFloat(getComputedStyle(body).paddingLeft);
       // Not the same as the left padding: the body's stable scrollbar gutter holds 8px, which the right padding gives back.
       const paddingRight = parseFloat(getComputedStyle(body).paddingRight);
       const rows = [...dialog.querySelectorAll('button')].filter((button) => !button.classList.contains('emdash-dialog-close') && !button.classList.contains('emdash-code-copy'));
       const status = dialog.querySelector('.emdash-install-status');
       const statusText = status && status.querySelector(':scope > span:not(.progress-ring)');
       const centre = (element) => (element ? (element.getBoundingClientRect().top + element.getBoundingClientRect().bottom) / 2 : undefined);
       return {
         edges: {
           contentLeft: left(body) + padding,
           contentRight: left(body) + body.clientWidth - paddingRight,
           mark: left(dialog.querySelector('.emdash-dialog-header svg')),
           heading: left(dialog.querySelector('.emdash-install-heading, .emdash-status-line')),
           status: left(status),
           statusRight: right(status),
           summary: left(dialog.querySelector('.emdash-more > summary')),
           card: left(dialog.querySelector('.emdash-code')),
           collection: left(dialog.querySelector('.emdash-collection')),
           cardRight: right(dialog.querySelector('.emdash-code')),
           actionsRight: right(dialog.querySelector('.emdash-actions button:last-child')),
           cancelRight: right(status && status.querySelector('button')),
         },
         statusLine: status ? { ring: centre(status.querySelector('.progress-ring')), text: centre(statusText), button: centre(status.querySelector('button')), textLeft: left(statusText) - right(status.querySelector('.progress-ring')) } : undefined,
         heading: (dialog.querySelector('.emdash-install-heading') || {}).textContent,
         statusText: statusText && statusText.textContent,
         buttonHeights: rows.map((button) => Math.round(button.getBoundingClientRect().height)),
         wholeWords: [...dialog.querySelectorAll('.emdash-code[data-wrap="words"] pre')].map((block) => {
           const text = block.textContent;
           const at = text.indexOf('react-dom');
           if (at < 0) { return true; }
           const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
           let offset = 0; let node; const tops = new Set();
           while ((node = walker.nextNode())) {
             const start = Math.max(at - offset, 0); const end = Math.min(at + 9 - offset, node.length);
             if (start < end) { const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end); [...range.getClientRects()].forEach((rectangle) => tops.add(Math.round(rectangle.top))); }
             offset += node.length;
           }
           return tops.size === 1;
         }),
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
       // Which script failed, since Electron's own error does not say.
       const run = (code) =>
         win.webContents.executeJavaScript(code).catch((error) => {
           throw new Error(String(error) + ' in: ' + code.slice(0, 160));
         });
       const shows = (what, expression) => waitFor({ what, read: () => run('Boolean(' + expression + ')'), until: (shown) => shown });
       const settled = () => waitFor({ what: 'the motion settled', read: () => run(MOTION_SETTLED_EXPRESSION), until: (still) => still });
       const screens = path.join(__dirname, 'screens');
       require('fs').mkdirSync(screens, { recursive: true });
       const setWidth = async (width) => {
         await run("(() => { let style = document.getElementById('width'); if (!style) { style = document.createElement('style'); style.id = 'width'; document.head.append(style); } style.textContent = '.modal.emdash-dialog { width: " + width + "px !important; }'; })()");
         await settled();
       };
       const record = async (name, width) => {
         await setWidth(width);
         results[name + width] = await run(MEASURE);
         const image = await win.webContents.capturePage();
         require('fs').writeFileSync(path.join(screens, name + '-' + width + '.png'), image.toPNG());
       };
       const results = {};
       await shows('the preview is in', "document.querySelector('.emdash-install .primary')");
       await settled();
       for (const width of [480, 560]) { await record('idle', width); }
       await run("document.querySelectorAll('.emdash-install details > summary').forEach((summary) => { summary.parentElement.open = true; })");
       await record('idleOpen', 480);
       await run("document.querySelectorAll('.emdash-install details > summary').forEach((summary) => { summary.parentElement.open = false; })");
       await run("document.querySelector('.emdash-install .primary').click()");
       await shows('running', "document.querySelector('.progress-ring-turning')");
       await run("window.pushLog(['added 5 packages in 3s', '', 'run npm fund', ''].join(String.fromCharCode(10)))");
       await shows('the log shows', "document.querySelector('.emdash-install-log pre') && /added 5/.test(document.querySelector('.emdash-install-log pre').textContent)");
       for (const width of [480, 560]) { await record('running', width); }
       await run("window.pushLog('x'.repeat(4000) + String.fromCharCode(10) + 'a/very/long/path/'.repeat(80) + String.fromCharCode(10))");
       await shows('the long line shows', "document.querySelector('.emdash-install-log pre').textContent.length > 3000");
       for (const width of [320, 480]) { await record('runningLong', width); }
       await run("window.resolveInstall({ kind: 'failed', reason: 'noNetwork', changedFiles: ['package.json'] })");
       await shows('the failure', "document.querySelector('.emdash-install-problem') && document.querySelector('.emdash-install-heading')");
       for (const width of [480, 560]) { await record('failed', width); }
       await run("[...document.querySelectorAll('.emdash-actions button')].find((button) => /Try again/.test(button.textContent)).click()");
       await shows('the preview again', "document.querySelector('.emdash-install .primary')");
       await run("document.querySelector('.emdash-install .primary').click()");
       await shows('running again', "document.querySelector('.progress-ring-turning')");
       await run("window.resolveInstall({ kind: 'installed', complete: true, saved: true, keyGenerated: true, databaseReady: true, preview: 'running', adminUrl: 'http://127.0.0.1:4321/_emdash/admin/', config: 'merged', onDemand: true, project: { kind: 'absent' }, changedFiles: ['package.json', 'astro.config.mjs'], manual: [] })");
       await shows('the success', "document.querySelector('.emdash-checklist')");
       for (const width of [480, 560]) { await record('success', width); }
       await run("(() => { document.querySelector('.emdash-install > details > summary').click(); })()");
       await settled();
       await record('successOpen', 480);
       await run("window.renderDialog({ kind: 'present', configFile: 'astro.config.mjs', output: 'server', databaseFile: 'data.db', schemaSource: 'database', problems: ['uploadsTracked'], collections: [{ slug: 'posts', label: 'Posts', labelSingular: 'Post', urlPattern: '/posts/[slug]', fields: [{ slug: 'title', label: 'Title', type: 'string', binding: 'text', required: true }, { slug: 'body', label: 'Body', type: 'portableText', binding: 'richText', required: false }] }, { slug: 'pages', label: 'Pages', labelSingular: 'Page', urlPattern: undefined, fields: [] }] })");
       await shows('the set-up state', "document.querySelector('.emdash-collections')");
       await settled();
       for (const width of [480, 560]) { await record('present', width); }
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
    const within = (value, expected) => value !== undefined && Math.abs(value - expected) <= 1;
    for (const [name, measured] of Object.entries(results)) {
      check(`${name}: the dialog does not scroll sideways`, measured.dialogOver === false, JSON.stringify(measured));
      check(`${name}: nor does its body`, measured.bodyOver === false && measured.bodyOverflowX === 'hidden', JSON.stringify(measured));
      check(
        `${name}: every code block fits`,
        measured.blocks.length === 0 || measured.blocks.every((block) => block.over === false),
        JSON.stringify(measured.blocks),
      );
      check(
        `${name}: file names are cut, not overflowing`,
        measured.names.every((entry) => entry.over === false || entry.cut === 'ellipsis'),
        JSON.stringify(measured.names),
      );
      check(`${name}: the dialog stays inside the window`, measured.dialogHeight <= measured.viewportHeight, JSON.stringify(measured));
      check(`${name}: the width is the one asked for`, measured.dialogWidth === Number(name.replace(/\D/g, '')), JSON.stringify(measured));
      check(`${name}: a command keeps react-dom on one line`, measured.wholeWords.every(Boolean), JSON.stringify(measured.wholeWords));
      const edges = measured.edges;
      for (const key of ['mark', 'heading', 'status', 'summary', 'card', 'collection']) {
        check(`${name}: ${key} starts at the content's left edge`, edges[key] === undefined || within(edges[key], edges.contentLeft), JSON.stringify(edges));
      }
      check(
        `${name}: code cards end at the content's right edge`,
        edges.cardRight === undefined || within(edges.cardRight, edges.contentRight),
        JSON.stringify(edges),
      );
      check(
        `${name}: the primary button ends at the content's right edge`,
        edges.actionsRight === undefined || within(edges.actionsRight, edges.contentRight),
        JSON.stringify(edges),
      );
      check(
        `${name}: Cancel ends at the content's right edge`,
        edges.cancelRight === undefined || within(edges.cancelRight, edges.contentRight),
        JSON.stringify(edges),
      );
      check(
        `${name}: the status row spans the content`,
        edges.statusRight === undefined || within(edges.statusRight, edges.contentRight),
        JSON.stringify(edges),
      );
      if (measured.statusLine !== undefined) {
        const line = measured.statusLine;
        check(
          `${name}: the ring, its text and Cancel share one centre line`,
          Math.abs(line.ring - line.text) <= 1.5 && Math.abs(line.ring - line.button) <= 1.5,
          JSON.stringify(line),
        );
        check(`${name}: the text sits right beside the ring`, line.textLeft >= 0 && line.textLeft <= 12, JSON.stringify(line));
        check(
          `${name}: the heading does not repeat the status`,
          measured.heading !== measured.statusText,
          JSON.stringify([measured.heading, measured.statusText]),
        );
      }
      check(`${name}: the buttons are one height`, new Set(measured.buttonHeights).size <= 1, JSON.stringify(measured.buttonHeights));
    }
    check('running says what is happening in its heading', /Adding EmDash/.test(results.running480.heading), JSON.stringify(results.running480.heading));
    check('a failure says so in its heading', /EmDash was not added/.test(results.failed480.heading), JSON.stringify(results.failed480.heading));
    check('running text is not the heading', results.running480.statusText === 'Installing packages…', JSON.stringify(results.running480.statusText));
  }
  if (failures.length > 0) {
    console.error(`emdash-dialog-layout: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`emdash-dialog-layout: ${checked} checks passed`);
})();
