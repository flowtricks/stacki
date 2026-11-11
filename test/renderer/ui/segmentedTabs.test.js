// The shared segmented tabs (src/ui/SegmentedTabs.tsx) size each tab to its
// label, and the pill sits exactly on the active tab.
//
//   node test/renderer/ui/segmentedTabs.test.js
//
// Goal: "Open 1 / Resolved / All" reads as three labels, not three equal boxes.
// By default each tab is its label plus the same side padding, so a longer
// label makes a wider tab and the track hugs its tabs; `layout="equal"` is the
// opt-in for a two-way switch that fills its row in equal shares. In both, the
// pill measures the active tab's real offset and width: it covers that tab's
// rect on first paint (placed before the transition is switched on, so it does
// not fly in from the left), and again after a pick has slid it.
//
// Method: jsdom has no layout, so the real component is bundled for the
// browser and mounted with React in Electron's Chromium under the editor's
// stylesheets. The probe records the pill and the active tab in the same frame
// as the first commit, then clicks a tab, waits out the 200ms slide and
// measures again.
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
    console.log('segmented-tabs: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const pageDirectory = repoPath('node_modules/.stacki-test/segmented-tabs');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const entry = path.join(pageDirectory, 'entry.jsx');
  const component = JSON.stringify(repoPath('src/ui/SegmentedTabs.tsx'));
  fs.writeFileSync(
    entry,
    `import React, { useState } from 'react';
     import { createRoot } from 'react-dom/client';
     import { flushSync } from 'react-dom';
     import { SegmentedTabs } from ${component};
     const box = (element) => {
       const r = element.getBoundingClientRect();
       return { left: r.left, width: r.width };
     };
     const Tabs = ({ id, layout, tabs }) => {
       const [value, setValue] = useState(tabs[0].value);
       return React.createElement('div', { id, style: { width: '320px', marginBottom: '12px' } },
         React.createElement(SegmentedTabs, { tabs, value, label: id, ...(layout ? { layout } : {}), onPick: setValue }));
     };
     const pins = [{ value: 'open', label: 'Open 1' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }];
     const halves = [{ value: 'public', label: 'Public' }, { value: 'private', label: 'Private' }];
     const root = createRoot(document.getElementById('surface'));
     flushSync(() => root.render(React.createElement(React.Fragment, null,
       React.createElement(Tabs, { id: 'content', tabs: pins }),
       React.createElement(Tabs, { id: 'equal', layout: 'equal', tabs: halves }))));
     const first = (id) => {
       const indicator = document.querySelector('#' + id + ' .ui-tabs-indicator');
       return { indicator: box(indicator), active: box(document.querySelector('#' + id + ' .ui-tab.on')), animated: indicator.classList.contains('is-animated') };
     };
     window.firstPaint = { content: first('content'), equal: first('equal') };`,
  );
  buildSync({
    entryPoints: [entry],
    outfile: path.join(pageDirectory, 'page.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'transform',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [repoPath('node_modules')],
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(pageDirectory, 'app.css'),
    ['src/features/style/tokens.css', 'src/ui/controls.css', 'src/app/styles.css', 'src/ui/segmentedTabs.css']
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css">' +
      '<style>body{margin:24px;background:#141414}</style><div id="surface"></div><script src="page.js"></script>',
  );
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.disableHardwareAcceleration();
     const measure = \`(async () => {
       const box = (element) => {
         const r = element.getBoundingClientRect();
         return { left: r.left, right: r.right, width: r.width };
       };
       const read = (id) => {
         const track = document.querySelector('#' + id + ' .ui-tabs');
         return {
           track: box(track),
           container: box(track.parentElement),
           tabs: [...track.querySelectorAll('.ui-tab')].map((tab) => ({ text: tab.textContent, box: box(tab), padding: getComputedStyle(tab).paddingLeft + ' ' + getComputedStyle(tab).paddingRight, content: tab.scrollWidth })),
           indicator: box(track.querySelector('.ui-tabs-indicator')),
           active: box(track.querySelector('.ui-tab.on')),
         };
       };
       await new Promise((resolve) => setTimeout(resolve, 100));
       const before = { content: read('content'), equal: read('equal') };
       document.querySelectorAll('#content .ui-tab')[1].click();
       document.querySelectorAll('#equal .ui-tab')[1].click();
       await new Promise((resolve) => setTimeout(resolve, 400));
       return { firstPaint: window.firstPaint, before, after: { content: read('content'), equal: read('equal') } };
     })()\`;
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 600, height: 300, useContentSize: true });
       await win.loadFile(path.join(__dirname, 'index.html'));
       console.log(JSON.stringify(await win.webContents.executeJavaScript(measure)));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const { firstPaint, before, after } = JSON.parse(line);
    const near = (left, right) => Math.abs(left - right) < 0.5;
    const covers = (state) => near(state.indicator.left, state.active.left) && near(state.indicator.width, state.active.width);

    // Content width: each tab its label, the same padding on every one, the track hugging them.
    const [open, resolved, all] = before.content.tabs;
    const detail = JSON.stringify(before.content);
    check('three tabs render', before.content.tabs.length === 3, detail);
    check('Resolved is wider than Open 1', resolved.box.width > open.box.width, detail);
    check('Open 1 is wider than All', open.box.width > all.box.width, detail);
    check(
      'every tab has the same side padding',
      before.content.tabs.every((tab) => tab.padding === open.padding),
      detail,
    );
    check(
      'every tab is its label plus its padding, with nothing spare',
      before.content.tabs.every((tab) => near(tab.box.width, tab.content)),
      detail,
    );
    check('the track hugs its tabs, not its container', before.content.track.width < before.content.container.width - 40, detail);

    // Equal: the track fills its container, and the halves match whatever the labels.
    const [publicTab, privateTab] = before.equal.tabs;
    const equalDetail = JSON.stringify(before.equal);
    check('an equal row fills its container', near(before.equal.track.width, before.equal.container.width), equalDetail);
    check('an equal row splits evenly', near(publicTab.box.width, privateTab.box.width), equalDetail);

    // The pill on the active tab: on first paint, at rest, and after a pick.
    for (const id of ['content', 'equal']) {
      check(`${id}: the pill covers the active tab on first paint`, covers(firstPaint[id]), JSON.stringify(firstPaint[id]));
      check(`${id}: the first placement is not animated (no slide in from the left)`, firstPaint[id].animated === false, JSON.stringify(firstPaint[id]));
      check(`${id}: the pill covers the active tab at rest`, covers(before[id]), JSON.stringify(before[id]));
      check(`${id}: the pill follows a pick to the new tab's rect`, covers(after[id]), JSON.stringify(after[id]));
      check(`${id}: the picked tab is the active one`, near(after[id].active.left, after[id].tabs[1].box.left), JSON.stringify(after[id]));
    }
  }

  if (failures.length > 0) {
    console.error(`segmented-tabs: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`segmented-tabs: ${checked} checks passed`);
})();
