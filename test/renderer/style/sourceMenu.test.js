// The "Add custom styles in:" source menu: a link-variant Select.
//
//   node test/renderer/style/sourceMenu.test.js
//
// Goal: the menu opens in place with the standard popup motion, sits whole
// inside the panel with equal insets, and ends each row with its check.
// Two faults came together here. The horizontal clamp was written to the
// list's `transform`, which the popup's open motion transitions, so the menu
// opened at its natural spot and slid sideways to the clamped one. And the
// menu (20rem) was wider than the panel, so the clamp pushed its left edge
// past the panel, whose overflow clip cut the left padding away.
//
// Method: first the pure placement over each case (fits, runs off the right,
// starts left of the panel, and the assertions). Then the real Select, built
// and laid out in Electron (jsdom has no layout): open it, sample its left edge
// through the open motion, and measure the list against the panel and the
// search field and rows against the list. Without Electron the layout half is
// skipped, as popoverDropdown.test.js does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('../../helpers/rendererModule');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const { menuPlacement, menuWidthMaxPx, MENU_EDGE_MARGIN_PX } = load('src/features/style/model/panelBox.ts');

// ── Pure placement ──────────────────────────────────────────────────────────
const panel = { boundsLeftPx: 100, boundsRightPx: 400 };
assert.equal(menuWidthMaxPx({ left: 100, right: 400 }), 300 - 2 * MENU_EDGE_MARGIN_PX, 'the cap keeps a margin on each side');
assert.equal(menuWidthMaxPx({ left: 100, right: 110 }), 0, 'a panel narrower than its margins caps at zero');
assert.equal(menuPlacement({ ...panel, anchorLeftPx: 120, menuWidthPx: 200 }).shiftPx, 0, 'fits: stays under the trigger');
assert.equal(menuPlacement({ ...panel, anchorLeftPx: 300, menuWidthPx: 200 }).shiftPx, -108, 'runs off the right: pulled in to the margin');
assert.equal(menuPlacement({ ...panel, anchorLeftPx: 90, menuWidthPx: 100 }).shiftPx, 18, 'starts left of the panel: pushed in to the margin');
// A menu at the cap, anchored at the far right, lands exactly between the margins.
const capped = menuWidthMaxPx({ left: 100, right: 400 });
const shifted = menuPlacement({ ...panel, anchorLeftPx: 390, menuWidthPx: capped }).shiftPx;
assert.equal(390 + shifted, 100 + MENU_EDGE_MARGIN_PX, 'a capped menu keeps the left margin');
assert.throws(() => menuPlacement({ ...panel, anchorLeftPx: 0, menuWidthPx: -1 }), /a menu width is not negative/);
assert.throws(() => menuPlacement({ boundsLeftPx: 10, boundsRightPx: 0, anchorLeftPx: 0, menuWidthPx: 1 }), /the panel has a width/);

