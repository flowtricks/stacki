// One value field, everywhere in the panel.
//
//   node test/panel-field.js
//
// Every row that takes a typed value had its own copy of the same field, and the
// copies drifted: the one in the position popup (transform origin, gradient
// centre) ended up on smaller type and tighter padding than the field two rows
// above it, so a popup opened over the panel looked like a different app. They
// are one component now (components/LiveInput), and this measures the thing that
// went wrong — the field in the popup against a field in the panel — rather than
// checking that both call the same function.
//
// The other half is the focus ring. A field with a unit is the input AND the
// unit; a ring around the input alone leaves the `%` outside the box it belongs
// to. The ring is the box's.
//
// Both are questions about rendered boxes, so this runs in a real browser.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'field');
  fs.mkdirSync(buildDir, { recursive: true });

  const entry = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { NumField } from './src/style-panel/components/PositionGrid'
    import SizeSection from './src/style-panel/SizeSection'
    import { setHost } from './src/style-panel/lib/host'
    import './src/style-panel/tokens.css'
    import './src/style-panel/utilities.css'
    import './src/style-panel/embed-editor.css'

    setHost({ projectPath: '/p', nodes: [], selectedId: null, files: [], astroFiles: [] })
    const resolved = (value) => ({ source: 'selected', selectedValue: { value, important: false }, winner: { value, important: false }, contributors: [] })
    const props = {
      read: (p) => (p === 'max-width' ? resolved('20rem') : undefined),
      busy: false, setProp: () => {}, clearProp: () => {}, liveSetProp: () => {},
      onProvenance: () => {}, onSelectSelector: () => {},
    }
    createRoot(document.getElementById('root')).render(
      <div className="embed-editor_root" style={{ width: 320, padding: 12 }}>
        <div className="embed-editor_rule">
          <div id="popupfield" style={{ display: 'flex', width: 160 }}>
            <NumField value="50%" unit="%" label="Position left" busy={false} onLive={() => {}} onCommit={() => {}} />
          </div>
          <SizeSection {...props} />
        </div>
      </div>
    )
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: path.join(__dirname, '..'), loader: 'jsx' },
    outfile: path.join(buildDir, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(buildDir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>body{margin:0;background:#111}</style><div id="root"></div><script src="bundle.js"></script>'
  );

  const electronPath = (() => {
    try { return require('electron'); } catch { return null; }
  })();
  if (typeof electronPath !== 'string') {
    console.log('panel-field: skipped — no Electron to lay it out in (see test/gap-bands.js for the pattern)');
    return;
  }

  const scriptPath = path.join(buildDir, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 900, height: 700 });
       await win.loadFile(${JSON.stringify(path.join(buildDir, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       await new Promise((r) => setTimeout(r, 400));
       // A window that is not on screen does not run transitions, so a transitioned
       // box-shadow would read as its starting value forever. Nothing here is about
       // the animation.
       await js("(() => { const s = document.createElement('style'); s.textContent = '* { transition: none !important }'; document.head.appendChild(s); return true })()");

       const shape = (sel) => js("(() => { const el = document.querySelector('" + sel + "'); const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return { h: Math.round(r.height), font: c.fontSize, family: c.fontFamily.split(',')[0].replace(/[\\"']/g, ''), padding: c.padding, radius: c.borderRadius } })()");
       const out = {};
       out.popup = await shape('#popupfield input');
       out.panel = await shape('input[data-prop=\\"max-width\\"]');
       out.focus = await js("(() => { const f = document.querySelector('#popupfield .embed-editor_field'); const i = f.querySelector('[contenteditable]') || f.querySelector('input'); i.focus(); const fs = getComputedStyle(f), is = getComputedStyle(f.querySelector('input')), es = getComputedStyle(i); const fr = f.getBoundingClientRect(), sr = f.querySelector('.embed-editor_field-suffix').getBoundingClientRect(); return { onBox: fs.boxShadow, onInput: is.boxShadow, onVisible: es.boxShadow, suffixInside: sr.left >= fr.left && sr.right <= fr.right, focusWithin: f.matches(':focus-within') } })()");
       out.suffix = await js("(() => { const s = document.querySelector('#popupfield .embed-editor_field-suffix'); return s && s.textContent })()");
       console.log(JSON.stringify(out));
       app.quit();
     });`
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000 });
  const line = (run.stdout || '').split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 400));
  } else {
    const out = JSON.parse(line);
    check('the popup field is as tall as a panel field', out.popup.h === out.panel.h, `${out.popup.h} vs ${out.panel.h}`);
    check('and set in the same type', out.popup.font === out.panel.font && out.popup.family === out.panel.family, `${out.popup.font} ${out.popup.family} vs ${out.panel.font} ${out.panel.family}`);
    check('and padded the same', out.popup.padding === out.panel.padding, `${out.popup.padding} vs ${out.panel.padding}`);
    check('the field carries its unit', out.suffix === '%', String(out.suffix));
    // The visible half of the field is the contenteditable VariableConnect draws
    // (see test/field-focus.js) — that is what a press focuses, so that is what
    // has to raise the ring.
    check('focus reaches the field', out.focus.focusWithin === true);
    check('the ring is drawn round the box', /rgb/.test(out.focus.onBox) && out.focus.onBox !== 'none', out.focus.onBox);
    check('and not round the input inside it', out.focus.onInput === 'none', out.focus.onInput);
    check('nor round the visible half of it', out.focus.onVisible === 'none', out.focus.onVisible);
    check('so the unit is inside the ring', out.focus.suffixInside === true);
  }

  if (failures.length) {
    console.error(`panel-field: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`panel-field: ${checked} passed  [popup field vs panel field, ring on the box]`);
})();
