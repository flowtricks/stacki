// Goal: in real layout, the style panel's real context switcher (ContextSwitcher, not a stand-in)
// shows the official breakpoint icon on every row whose boundary is a project breakpoint, on either
// side: a mobile-first project (`>= 30rem`, `>= 48rem`, `>= 64rem`) with the default breakpoints reads
// Phone, Tablet and Laptop with their own icons, a custom `>= 40rem` keeps the neutral ruler, and
// the closed trigger shows the official icon before the condition.
// Method: a real Electron window (skipped without Electron) mounts ContextSwitcher with the rows a
// Grid component's stylesheet and a global file produce (a custom width, a motion query), under the real tokens and stylesheets, opens it, and reads
// each row's icon markup: the three breakpoint rows must differ from each other and from the ruler
// row. Set STACKI_DROPDOWN_SHOTS=<directory> to save a screenshot (context-switcher-mobile-first.png).

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
  const buildDirectory = repoPath('node_modules/.stacki-test/context-switcher');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { ContextSwitcher } from './src/features/style/embed/StyleCard'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'

    const at = (value) => '@media (width >= ' + value + ')'
    const context = (value, source = 'patterns') => ({ key: source + '.css\\u0000' + at(value), label: at(value), breakpoint: undefined, embedAtContext: at(value), source })
    const motion = { key: 'base.css\\u0000motion', label: '@media (prefers-reduced-motion: reduce)', breakpoint: undefined, embedAtContext: '@media (prefers-reduced-motion: reduce)', source: 'base' }
    const contexts = [
      { key: '', label: 'Base', breakpoint: 'main', embedAtContext: '' },
      context('64rem'), context('48rem'), context('30rem'), context('40rem'), context('80rem', 'base'), motion,
    ]
    const infos = contexts.map((c) => ({ key: c.key, wrapper: c.source === 'base' || c.key === '' ? undefined : '.grid', hasStyles: c.key !== '', ...(c === motion ? { querySelectors: ['*, ::before, ::after'] } : {}) }))

    function Harness() {
      const [value, setValue] = useState(contexts[1].key)
      const card = {
        contexts, contextInfos: infos, context: value, onContext: setValue, queryUses: new Map(),
        sourceOptions: [{ value: 'patterns', label: 'patterns.css', fromComponent: true }, { value: 'base', label: 'src/styles/base.css', fromComponent: false }], sourceValue: 'patterns',
        contextFollow: { following: true, onFollow: () => {}, onHold: () => {} },
      }
      return (
        <div className="embed-editor_root" style={{ width: 340, margin: '24px 20px' }}>
          <ContextSwitcher card={card} onAddQuery={() => {}} onEditQuery={() => {}} />
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
    console.log('context-switcher-icons: skipped, no Electron to lay it out in');
    return;
  }
  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 420, height: 700 });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       const { waitFor, MOTION_SETTLED_EXPRESSION } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
       await waitFor({ what: 'trigger drawn', read: () => js("document.querySelector('.u-select-button') !== null"), until: (drawn) => drawn });
       const triggerIcon = await js("document.querySelector('.u-select-button .u-select-icon svg')?.outerHTML ?? ''");
       const triggerText = await js("document.querySelector('.u-select-button').textContent");
       await js("document.querySelector('.u-select-button').click(); true");
       await waitFor({ what: 'list open', read: () => js("document.querySelector('.u-select-list') !== null"), until: (open) => open });
       await waitFor({ what: 'motion settled', read: () => js(MOTION_SETTLED_EXPRESSION), until: (still) => still });
       const rows = await js(\`[...document.querySelectorAll('.u-select-list [role=option]')].filter((r) => r.title).map((r) => ({ title: r.title, text: r.textContent, icon: r.querySelector('.u-select-icon svg')?.outerHTML ?? '' }))\`);
       const shots = process.env.STACKI_DROPDOWN_SHOTS;
       if (shots) {
         await js('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
         require('fs').writeFileSync(require('path').join(shots, 'context-switcher-mobile-first.png'), (await win.webContents.capturePage()).toPNG());
       }
       console.log(JSON.stringify({ rows, triggerIcon, triggerText }));
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
    const byTitle = (value) => out.rows.find((row) => row.title === `@media (width >= ${value})`);
    const laptop = byTitle('64rem');
    const tablet = byTitle('48rem');
    const phone = byTitle('30rem');
    const custom = byTitle('40rem');
    check(
      'rows are named Laptop, Tablet and Phone',
      laptop?.text.startsWith('Laptop') && tablet?.text.startsWith('Tablet') && phone?.text.startsWith('Phone'),
      JSON.stringify(out.rows.map((row) => row.text)),
    );
    check(
      'each wears an icon',
      [laptop, tablet, phone, custom].every((row) => row?.icon.length > 0),
    );
    check('the three breakpoints wear three different icons', new Set([laptop?.icon, tablet?.icon, phone?.icon]).size === 3);
    check(
      'a custom boundary keeps the neutral ruler, which is none of them',
      custom?.text.startsWith('≥ 40rem') && ![laptop?.icon, tablet?.icon, phone?.icon].includes(custom?.icon),
    );
    check('the trigger shows the Laptop icon, not the ruler', out.triggerIcon === laptop?.icon, out.triggerIcon.slice(0, 80));
    check('and the selector and condition', /\.grid/.test(out.triggerText) && /≥ 64rem/.test(out.triggerText), out.triggerText);
  }
  if (failures.length) {
    console.error(`context-switcher-icons: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`context-switcher-icons: ${checked} passed  [real layout]`);
})();
