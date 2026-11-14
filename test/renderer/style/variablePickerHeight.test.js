// The variable picker never grows past its height cap, and stays usable and on screen.
//
//   node test/renderer/style/variablePickerHeight.test.js
//
// Goal: an inline max-height (the room left in the window) once replaced the stylesheet's
// cap, so on a tall window the picker ran from the top of the screen past the bottom with
// every variable in it. The picker is now capped at PICKER_HEIGHT_REM_MAX, opens on the side of
// the field with more room, never shrinks below a readable minimum, keeps the search row
// pinned and scrolls only its list, and the arrow keys keep the marked row in sight.
// Method: this is a question about layout, so it runs in a real browser (Electron, hidden
// window, the pattern of popoverDropdown.test.js). The real VariablePicker is mounted as each of
// its hosts (the chip control with its search box, the code field's typing list) over a
// 150-variable list in many groups, anchored at the top, middle and bottom of windows 500, 700
// and 1000 tall. Keys are dispatched events, not pointer input, so it runs on every runner.
// The pure placement function is also checked without a browser.

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
  const buildDirectory = repoPath('node_modules/.stacki-test/picker-height');
  fs.mkdirSync(buildDirectory, { recursive: true });

  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { VariablePicker } from './src/features/style/VariablePicker'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'

    const FAMILIES = ['color', 'space', 'radius', 'font', 'shadow', 'border', 'size', 'margin', 'padding', 'gap']
    const VARS = Array.from({ length: 150 }, (_, i) => {
      const family = FAMILIES[i % FAMILIES.length]
      const name = family + '-' + Math.floor(i / FAMILIES.length)
      return { name, collection: 'Core', group: i % 3 === 0 ? '.theme-dark' : '', value: i + 'px', binding: 'var(--' + name + ')', type: 'Size', file: 'a.css' }
    })

    // Two hosts render the same component: the chip control (its own search box) and the code
    // field (a reference being typed, no search box; the field's keys drive the list).
    const navigationRef = { current: undefined }
    window.__nav = navigationRef
    function Harness() {
      const [state, setState] = useState(null)
      window.__show = (value) => setState(value)
      if (state === null) return null
      return (
        <div className="embed-editor_root">
          <div id="anchor" style={{ position: 'fixed', top: state.top, left: 20, width: 300, height: 28, background: '#333' }}>row</div>
          <Picker key={state.top + state.host} host={state.host} />
        </div>
      )
    }
    function Picker({ host }) {
      const [anchor, setAnchor] = useState(null)
      const typing = host === 'code' ? { query: 'e', navigationRef } : undefined
      return (
        <>
          <div ref={(el) => { if (el && !anchor) setAnchor(document.getElementById('anchor')) }} />
          {anchor ? (
            <VariablePicker anchor={anchor} vars={VARS} loading={false} prop="--x" {...(typing ? { typing } : { selectedBinding: 'var(--space-12)' })} onPick={() => {}} onClose={() => {}} />
          ) : null}
        </>
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
    loader: { '.woff2': 'empty', '.woff': 'empty', '.svg': 'empty', '.png': 'empty' },
  });
  fs.writeFileSync(
    path.join(buildDirectory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css">' +
      '<style>html{font-size:16px}body{margin:0;background:#111}</style><div id="root"></div><script src="bundle.js"></script>',
  );

  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('variable-picker-height: skipped, no Electron to lay it out in');
    return;
  }

  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 420, height: 700, useContentSize: true });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
       const results = [];
       const HOSTS = ['chip', 'code'];
       const probe = "(() => { const p = document.querySelector('.embed-editor_varpicker'); const l = p.querySelector('.embed-editor_varpicker-list'); " +
         "const r = p.getBoundingClientRect(); const sr = p.querySelector('.embed-editor_varpicker-searchrow'); const s = sr ? sr.getBoundingClientRect() : { top: -1 }; let inline = []; for (let n = l; n && n !== document.body; n = n.parentElement) { if (n.style.height || n.style.minHeight) inline.push(n.className + ':' + n.style.height + '/' + n.style.minHeight) } " +
         "return { top: r.top, bottom: r.bottom, height: r.height, innerHeight: window.innerHeight, scrollHeight: l.scrollHeight, clientHeight: l.clientHeight, searchTop: s.top, docScroll: document.scrollingElement.scrollTop, headingGaps: [...p.querySelectorAll('.embed-editor_varpicker-group-name, .embed-editor_varpicker-family-name')].map((h) => parseFloat(getComputedStyle(h).paddingBottom)), inline, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) } })()";
       for (const host of HOSTS) for (const height of [500, 700, 1000]) {
         win.setContentSize(420, height);
         await wait(150);
         for (const where of ['top', 'middle', 'bottom']) {
           const top = where === 'top' ? 40 : where === 'middle' ? Math.round(height / 2) : height - 60;
           await js('window.__show(null)');
           await wait(30);
           await js('window.__show({ top: ' + top + ', host: ' + JSON.stringify(host) + ' })');
           // The popup opens with a slight scale; measure once it has settled.
           for (let tries = 0; tries < 40; tries += 1) {
             if (await js("document.querySelector('.embed-editor_varpicker')?.dataset.popupPhase === 'open'")) break;
             await wait(50);
           }
           // The phase turns to 'open' when the scale starts to settle, not when it has: on a slow
           // runner the box is still growing for a while. Wait, within a bound, until two reads of the
           // search row's top, one frame apart, agree.
           let lastTop = Number.NaN;
           for (let tries = 0; tries < 80; tries += 1) {
             const now = await js("document.querySelector('.embed-editor_varpicker-searchrow')?.getBoundingClientRect().top ?? -1");
             if (now === lastTop) break;
             lastTop = now;
             await wait(60);
           }
           const before = await js(probe);
           await js("document.querySelector('.embed-editor_varpicker-list').scrollTop = 600");
           await wait(50);
           const scrolled = await js(probe);
           // Arrow keys: dispatched, walking well past the first screenful.
           let visible = true;
           let failedStep = -1;
           let failedInfo = '';
           for (let step = 0; step < 60; step += 1) {
             if (host === 'chip') {
               await js("document.querySelector('.embed-editor_varpicker-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))");
             } else {
               await js("window.__nav.current.move(1)");
             }
             // The list scrolls the marked row into view on the next frame, which a slow runner
             // delays: ask again, within a bound, before calling the row out of sight.
             let inSight = false;
             for (let tries = 0; tries < 40 && !inSight; tries += 1) {
               await wait(25);
               inSight = await js("(() => { const l = document.querySelector('.embed-editor_varpicker-list'); const row = l.querySelector('.is-selected, .is-active'); if (!row) return false; " +
                 "const a = l.getBoundingClientRect(), b = row.getBoundingClientRect(); return b.top >= a.top - 1 && b.bottom <= a.bottom + 1 })()");
             }
             if (!inSight) { visible = false; failedStep = step; failedInfo = await js("(() => { const l = document.querySelector('.embed-editor_varpicker-list'); const a = l.getBoundingClientRect(); return [...l.querySelectorAll('.is-selected, .is-active')].map((r) => r.className + ' ' + Math.round(r.getBoundingClientRect().top - a.top) + '/' + Math.round(a.height)).join(' | ') })()"); break; }
           }
           results.push({ host, height, where, top, before, scrolled, visible, failedStep, failedInfo });
         }
       }
       console.log(JSON.stringify(results));
       app.quit();
     });`,
  );

  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 120000, env });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('['));
  if (!line) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 600));
  } else {
    const capRem = 18;
    for (const result of JSON.parse(line)) {
      const label = `${result.host} host, window ${result.height}, field at ${result.where}`;
      const { before, scrolled } = result;
      check(`${label}: at most 18rem`, before.height / before.rem <= capRem + 0.01, `${before.height / before.rem}rem`);
      check(
        `${label}: a heading leaves at least 0.25rem above its first row`,
        before.headingGaps.length > 0 && before.headingGaps.every((gap) => gap / before.rem >= 0.25),
        JSON.stringify(before.headingGaps),
      );
      check(`${label}: no ancestor of the list sets a height of its own`, before.inline.length === 0, before.inline.join(' '));
      check(
        `${label}: at least the readable minimum (or what the window holds)`,
        before.height >= Math.min(10 * 16, result.height - 32) - 0.5,
        `${before.height}px`,
      );
      check(
        `${label}: inside the window`,
        before.top >= -0.5 && before.bottom <= before.innerHeight + 0.5,
        `${before.top}..${before.bottom} of ${before.innerHeight}`,
      );
      check(`${label}: the list scrolls`, before.scrollHeight > before.clientHeight, `${before.scrollHeight} vs ${before.clientHeight}`);
      check(
        `${label}: the search stays pinned while the list scrolls`,
        result.host === 'code' || Math.abs(scrolled.searchTop - before.searchTop) < 0.5,
        `${before.searchTop} -> ${scrolled.searchTop}`,
      );
      check(`${label}: the page does not scroll`, scrolled.docScroll === 0, String(scrolled.docScroll));
      check(
        `${label}: the arrows keep the marked row in sight`,
        result.visible === true,
        `the row left sight at step ${result.failedStep}: ${result.failedInfo}`,
      );
    }
  }

  // The pure placement, without a browser: the side with more room, the cap, the floor.
  {
    const placementBundle = path.join(buildDirectory, 'placement.js');
    await esbuild.build({
      entryPoints: [repoPath('src/features/style/VariablePicker.tsx')],
      outfile: placementBundle,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      loader: { '.css': 'empty' },
      logLevel: 'silent',
    });
    const { pickerPlacement } = require(placementBundle);
    const base = { naturalHeight: 3000, rootFontPx: 16 };
    const roomy = pickerPlacement({ ...base, rowTop: 100, rowBottom: 128, viewportHeight: 2000 });
    check('a tall window still caps the height', roomy.side === 'below' && roomy.heightMax === 288, JSON.stringify(roomy));
    const low = pickerPlacement({ ...base, rowTop: 900, rowBottom: 928, viewportHeight: 1000 });
    check('near the bottom it opens above', low.side === 'above' && low.heightMax === 288, JSON.stringify(low));
    const short = pickerPlacement({ ...base, rowTop: 300, rowBottom: 328, viewportHeight: 600 });
    check('in a short window it keeps the minimum height', short.heightMax >= 160, JSON.stringify(short));
  }

  if (failures.length) {
    console.error(`variable-picker-height: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`variable-picker-height: ${checked} passed  [real layout]`);
})();
