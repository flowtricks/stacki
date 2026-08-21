// The panel's reset has to follow it through a portal.
//
//   node test/panel-surface.js
//
// The style panel is markup written against a reset where a bare <button> is an
// unstyled box. This app styles bare buttons globally — centred inline-flex,
// filled, rounded — so `.style-panel-host` re-applies that reset and hands the
// panel's own CSS back the wheel.
//
// Every popover and modal the panel opens portals to <body>, to escape being
// clipped by the panel's scroll container. That takes them out of
// `.style-panel-host` — and out of the reset. The global rules start again, on
// markup that never expected them.
//
// The grid settings modal is where it showed: a track row's label is in a bare
// <button>, so `justify-content: center` centred it in a full-width row, and
// `button:hover` painted a pill around that button instead of the row. Both are
// invisible to jsdom, which has no cascade to speak of and no layout at all — so
// this is measured in a real browser.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return null;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('panel-surface: skipped  [needs a Chromium — see test/computed-color.js]');
    return;
  }

  const esbuild = require('esbuild');
  const root = path.join(__dirname, '..');
  const pageDir = path.join(root, 'node_modules', '.stacki-test', 'panel-surface');
  fs.mkdirSync(pageDir, { recursive: true });

  const entry = path.join(pageDir, 'entry.jsx');
  fs.writeFileSync(
    entry,
    `import React from 'react'
     import { createRoot } from 'react-dom/client'
     import GridSettings from ${JSON.stringify(path.join(root, 'src', 'style-panel', 'GridSettings'))}
     const decls = { 'grid-template-columns': '200px 1fr minmax(0, 2fr)' }
     const read = (p) => decls[p] != null
       ? { source:'selected', overridden:false, contributors:[],
           winner:{ selectorText:'.x', value:decls[p], important:false },
           selectedValue:{ value:decls[p], important:false } }
       : undefined
     // Rendered from inside the host, exactly as the app does. The modal still
     // portals itself out to <body> — which is the whole point.
     createRoot(document.getElementById('root')).render(
       React.createElement('div', { className: 'style-panel-host' },
         React.createElement(GridSettings, {
           read, busy:false, setProp:()=>{}, clearProp:()=>{},
           onProvenance:()=>{}, onSelectSelector:()=>{}, onClose:()=>{},
         })))`
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(pageDir, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  // Every stylesheet the app loads, tokens first — without those the `var()`s
  // resolve to nothing and the measurements are of a page that never existed.
  fs.writeFileSync(
    path.join(pageDir, 'app.css'),
    [
      'src/style-panel/tokens.css',
      'src/styles.css',
      'src/style-panel/utilities.css',
      'src/style-panel/components/IconButton.css',
      'src/style-panel/embed-editor.css',
    ].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n')
  );
  fs.writeFileSync(
    path.join(pageDir, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css">' +
      '<style>body{margin:0;background:#1a1a1a}</style><div id="root"></div><script src="bundle.js"></script>'
  );

  const probe = path.join(pageDir, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 720, height: 900 });
       await win.loadFile(path.join(__dirname, 'index.html'));
       await sleep(800);
       const read = () => win.webContents.executeJavaScript(\`(() => {
         const row = document.querySelector('.embed-editor_grid-track');
         const main = row.querySelector('.embed-editor_grid-track-main');
         const label = row.querySelector('.embed-editor_grid-track-label');
         const heads = [...document.querySelectorAll('.embed-editor_grid-section-head')];
         const body = document.querySelector('.embed-editor_grid-modal-body');
         const bodyLeft = body.getBoundingClientRect().left;
         return {
           portaledOutOfHost: !main.closest('.style-panel-host'),
           inSurface: !!main.closest('.style-panel-surface'),
           justify: getComputedStyle(main).justifyContent,
           labelInset: Math.round(label.getBoundingClientRect().left - main.getBoundingClientRect().left),
           mainWidth: Math.round(main.getBoundingClientRect().width),
           rowBg: getComputedStyle(row).backgroundColor,
           mainBg: getComputedStyle(main).backgroundColor,
           rowWidth: Math.round(row.getBoundingClientRect().width),
           // Every section heading should start at the same left edge.
           headingLefts: heads.map((h) => Math.round(h.firstElementChild.getBoundingClientRect().left - bodyLeft)),
         };
       })()\`);
       const resting = await read();
       const pt = await win.webContents.executeJavaScript(\`(() => {
         const m = document.querySelector('.embed-editor_grid-track-main');
         const r = m.getBoundingClientRect();
         return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
       })()\`);
       win.webContents.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
       await sleep(300);
       const hovered = await read();
       console.log(JSON.stringify({ resting, hovered }));
       app.quit();
     });`
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 180000 });
  const line = (run.stdout || '').split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const { resting, hovered } = JSON.parse(line);

    // The premise: this really is a surface outside the host.
    check('the modal is portaled out of the panel host', resting.portaledOutOfHost, 'it is inside the host — this test is no longer testing anything');
    check('and carries the panel-surface scope', resting.inSurface, 'without it the global button rules apply');

    // Left-aligned: the label starts at the row's left, not the middle of it.
    check('a track label is not centred', resting.justify !== 'center', resting.justify);
    check(
      'it sits at the left of its row',
      resting.labelInset < resting.mainWidth / 4,
      `label is ${resting.labelInset}px into a ${resting.mainWidth}px row`
    );

    // Hover highlights the row, not a shape inside it.
    const painted = (c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
    check('nothing is highlighted at rest', !painted(resting.rowBg) && !painted(resting.mainBg), JSON.stringify([resting.rowBg, resting.mainBg]));
    check('hovering highlights the row', painted(hovered.rowBg), hovered.rowBg);
    check('and not the button inside it', !painted(hovered.mainBg), `the button painted ${hovered.mainBg} — that is the pill`);

    // Every heading starts at the same edge. A head holding only its title had
    // that title as its last child too, and the rule that pushes a trailing
    // control right pushed the heading itself to the far edge.
    const lefts = resting.headingLefts;
    check('there are several sections to compare', lefts.length >= 3, JSON.stringify(lefts));
    check(
      'every section heading starts at the same left edge',
      new Set(lefts).size === 1,
      `${JSON.stringify(lefts)} — one of them is pushed out`
    );
  }

  if (failures.length) {
    console.error(`panel-surface: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`panel-surface: ${checked} passed  [portaled modal, real layout]`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
