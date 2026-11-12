// Goal: an installed app's row never draws one thing over another. The row is a
// grid of tile, text column and one slot; at rest the slot shows the place pills
// and the creator's avatar, and on hover (or keyboard focus inside the row) the
// actions (Update when one waits, Open, ⋯) replace them in that same slot. The
// actions once sat absolutely over the meta, so Open covered the pills and the
// avatar and the description truncated early. This pins: no action's rect
// intersects the place pills, avatar, name, description or text column; the meta
// fades out while the actions show; the text column is wider at rest, where the
// hidden actions take no room;
// the description runs to the text column's edge; and focusing the row's button
// shows the actions too.
//
//   node test/renderer/apps/appsRowLayout.test.js
//
// Method: jsdom has no layout, so this is measured in a real Chromium. The rows
// are the real `AppRow` (rendered in the page with react-dom/client), under the app's stylesheets, in a
// 280px-wide panel. Hover is a real mouse move through the DevTools protocol,
// so `:hover` matches as it does for a person.
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

const summary = (id, name, description, update) => ({
  manifest: {
    manifestVersion: 1,
    id,
    name,
    version: '1.0.0',
    description,
    entry: 'index.html',
    capabilities: ['selection'],
    window: { mode: 'popup', widthPx: 300, heightPx: 300 },
    settings: [],
    secretsAllowlist: [],
    // An author, so the row draws its picture: a row without one draws none (appsPanel.test.js).
    authorGitHub: 'octocat',
  },
  lock: {
    id,
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-10T00:00:00.000Z',
    // An update waits only for an app with a source to update from; an uploaded app offers none.
    source: update ? { kind: 'github', owner: 'octocat', repository: id, asset: `${id}.zip`, tag: 'v1.0.0' } : { kind: 'file', fileName: `${id}.zip` },
    autoUpdate: false,
    ...(update ? { update: { version: '1.1.0', tag: 'v1.1.0', sha256: 'e'.repeat(64), additions: [] } } : {}),
  },
});

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('apps-row-layout: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const pageDirectory = repoPath('node_modules/.stacki-test/apps-row-layout');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const rows = [
    summary('feedback-pins', 'Feedback pins', 'Pin comments to elements on the page and resolve them together', false),
    summary('feedback-pins-update', 'Feedback pins', 'Pin comments to elements on the page and resolve them together', true),
  ];
  // The rows render in the page itself, with react-dom/client: the row's badge
  // count reads an external store that a server render cannot.
  const entry = path.join(pageDirectory, 'entry.js');
  fs.writeFileSync(
    entry,
    `import React from 'react';
     import { flushSync } from 'react-dom';
     import { createRoot } from 'react-dom/client';
     import { AppRow } from ${JSON.stringify(repoPath('src/features/apps/AppsPanel.tsx'))};
     const noop = () => {};
     const actions = { admin: true, busy: false, projectPath: '/project', share: noop, submit: () => noop, open: noop, showDetails: noop, setAutoUpdate: noop, update: noop, uninstall: noop };
     const avatar = React.createElement('span', { className: 'apps-initial', 'aria-hidden': 'true' }, 'FP');
     const rows = ${JSON.stringify(rows)};
     const root = createRoot(document.querySelector('.apps-list'));
     flushSync(() => root.render(rows.map((app) => React.createElement(AppRow, { key: app.manifest.id, app, avatar, actions }))));`,
  );
  buildSync({
    entryPoints: [entry],
    outfile: path.join(pageDirectory, 'page.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
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
      `<div class="apps-panel" style="width:280px"><div class="panel-body apps-body"><ul class="apps-list"></ul></div></div><script src="page.js"></script>`,
  );
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     const measure = \`(() => {
       const box = (element) => {
         if (!element) { return null; }
         const r = element.getBoundingClientRect();
         return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
       };
       // Drawn: what a person sees there. An element that is hidden or fully
       // transparent keeps its layout box but paints nothing over the actions.
       const drawn = (element) => {
         if (getComputedStyle(element).visibility === 'hidden') { return null; }
         let opacity = 1;
         for (let node = element; node; node = node.parentElement) { opacity *= Number(getComputedStyle(node).opacity); }
         return opacity === 0 ? null : box(element);
       };
       return [...document.querySelectorAll('.apps-row-main')].map((row) => {
         const actions = row.querySelector('.apps-row-actions');
         const meta = row.querySelector('.apps-row-meta');
         const description = row.querySelector('.apps-row-description');
         return {
           row: box(row),
           text: box(row.querySelector('.apps-row-text')),
           title: box(row.querySelector('.apps-row-title')),
           description: box(description),
           descriptionTruncated: description.scrollWidth > description.clientWidth,
           places: box(row.querySelector('.apps-row-places')),
           avatar: box(row.querySelector('.apps-row-avatar')),
           placesDrawn: drawn(row.querySelector('.apps-row-places')),
           avatarDrawn: drawn(row.querySelector('.apps-row-avatar')),
           meta: box(meta),
           metaOpacity: getComputedStyle(meta).opacity,
           metaVisibility: getComputedStyle(meta).visibility,
           actions: box(actions),
           actionsOpacity: getComputedStyle(actions).opacity,
           actionsVisibility: getComputedStyle(actions).visibility,
           buttons: [...actions.querySelectorAll('button')].map((button) => ({ label: button.getAttribute('aria-label') || button.title || button.textContent, box: box(button) })),
         };
       });
     })()\`;
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 600, height: 600 });
       // A short pause for the hover to land, then until the row's fades finish: slowed
       // motion outlasts any fixed sleep. Bounded so a stuck animation still fails.
       const settle = async () => {
         await new Promise((resolve) => setTimeout(resolve, 300));
         await win.webContents.executeJavaScript("Promise.race([Promise.all(document.getAnimations().map((animation) => animation.finished)), new Promise((resolve) => setTimeout(resolve, 5000))]).then(() => true)");
       };
       await win.loadFile(path.join(__dirname, 'index.html'));
       const cdp = win.webContents.debugger;
       // The Linux preflight's slow-motion profile may already hold the protocol; share it.
       if (!cdp.isAttached()) {
         cdp.attach('1.3');
       }
       const move = (x, y) => cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
       await move(590, 590);
       await settle();
       const rest = await win.webContents.executeJavaScript(measure);
       const hovered = [];
       for (let index = 0; index < rest.length; index += 1) {
         const row = rest[index].row;
         await move(Math.round(row.left + 40), Math.round((row.top + row.bottom) / 2));
         await settle();
         hovered.push((await win.webContents.executeJavaScript(measure))[index]);
       }
       await move(590, 590);
       await win.webContents.executeJavaScript("document.querySelector('.apps-row-select').focus({ focusVisible: true })");
       await settle();
       const focused = (await win.webContents.executeJavaScript(measure))[0];
       console.log(JSON.stringify({ rest, hovered, focused }));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const { rest, hovered, focused } = JSON.parse(line);
    const intersects = (first, second) => first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
    const names = ['the plain row', 'the row with an update'];
    check('both rows rendered', rest.length === 2 && hovered.length === 2, line.slice(0, 300));
    rest.forEach((before, index) => {
      const name = names[index];
      const after = hovered[index];
      check(`${name}: at rest the actions are hidden`, before.actionsVisibility === 'hidden' && before.actionsOpacity === '0', JSON.stringify(before));
      check(`${name}: at rest the meta shows`, before.metaOpacity === '1', before.metaOpacity);
      check(`${name}: on hover the actions show`, after.actionsVisibility === 'visible' && after.actionsOpacity === '1', JSON.stringify(after));
      check(`${name}: on hover the meta fades out`, after.metaOpacity === '0', after.metaOpacity);
      check(
        `${name}: the actions take exactly the meta's slot, left of it nothing`,
        after.actions.left >= after.text.right,
        `${after.actions.left} vs ${after.text.right}`,
      );
      // At rest the hidden actions leave the layout, so the text gets the room up to the pills;
      // on hover the actions take the slot and the text column narrows to make way.
      check(`${name}: the text column is wider at rest than on hover`, before.text.width > after.text.width, `${before.text.width} vs ${after.text.width}`);
      check(
        `${name}: at rest the description runs to the text column's edge`,
        Math.abs(before.description.right - before.text.right) < 1,
        `${before.description.right} vs ${before.text.right}`,
      );
      check(
        `${name}: the description runs to the text column's edge`,
        Math.abs(after.description.right - after.text.right) < 1,
        `${after.description.right} vs ${after.text.right}`,
      );
      check(`${name}: the long description truncates`, after.descriptionTruncated, '');
      check(
        `${name}: the place pills sit in the meta slot`,
        after.places !== null && after.places.left >= after.text.right - 0.5,
        JSON.stringify(after.places),
      );
      check(
        `${name}: the meta and actions end at the same slot edge`,
        Math.abs(after.meta.right - after.actions.right) < 1,
        `${after.meta.right} vs ${after.actions.right}`,
      );
      check(
        `${name}: the actions stay inside the row`,
        after.actions.right <= after.row.right && after.actions.left >= after.row.left,
        JSON.stringify(after.actions),
      );
      check(`${name}: has Open and ⋯`, after.buttons.length === (index === 1 ? 3 : 2), JSON.stringify(after.buttons.map((button) => button.label)));
      // The actions take the meta's slot, so their boxes sit where the pills
      // and avatar were laid out; on hover those are not drawn, so no action is
      // drawn over a pill or an avatar. Text is always drawn and never under one.
      check(`${name}: on hover the meta is not drawn`, after.metaVisibility === 'hidden', after.metaVisibility);
      check(`${name}: at rest the place pills and avatar are drawn`, before.placesDrawn !== null && before.avatarDrawn !== null, JSON.stringify(before));
      for (const button of after.buttons) {
        for (const [what, rect] of [
          ['drawn place pills', after.placesDrawn],
          ['drawn avatar', after.avatarDrawn],
          ['text column', after.text],
          ['title', after.title],
          ['description', after.description],
        ]) {
          check(
            `${name}: ${button.label} does not overlap the ${what}`,
            rect === null || !intersects(button.box, rect),
            `${JSON.stringify(button.box)} vs ${JSON.stringify(rect)}`,
          );
        }
      }
    });
    check('keyboard focus in the row shows the actions', focused.actionsVisibility === 'visible' && focused.actionsOpacity === '1', JSON.stringify(focused));
    check('keyboard focus in the row hides the meta', focused.metaOpacity === '0', focused.metaOpacity);
  }
  if (failures.length) {
    console.error(`apps-row-layout: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`apps-row-layout: ${checked} passed  [real layout]`);
})();
