// Clicking a field puts the caret in that field.
//
//   node test/renderer/style/fieldFocus.test.js
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
const { ROOT, repoPath, sourceSpecifier } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('field-focus: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }

  const esbuild = require('esbuild');
  const root = ROOT;
  const buildDirectory = repoPath('node_modules/.stacki-test');
  const pageDirectory = path.join(buildDirectory, 'field-focus');
  fs.mkdirSync(pageDirectory, { recursive: true });

  // Both places this control is used: the transform settings popup and the
  // gradient centre it was copied from.
  const entry = path.join(buildDirectory, 'field-focus.entry.jsx');
  // The module specifier of a style-panel source file, written into the entry below.
  fs.writeFileSync(
    entry,
    `import React from 'react'
     import { createRoot } from 'react-dom/client'
     import EffectsSection from ${sourceSpecifier('src/features/style/EffectsSection.tsx')}
     import GradientEditor from ${sourceSpecifier('src/features/style/GradientEditor.tsx')}
     import { parseGradient } from ${sourceSpecifier('src/features/style/model/gradient.ts')}
     const decls = { transform: 'rotateZ(45deg)' }
     const read = (p) => decls[p] != null
       ? { source:'selected', overridden:false, contributors:[],
           winner:{ selectorText:'.x', value:decls[p], important:false },
           selectedValue:{ value:decls[p], important:false } }
       : undefined
     // Radial, so the centre row (the pad and its Left/Top fields) is drawn.
     const grad = parseGradient('radial-gradient(circle at 50% 50%, #000000, #ffffff)')
     createRoot(document.getElementById('root')).render(
       React.createElement('div',
         { className:'embed-editor_panel', style:{ width:'320px', padding:'12px' } },
         React.createElement(EffectsSection, {
           read, busy:false, setProp:()=>{}, clearProp:()=>{}, liveSetProp:()=>{},
           onProvenance:()=>{}, onSelectSelector:()=>{},
         }),
         React.createElement('div', { id:'grad' },
           React.createElement(GradientEditor, { gradient: grad, busy:false, onChange:()=>{} })),
       )
     )`,
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(pageDirectory, 'bundle.js'),
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
    path.join(pageDirectory, 'app.css'),
    [
      // The sheets styles.css imports first (its @import is not followed in a concatenation).
      'src/ui/controls.css',
      'src/ui/dropdown.css',
      'src/ui/resetLabel.css',
      'src/app/styles.css',
      'src/features/style/utilities.css',
      'src/features/style/embedEditor.css',
    ]
      .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css">' +
      '<style>body{margin:0;background:#1a1a1a}</style><div id="root"></div>' +
      '<script src="bundle.js"></script>',
  );

  const probe = path.join(pageDirectory, 'probe.js');
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
       await win.webContents.executeJavaScript(
         "document.querySelector('button[aria-label=\\"Transform settings\\"]').click(); null",
       );
       await sleep(400);

       const out = { fields: [] };
       // Which fields to press, by the label their input carries. The popup is
       // portaled to <body>, so it comes AFTER the gradient in document order —
       // walking the DOM would press a gradient field first, and that press is an
       // outside-press that dismisses the popup. Each field is therefore found and
       // measured immediately before it is pressed, with the popup reopened if a
       // previous press closed it.
       const POPUP = [
         'Transform origin left', 'Transform origin top',
         'Perspective origin left', 'Perspective origin top',
       ];
       const LABELS = [...POPUP, 'Position left', 'Position top'];
       for (const label of LABELS) {
         if (POPUP.includes(label)) {
           await win.webContents.executeJavaScript(\`(() => {
             if (!document.querySelector('.embed-editor_tsettings'))
               document.querySelector('button[aria-label="Transform settings"]').click();
             return null; })()\`);
           await sleep(350);
         }
         if (!POPUP.includes(label)) {
           await win.webContents.executeJavaScript(\`(() => {
             if (document.querySelector('.embed-editor_tsettings'))
               document.querySelector('button[aria-label="Transform settings"]').click();
             return null;
           })()\`);
           await sleep(350);
           await win.webContents.executeJavaScript(\`(() => {
             const input = document.querySelector(
               'input[aria-label=' + JSON.stringify(\${JSON.stringify(label)}) + ']');
             const editor = input?.closest('.embed-editor_varconnect')
               ?.querySelector('.embed-editor_varconnect-editor');
             editor?.scrollIntoView({ block: 'center', behavior: 'instant' });
             return null;
           })()\`);
           // Windows delivers the scroll and the resulting popup dismissal
           // on the next frame, so measure after the layout has settled.
           await sleep(150);
         }
         const t = await win.webContents.executeJavaScript(\`(() => {
           const input = document.querySelector(
             'input[aria-label=' + JSON.stringify(\${JSON.stringify(label)}) + ']');
           if (!input) return null;
           const wrap = input.closest('.embed-editor_varconnect');
           const ed = wrap && wrap.querySelector('.embed-editor_varconnect-editor');
           if (!ed) return { label: \${JSON.stringify(label)}, noEditor: true };
           ed.dataset.probe = 'target';
           const r = ed.getBoundingClientRect();
           return { label: \${JSON.stringify(label)},
                    inView: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight,
                    x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
                    inputHidden: getComputedStyle(input).opacity === '0' };
         })()\`);
         if (!t || t.noEditor || !t.inView) {
           out.fields.push({ label, skipped: true, why: t });
           continue;
         }
         await win.webContents.executeJavaScript(
           "document.activeElement && document.activeElement.blur(); null",
         );
         win.webContents.sendInputEvent(
           { type:'mouseDown', x:t.x, y:t.y, button:'left', clickCount:1 });
         win.webContents.sendInputEvent(
           { type:'mouseUp',   x:t.x, y:t.y, button:'left', clickCount:1 });
         await sleep(250);
         const after = await win.webContents.executeJavaScript(\`(() => {
           const a = document.activeElement;
           const hit = document.elementFromPoint(\${t.x}, \${t.y});
           return {
             caretInTheFieldPressed: !!(a && a.dataset && a.dataset.probe === 'target'),
             focusedAnInvisibleField:
               !!(a && a.tagName === 'INPUT' && getComputedStyle(a).opacity === '0'),
             activeTag: a ? a.tagName : null,
             hitTag: hit ? hit.tagName : null,
             hitCls: hit ? String(hit.className).slice(0,60) : null,
             popupOpen: !!document.querySelector('.embed-editor_tsettings'),
           };
         })()\`);
         await win.webContents.executeJavaScript(
           "document.querySelectorAll('[data-probe]').forEach(e => delete e.dataset.probe); null",
         );
         out.fields.push({ ...t, ...after });
       }
       // And nothing wraps one of these fields in a <label> any more.
       out.labelWrapped = await win.webContents.executeJavaScript(\`
         [...document.querySelectorAll('.embed-editor_varconnect')]
           .filter((w) => w.closest('label')).length\`);
       console.log(JSON.stringify(out));
       app.quit();
     });`,
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 180000 });
  const line = (run.stdout || '').split('\n').find((line) => line.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const out = JSON.parse(line);
    const tested = out.fields.filter((field) => !field.skipped);
    // A field that could not be found or was off-screen is not a pass — it is a
    // field this test did not check, and silence there is how a regression walks
    // back in.
    const skipped = out.fields.filter((field) => field.skipped);
    check('every field was reachable and pressed', skipped.length === 0, JSON.stringify(skipped));
    check(
      'both origin pads were among them',
      tested.filter((field) => /origin/i.test(field.label)).length === 4,
      JSON.stringify(tested.map((field) => field.label)),
    );
    check(
      'and the gradient centre too',
      tested.filter((field) => /^Position/.test(field.label)).length === 2,
      JSON.stringify(tested.map((field) => field.label)),
    );
    // The premise: these fields really are a visible editor over a hidden input.
    check(
      'the input behind them is invisible',
      tested.every((field) => field.inputHidden),
      JSON.stringify(tested.map((field) => [field.label, field.inputHidden])),
    );
    for (const field of tested) {
      check(
        `pressing "${field.label}" leaves the caret in it`,
        field.caretInTheFieldPressed,
        `focus went to ${field.activeTag}` +
          `${field.focusedAnInvisibleField ? ' — an invisible one' : ''}` +
          ` | at (${field.x},${field.y})` +
          ` the top element is ${field.hitTag}.${field.hitCls} | popup open: ${field.popupOpen}`,
      );
      check(
        `and not into a field that cannot be seen ("${field.label}")`,
        !field.focusedAnInvisibleField,
        `${field.activeTag} | hit=${field.hitTag}.${field.hitCls} popup=${field.popupOpen}`,
      );
    }
    // The cause, kept out directly: a <label> forwards the press to the input.
    check('no field is wrapped in a label', out.labelWrapped === 0, `${out.labelWrapped} still are`);
  }

  if (failures.length) {
    console.error(`field-focus: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`field-focus: ${checked} passed  [real presses, real layout]`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
