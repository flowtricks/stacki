// Clicking a field puts the caret in that field.
//
//   node test/field-focus.js
//
// Sounds like nothing worth testing. It is here because it broke, in a way no
// amount of reading the component would have shown.
//
// A style-panel field is TWO elements stacked. VariableConnect draws the value
// in a contenteditable so it can be syntax-coloured and hold variable chips;
// the real <input> sits behind it at `opacity: 0; pointer-events: none`. The
// contenteditable is the field — it is what is visible and what a press lands
// on.
//
// Wrap that in a <label> and the browser undoes it. A press anywhere inside a
// <label> is forwarded to the label's control, and the control is the first
// LABELABLE descendant — which is the invisible <input>, since a
// contenteditable div is not labelable. So the click reached the visible field,
// and the browser then moved focus off it into a field with no caret to see.
// Typing went somewhere the user could not watch.
//
// jsdom cannot answer this: it has no layout, no label forwarding, and no real
// focus-on-press. So it is asked of a real browser, with real mouse events.

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
    console.log('field-focus: skipped  [needs a Chromium — see test/computed-color.js]');
    return;
  }

  const esbuild = require('esbuild');
  const root = path.join(__dirname, '..');
  const buildDir = path.join(root, 'node_modules', '.stacki-test');
  const pageDir = path.join(buildDir, 'field-focus');
  fs.mkdirSync(pageDir, { recursive: true });

  // Both places this control is used: the transform settings popup and the
  // gradient centre it was copied from.
  const entry = path.join(buildDir, 'field-focus.entry.jsx');
  fs.writeFileSync(
    entry,
    `import React from 'react'
     import { createRoot } from 'react-dom/client'
     import EffectsSection from ${JSON.stringify(path.join(root, 'src', 'style-panel', 'EffectsSection'))}
     import GradientEditor from ${JSON.stringify(path.join(root, 'src', 'style-panel', 'GradientEditor'))}
     import { parseGradient } from ${JSON.stringify(path.join(root, 'src', 'style-panel', 'lib', 'gradient'))}
     const decls = { transform: 'rotateZ(45deg)' }
     const read = (p) => decls[p] != null
       ? { source:'selected', overridden:false, contributors:[],
           winner:{ selectorText:'.x', value:decls[p], important:false },
           selectedValue:{ value:decls[p], important:false } }
       : undefined
     // Radial, so the centre row (the pad and its Left/Top fields) is drawn.
     const grad = parseGradient('radial-gradient(circle at 50% 50%, #000000, #ffffff)')
     createRoot(document.getElementById('root')).render(
       React.createElement('div', { className:'embed-editor_panel', style:{ width:'320px', padding:'12px' } },
         React.createElement(EffectsSection, {
           read, busy:false, setProp:()=>{}, clearProp:()=>{}, liveSetProp:()=>{},
           onProvenance:()=>{}, onSelectSelector:()=>{},
         }),
         React.createElement('div', { id:'grad' },
           React.createElement(GradientEditor, { gradient: grad, busy:false, onChange:()=>{} })),
       )
     )`
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
  // The real stylesheets — the whole point is the `opacity: 0` on the input,
  // which only exists in the CSS.
  fs.writeFileSync(
    path.join(pageDir, 'app.css'),
    ['src/styles.css', 'src/style-panel/utilities.css', 'src/style-panel/embed-editor.css']
      .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
      .join('\n')
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
       const win = new BrowserWindow({ show: false, width: 520, height: 1700 });
       await win.loadFile(path.join(__dirname, 'index.html'));
       await sleep(800);
       // Open the transform settings popup.
       await win.webContents.executeJavaScript("document.querySelector('button[aria-label=\\"Transform settings\\"]').click(); null");
       await sleep(400);

       const out = { fields: [] };
       // Which fields to press, by the label their input carries. The popup is
       // portaled to <body>, so it comes AFTER the gradient in document order —
       // walking the DOM would press a gradient field first, and that press is an
       // outside-press that dismisses the popup. Each field is therefore found and
       // measured immediately before it is pressed, with the popup reopened if a
       // previous press closed it.
       const POPUP_JS = ['Transform origin left', 'Transform origin top', 'Perspective origin left', 'Perspective origin top'];
       const POPUP = ['Transform origin left', 'Transform origin top', 'Perspective origin left', 'Perspective origin top'];
       const LABELS = [...POPUP, 'Position left', 'Position top'];
       for (const label of LABELS) {
         if (POPUP.includes(label)) {
           await win.webContents.executeJavaScript(\`(() => {
             if (!document.querySelector('.embed-editor_tsettings'))
               document.querySelector('button[aria-label="Transform settings"]').click();
             return null; })()\`);
           await sleep(350);
         }
         const t = await win.webContents.executeJavaScript(\`(() => {
           const input = document.querySelector('input[aria-label=' + JSON.stringify(\${JSON.stringify(label)}) + ']');
           if (!input) return null;
           const wrap = input.closest('.embed-editor_varconnect');
           const ed = wrap && wrap.querySelector('.embed-editor_varconnect-editor');
           if (!ed) return { label: \${JSON.stringify(label)}, noEditor: true };
           ed.dataset.probe = 'target';
           // Bring it on screen first — but never for a popup field: scrolling is
           // one of the things that dismisses the popover, so the press would land
           // on nothing. Those are drawn in view already (the popover pins itself
           // to the window).
           if (!\${JSON.stringify(POPUP_JS)}.includes(\${JSON.stringify(label)})) ed.scrollIntoView({ block: 'center' });
           const r = ed.getBoundingClientRect();
           return { label: \${JSON.stringify(label)},
                    inView: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight,
                    x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
                    inputHidden: getComputedStyle(input).opacity === '0' };
         })()\`);
         if (!t || t.noEditor || !t.inView) { out.fields.push({ label, skipped: true, why: t }); continue; }
         await win.webContents.executeJavaScript("document.activeElement && document.activeElement.blur(); null");
         win.webContents.sendInputEvent({ type:'mouseDown', x:t.x, y:t.y, button:'left', clickCount:1 });
         win.webContents.sendInputEvent({ type:'mouseUp',   x:t.x, y:t.y, button:'left', clickCount:1 });
         await sleep(250);
         const after = await win.webContents.executeJavaScript(\`(() => {
           const a = document.activeElement;
           const hit = document.elementFromPoint(\${t.x}, \${t.y});
           return {
             caretInTheFieldPressed: !!(a && a.dataset && a.dataset.probe === 'target'),
             focusedAnInvisibleField: !!(a && a.tagName === 'INPUT' && getComputedStyle(a).opacity === '0'),
             activeTag: a ? a.tagName : null,
             hitTag: hit ? hit.tagName : null, hitCls: hit ? String(hit.className).slice(0,60) : null,
             popupOpen: !!document.querySelector('.embed-editor_tsettings'),
           };
         })()\`);
         await win.webContents.executeJavaScript("document.querySelectorAll('[data-probe]').forEach(e => delete e.dataset.probe); null");
         out.fields.push({ ...t, ...after });
       }
       // And nothing wraps one of these fields in a <label> any more.
       out.labelWrapped = await win.webContents.executeJavaScript(\`
         [...document.querySelectorAll('.embed-editor_varconnect')]
           .filter((w) => w.closest('label')).length\`);
       console.log(JSON.stringify(out));
       app.quit();
     });`
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 180000 });
  const line = (run.stdout || '').split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const out = JSON.parse(line);
    const tested = out.fields.filter((f) => !f.skipped);
    // A field that could not be found or was off-screen is not a pass — it is a
    // field this test did not check, and silence there is how a regression walks
    // back in.
    const skipped = out.fields.filter((f) => f.skipped);
    check('every field was reachable and pressed', skipped.length === 0, JSON.stringify(skipped));
    check('both origin pads were among them', tested.filter((f) => /origin/i.test(f.label)).length === 4, JSON.stringify(tested.map((f) => f.label)));
    check('and the gradient centre too', tested.filter((f) => /^Position/.test(f.label)).length === 2, JSON.stringify(tested.map((f) => f.label)));
    // The premise: these fields really are a visible editor over a hidden input.
    check('the input behind them is invisible', tested.every((f) => f.inputHidden), JSON.stringify(tested.map((f) => [f.label, f.inputHidden])));
    for (const f of tested) {
      check(`pressing "${f.label}" leaves the caret in it`, f.caretInTheFieldPressed, `focus went to ${f.activeTag}${f.focusedAnInvisibleField ? ' — an invisible one' : ''} | at (${f.x},${f.y}) the top element is ${f.hitTag}.${f.hitCls} | popup open: ${f.popupOpen}`);
      check(`and not into a field that cannot be seen ("${f.label}")`, !f.focusedAnInvisibleField, `${f.activeTag} | hit=${f.hitTag}.${f.hitCls} popup=${f.popupOpen}`);
    }
    // The cause, kept out directly: a <label> forwards the press to the input.
    check('no field is wrapped in a label', out.labelWrapped === 0, `${out.labelWrapped} still are`);
  }

  if (failures.length) {
    console.error(`field-focus: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`field-focus: ${checked} passed  [real presses, real layout]`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