// ── Real layout ─────────────────────────────────────────────────────────────
const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail === undefined ? '' : `\n    ${detail}`}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/source-menu');
  fs.mkdirSync(buildDirectory, { recursive: true });

  // A 280px panel at the window's right edge, like the style panel, with the
  // source picker's own markup and classes: the trigger is pushed right, so
  // the menu anchored to its left runs past the panel unless clamped.
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import Select from './src/features/style/components/Select'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'

    const Icon = () => <svg width="12" height="12" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="currentColor" /></svg>
    const OPTIONS = [
      { value: 'file', label: 'src/styles/webflow.css', marked: true, icon: <Icon /> },
      { value: 'group', label: 'ButtonMain', heading: true, icon: <Icon /> },
      { value: 'global', label: '<style is:global>', indent: true, icon: <Icon /> },
    ]
    function Harness() {
      const [value, setValue] = useState('global')
      return (
        <div className="embed-editor_root" style={{ position: 'fixed', right: 0, top: 0, width: 280, height: 600, overflowX: 'clip', padding: 12, boxSizing: 'border-box' }}>
          <div className="embed-editor_head"><div className="embed-editor_selector-head"><div className="embed-editor_source-picker">
            <span className="embed-editor_source-prefix">Add custom styles in:</span>
            <Select variant="link" searchable searchPlaceholder="Search embeds…" className="embed-editor_source-link"
              value={value} options={OPTIONS} onChange={setValue} ariaLabel="Style source" />
          </div></div></div>
        </div>
      )
    }
    createRoot(document.getElementById('root')).render(<Harness />)
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx' },
    outfile: path.join(buildDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(buildDirectory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css">' +
      '<style>body{margin:0;background:#111}</style><div id="root"></div>' +
      '<script src="bundle.js"></script>',
  );

  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('source menu: placement ok; layout skipped — no Electron to lay it out in');
    return;
  }

  // The trigger is opened with a DOM click, not window input, so the probe
  // needs no focus and cannot lose it to another window.
  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 700, height: 500 });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       await new Promise((r) => setTimeout(r, 300));
       await js("document.querySelector('.u-select-link').click(); true");
       const lefts = [];
       for (let i = 0; i < 8; i += 1) {
         await new Promise((r) => setTimeout(r, 30));
         lefts.push(await js("(() => { const l = document.querySelector('.u-select-list'); return l ? l.getBoundingClientRect().left : null })()"));
       }
       const out = await js(\`(() => {
         const list = document.querySelector('.u-select-list');
         const l = list.getBoundingClientRect();
         const p = document.querySelector('.embed-editor_root').getBoundingClientRect();
         const s = document.querySelector('.u-select-search-input').getBoundingClientRect();
         const rows = [...list.querySelectorAll('.u-select-option')].map((o) => {
           const r = o.getBoundingClientRect();
           return { left: r.left - l.left, right: l.right - r.right, checkLast: o.lastElementChild.classList.contains('u-select-check') };
         });
         const selected = list.querySelector('.u-select-option.is-selected');
         return {
           inlineTransform: list.style.transform, inlineTranslate: list.style.translate,
           panel: { left: l.left - p.left, right: p.right - l.right },
           search: { left: s.left - l.left, right: l.right - s.right },
           rows, checked: selected ? !!selected.lastElementChild.querySelector('svg') : false,
         };
       })()\`);
       console.log(JSON.stringify({ lefts, ...out }));
       app.quit();
     });`,
  );

  const { spawnSync } = require('node:child_process');
  // Electron run as plain Node has no BrowserWindow; the gate's shell may set it.
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (line === undefined) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 400));
  } else {
    const out = JSON.parse(line);
    const lefts = out.lefts.filter((left) => left !== null);
    check('the menu opens', lefts.length > 0, JSON.stringify(out.lefts));
    // The open motion scales from 0.985, which moves the left edge by a few
    // pixels at most; the old sideways slide moved it by over a hundred.
    const travel = Math.max(...lefts) - Math.min(...lefts);
    check('no sideways slide while it opens', travel < 4, `left edge moved ${travel}px: ${JSON.stringify(lefts)}`);
    check('the clamp is not written to transform', out.inlineTransform === '', out.inlineTransform);
    check('it is written to translate', out.inlineTranslate !== '', 'no translate: the menu was not clamped');
    const near = (first, second) => Math.abs(first - second) < 0.5;
    check('the menu keeps the panel margin on the left', near(out.panel.left, 8), JSON.stringify(out.panel));
    check('and the same margin on the right', near(out.panel.right, 8), JSON.stringify(out.panel));
    check('the search field has equal insets', near(out.search.left, out.search.right), JSON.stringify(out.search));
    for (const row of out.rows) {
      check('each row has equal insets', near(row.left, row.right), JSON.stringify(row));
      check('each row ends with its check column', row.checkLast === true);
    }
    check('the selected row shows its check at the end', out.checked === true);
  }
  if (failures.length > 0) {
    console.error(`source menu: ${failures.length} failure(s)\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('source menu: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
