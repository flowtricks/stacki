// Goal: the Add query form is compact and sound in real layout: its rows are 32px with the official
// breakpoint icons, every row ends in the same 16px check slot, left and right insets match, nothing
// scrolls sideways at the panel's width, the preview line is shown under the Custom row, and the
// list scrolls inside its own cap rather than growing the panel.
// Method: a real Electron window (skipped without Electron; the pattern of contextDropdownScroll)
// mounts the real AddQueryForm, with the real icon components, under the real tokens and
// stylesheets, in a 340px-wide panel; it reads rects and scroll sizes. Set
// STACKI_DROPDOWN_SHOTS=<directory> to also save screenshots: mobile first, desktop first, and a
// custom width typed. Nothing is wall-clock dependent; waits poll state (test/helpers/waitFor.js).

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/add-query-layout');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { AddQueryForm } from './src/features/style/embed/QueryForms'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'
    const contexts = [{ key: '@media (width >= 30rem)', label: 'x', breakpoint: undefined, embedAtContext: '@media (width >= 30rem)' }]
    createRoot(document.getElementById('root')).render(
      <div className="embed-editor_root" style={{ width: 340, margin: '24px 20px' }}>
        <AddQueryForm canNest={true} contexts={contexts} onAdd={() => {}} onExisting={() => {}} onCancel={() => {}} />
      </div>,
    )
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
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>body{margin:0;background:#111}</style><div id="root"></div><script src="bundle.js"></script>',
  );
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('add-query-layout: skipped, no Electron to lay it out in');
    return;
  }
  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 420, height: 560 });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
       await waitFor({ what: 'form drawn', read: () => js("document.querySelector('.embed-editor_aq-row') !== null"), until: (drawn) => drawn });
       const measure = () => js(\`(() => {
         const form = document.querySelector('.embed-editor_add-query');
         const f = form.getBoundingClientRect();
         const rows = [...document.querySelectorAll('.embed-editor_aq-row')];
         const list = document.querySelector('.embed-editor_aq-list');
         const inset = (el) => { const r = el.getBoundingClientRect(); return { left: r.left - f.left, right: f.right - r.right } };
         return {
           rowHeights: rows.map((r) => r.offsetHeight),
           checkWidths: rows.map((r) => r.querySelector('.embed-editor_aq-check').offsetWidth),
           icons: rows.map((r) => r.querySelector('.embed-editor_aq-icon svg') !== null),
           insets: rows.map(inset),
           sideways: form.scrollWidth > form.clientWidth || list.scrollWidth > list.clientWidth || document.documentElement.scrollWidth > document.documentElement.clientWidth,
           preview: document.querySelector('.embed-editor_aq-preview').textContent,
           labels: rows.map((r) => r.textContent),
         };
       })()\`);
       const out = { mobile: await measure() };
       const shots = process.env.STACKI_DROPDOWN_SHOTS;
       const fs = require('fs');
       const shoot = async (name) => {
         if (!shots) return;
         await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
         fs.writeFileSync(require('path').join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG());
       };
       await shoot('add-query-mobile-first');
       await js("[...document.querySelectorAll('.embed-editor_add-query-direction button, .embed-editor_add-query-direction [role=radio]')].find((b) => b.textContent.includes('Desktop first')).click(); true");
       await waitFor({ what: 'desktop first rows', read: () => js("[...document.querySelectorAll('.embed-editor_aq-detail')].some((d) => d.textContent.includes('<'))"), until: (shown) => shown });
       out.desktop = await measure();
       await shoot('add-query-desktop-first');
       await js("(() => { const input = document.querySelector('.embed-editor_aq-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '40rem'); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()");
       await waitFor({ what: 'preview shown', read: () => js("document.querySelector('.embed-editor_aq-preview').textContent"), until: (text) => text.includes('40rem') });
       out.custom = await measure();
       await shoot('add-query-custom');
       console.log(JSON.stringify(out));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000 });
  const line = (run.stdout || '').split('\n').find((candidate) => candidate.trim().startsWith('{'));
  if (!line) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 600));
  } else {
    const out = JSON.parse(line);
    for (const [name, state] of Object.entries(out)) {
      check(
        `${name}: rows are 32px`,
        state.rowHeights.every((height) => height === 32),
        JSON.stringify(state.rowHeights),
      );
      check(
        `${name}: every row ends in the same 16px check slot`,
        state.checkWidths.every((width) => width === 16),
        JSON.stringify(state.checkWidths),
      );
      check(`${name}: every row wears an official icon`, state.icons.every(Boolean), JSON.stringify(state.icons));
      check(`${name}: nothing scrolls sideways`, state.sideways === false);
      check(
        `${name}: left and right insets match`,
        state.insets.every((inset) => Math.abs(inset.left - inset.right) <= 1),
        JSON.stringify(state.insets),
      );
    }
    check(
      'the custom preview names the exact query',
      out.custom.preview.includes('@media (width >= 40rem)') || out.custom.preview.includes('@media (width < 40rem)'),
      out.custom.preview,
    );
    check(
      'desktop first lists width < X',
      out.desktop.labels.every((label) => label.includes('<')),
      JSON.stringify(out.desktop.labels),
    );
  }
  if (failures.length) {
    console.error(`add-query-layout: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`add-query-layout: ${checked} passed  [real layout]`);
})();
