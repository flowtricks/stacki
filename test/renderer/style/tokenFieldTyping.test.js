// Spaces typed into a Style panel value field.
//
//   node test/renderer/style/tokenFieldTyping.test.js
//
// Goal: a value typed key by key into the panel's field is saved exactly as typed. A space typed
// at the end of a contentEditable's text is inserted by Chromium as a non-breaking space (U+00A0)
// so that it stays visible. CSS does not read U+00A0 as whitespace: `span 3` written with one is a
// span to a line named " 3", which spans one track, and `1fr 2fr` is a single invalid track.
// The value looks right in the field, in the stylesheet and in DevTools, and does not work.
//
// Method: what Chromium inserts for a typed space only shows when a browser does the typing, so
// this mounts the real LiveInput (the field behind Row Start and End, sizes and the rest) in a
// hidden Electron window, presses each key with sendInputEvent, leaves the field with Tab, and
// records every value the field hands to its callbacks: the live ones while typing and the commit
// on leaving. Each value has to hold no U+00A0, and the last one has to be the typed text itself.
// The values are ones a person types with a space in the middle: a span, a line pair and a track
// list.

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

// The values typed, one field each. Each holds at least one space typed after other text.
const TYPED = ['span 3', 'auto / span 3', '1fr 2fr'];
const NO_BREAK_SPACE = ' ';
const shown = (text) => JSON.stringify(text).replaceAll(NO_BREAK_SPACE, '<U+00A0>');

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/field-typing');
  fs.mkdirSync(buildDirectory, { recursive: true });

  const entry = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import LiveInput from './src/features/style/components/LiveInput'
    import { setHost } from './src/features/style/model/host'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'

    setHost({ projectPath: '/p', nodes: [], selectedId: null, files: [], astroFiles: [] })
    window.saved = ${JSON.stringify(TYPED)}.map(() => [])
    const record = (index) => (value) => window.saved[index].push(value)
    createRoot(document.getElementById('root')).render(
      <div className="embed-editor_root" style={{ width: 320, padding: 12 }}>
        {${JSON.stringify(TYPED)}.map((_, index) => (
          <div key={index} id={'field-' + index} className="embed-editor_rule" style={{ display: 'flex', width: 240, marginBottom: 12 }}>
            <LiveInput value="" busy={false} ariaLabel={'Field ' + index}
              onLive={record(index)} onCommit={record(index)} />
          </div>
        ))}
      </div>
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
    console.log('token-field-typing: skipped — no Electron to type in (see test/renderer/style/panelField.test.js for the pattern)');
    return;
  }

  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 600, height: 400 });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       const press = (keyCode, text) => {
         win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
         if (text !== undefined) {
           win.webContents.sendInputEvent({ type: 'char', keyCode: text });
         }
         win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
       };
       const typed = ${JSON.stringify(TYPED)};
       const out = { editable: [] };
       for (let index = 0; index < typed.length; index++) {
         // A press focuses the field as a person's click does.
         const point = await js("(() => { const r = document.querySelector('#field-" + index + " [contenteditable]').getBoundingClientRect(); " +
           "return { x: Math.round(r.x + 8), y: Math.round(r.y + r.height / 2) } })()");
         win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
         win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
         await pause(150);
         out.editable.push(await js("document.activeElement?.isContentEditable === true"));
         for (const character of typed[index]) {
           press(character === ' ' ? 'Space' : character, character);
           await pause(60);
         }
         press('Tab');
         await pause(300);
       }
       out.saved = await js('window.saved');
       console.log(JSON.stringify(out));
       app.quit();
     });`,
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000 });
  const line = (run.stdout || '').split('\n').find((candidate) => candidate.trim().startsWith('{'));
  if (!line) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 400));
  } else {
    const out = JSON.parse(line);
    TYPED.forEach((text, index) => {
      const saved = out.saved[index] ?? [];
      check(`${shown(text)}: the press focused the coloured field`, out.editable[index] === true);
      check(`${shown(text)}: the field saved a value`, saved.length > 0, 'no value reached the callbacks');
      const withNoBreakSpace = saved.filter((value) => value.includes(NO_BREAK_SPACE));
      check(`${shown(text)}: no saved value holds a non-breaking space`, withNoBreakSpace.length === 0, withNoBreakSpace.map(shown).join(', '));
      check(`${shown(text)}: the last saved value is the typed text`, saved.at(-1) === text, `saved ${shown(saved.at(-1))}`);
    });
  }

  if (failures.length) {
    console.error(`token-field-typing: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`token-field-typing: ${checked} passed  [typed spaces are saved as spaces]`);
})();
