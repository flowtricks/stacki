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
    import EffectsSection from './src/style-panel/EffectsSection'
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
    // A transition, so its editor's Duration and Easing can be measured against
    // the panel's own fields — they are in a popover, which is exactly how they
    // came to be different in the first place.
    // Two of them: one plain, one whose duration and easing are variables. The
    // second is the case that squeezed the slider to nothing — a variable's name
    // is long — and the one that has to show chips.
    const fx = { ...props, read: (p) => (p === 'transition' ? resolved('opacity 200ms ease, transform var(--open-duration) var(--open-ease)') : undefined) }
    createRoot(document.getElementById('root')).render(
      <div className="embed-editor_root" style={{ width: 320, padding: 12 }}>
        <div className="embed-editor_rule">
          <div id="popupfield" style={{ display: 'flex', width: 160 }}>
            <NumField value="50%" unit="%" label="Position left" busy={false} onLive={() => {}} onCommit={() => {}} />
          </div>
          <SizeSection {...props} />
          <EffectsSection {...fx} />
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

       // Open the transition's editor — a real press, because the row opens on one.
       const clickAt = async (x, y) => {
         win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
         win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
         await new Promise((r) => setTimeout(r, 150));
       };
       // The effects section is long; the row has to be on screen before a press
       // at its coordinates means anything.
       const rowAt = (n) => js("(() => { const rows = [...document.querySelectorAll('.embed-editor_transitions .embed-editor_bg-layer-main')]; const r = rows[" + n + "]; if (!r) return null; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()");
       const layerRow = await rowAt(1);
       await new Promise((r) => setTimeout(r, 120));
       if (layerRow) await clickAt(layerRow.x, layerRow.y);
       const opening = { open: await js("!!document.querySelector('.embed-editor_layer-popover')"), foundRow: !!layerRow, sections: await js("[...document.querySelectorAll('.embed-editor_transitions')].length"), rows: await js("[...document.querySelectorAll('.embed-editor_bg-layer-main')].map((n) => n.textContent).join('|')") };

       const shape = (sel) => js("(() => { const el = document.querySelector('" + sel + "'); const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return { h: Math.round(r.height), font: c.fontSize, family: c.fontFamily.split(',')[0].replace(/[\\"']/g, ''), padding: c.padding, radius: c.borderRadius } })()");
       const out = { opening };
       // One line and double-quoted: this whole probe is itself a template
       // literal, so a backtick or an interpolation in here would belong to the
       // wrong one.
       out.varFields = await js("(() => { const pop = document.querySelector('.embed-editor_layer-popover'); if (!pop) return null; const shape = (el) => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); return { h: Math.round(r.height), font: c.fontSize, w: Math.round(r.width) } }; const dur = pop.querySelector('.embed-editor_trans-duration .embed-editor_field'); const ease = pop.querySelector('.embed-editor_trans-easing .embed-editor_field'); const slider = pop.querySelector('.u-drag-slider'); return { sharedField: !!dur && !!ease, input: dur && shape(dur.querySelector('input')), dots: [dur, ease].map((f) => !!(f && f.querySelector('.embed-editor_varconnect-dot'))), chips: [dur, ease].map((f) => !!(f && f.querySelector('.embed-editor_varconnect-token-name'))), code: [dur, ease].map((f) => !!(f && f.querySelector('[contenteditable]'))), slider: slider && Math.round(slider.getBoundingClientRect().width) } })()");
       // Close the open one first — it is drawn over the rows, so a press aimed at
       // another row would land on the popover instead.
       win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
       win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
       await new Promise((r) => setTimeout(r, 150));
       const plainRow = await rowAt(0);
       if (plainRow) await clickAt(plainRow.x, plainRow.y);
       out.plainFields = await js("(() => { const pop = document.querySelector('.embed-editor_layer-popover'); if (!pop) return null; const shape = (el) => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); return { h: Math.round(r.height), font: c.fontSize, w: Math.round(r.width) } }; const dur = pop.querySelector('.embed-editor_trans-duration .embed-editor_field'); const ease = pop.querySelector('.embed-editor_trans-easing .embed-editor_field'); const slider = pop.querySelector('.u-drag-slider'); return { sharedField: !!dur && !!ease, input: dur && shape(dur.querySelector('input')), dots: [dur, ease].map((f) => !!(f && f.querySelector('.embed-editor_varconnect-dot'))), chips: [dur, ease].map((f) => !!(f && f.querySelector('.embed-editor_varconnect-token-name'))), code: [dur, ease].map((f) => !!(f && f.querySelector('[contenteditable]'))), slider: slider && Math.round(slider.getBoundingClientRect().width) } })()");
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

    // The transition editor's own two fields, which are in a popover and had
    // grown their own plain inputs: no way to reach a variable, and a slider
    // squeezed to nothing beside them.
    check('the transition editor opens', out.opening?.open === true, JSON.stringify(out.opening));
    check('the transition editor uses the panel field', out.varFields?.sharedField === true, JSON.stringify(out.varFields));
    check('at the same height as the panel', out.varFields?.input?.h === out.panel.h, `${out.varFields?.input?.h} vs ${out.panel.h}`);
    check('and the same type', out.varFields?.input?.font === out.panel.font, `${out.varFields?.input?.font} vs ${out.panel.font}`);
    check('a variable in either field reads as a chip', out.varFields?.chips?.every(Boolean) === true, JSON.stringify(out.varFields?.chips));
    check('and the value is drawn as code', out.varFields?.code?.every(Boolean) === true, JSON.stringify(out.varFields?.code));
    // A track you cannot aim at is not a control. Beside a variable's name it
    // had about four pixels of it.
    check('the duration slider is still wide enough to drag', out.varFields?.slider >= 80, `${out.varFields?.slider}px`);
    // And on a plain value, the way in to the picker is the dot.
    check('a plain value offers the variable dot instead', out.plainFields?.dots?.every(Boolean) === true, JSON.stringify(out.plainFields));
  }

  if (failures.length) {
    console.error(`panel-field: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`panel-field: ${checked} passed  [popup fields vs panel fields, ring on the box]`);
})();
