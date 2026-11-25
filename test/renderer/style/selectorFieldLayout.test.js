// Goal: the Style panel's selector field holds one height whether or not it has the
// caret, and a press on a control below it while it has the caret clicks that control
// the first time. The reported case: with the field focused, Flex and Grid needed two
// or three clicks. The focused field drew its caret on a line of its own under the
// chips, so the mouse down that blurred it shrank the well, the Display buttons moved
// up under the pointer, and the mouse came up over something else: no click.
//
//   node test/renderer/style/selectorFieldLayout.test.js
//
// Method: a real Electron window (skipped without Electron; the pattern of
// addQueryFormLayout) mounts the real SelectorPicker under the real tokens and
// stylesheets in a 340px-wide panel and reads rects. For one chip, three chips and
// enough long chips to wrap, the well's height is read at rest and focused, and the
// caret's row is compared with the last chip's (inline when the row has room). Then a
// Flex button sits under the picker, behind a spacer drawn only while a selector is
// picked: focusing the field deselects (no spacer), blurring restores the pick (the
// spacer pushes Flex down), which is the redraw a press from the field causes. The
// press is a real mouse down and up through the DevTools protocol at Flex's centre,
// and Flex's click handler must run exactly once. Waits poll state, never a fixed pause.

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
  const buildDirectory = repoPath('node_modules/.stacki-test/selector-field-layout');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { SelectorPicker } from './src/features/style/embed/SelectorPicker'
    import { setHost } from './src/features/style/model/host'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'
    setHost({})
    const chip = (text) => ({ key: text, text, specificity: [0, 1, 0], state: '', simple: true, fromComponent: false })
    const SETS = {
      one: ['.header_content'],
      three: [':target', ':focus-visible', '.header_content'],
      many: Array.from({ length: 9 }, (_, index) => '.header_content_part-' + index),
    }
    window.__flexClicks = 0
    function Picker({ name }) {
      const [active, setActive] = useState('.header_content')
      return (
        <div className="embed-editor_root" data-set={name} style={{ width: 340, margin: '12px 16px' }}>
          <SelectorPicker
            selectors={SETS[name].map(chip)}
            suggestions={[]}
            activeSelector={active}
            activePicked={false}
            busy={false}
            loading={false}
            onSelect={setActive}
            onDeselect={() => setActive('')}
            onAdd={() => {}}
          />
          {/* Drawn only while a selector is picked: the panel the restored pick redraws. */}
          {active === '' ? undefined : <div className="probe-spacer" style={{ height: 30 }} />}
          <button type="button" className="probe-flex" style={{ width: 60, height: 24 }} onClick={() => { window.__flexClicks += 1 }}>Flex</button>
        </div>
      )
    }
    createRoot(document.getElementById('root')).render(<>{Object.keys(SETS).map((name) => <Picker key={name} name={name} />)}</>)
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
    console.log('selector-field-layout: skipped, no Electron to lay it out in');
    return;
  }
  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 400, height: 900 });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
       await waitFor({ what: 'pickers drawn', read: () => js("document.querySelectorAll('.embed-editor_selector-add').length"), until: (count) => count === 3 });
       const measure = (name) => js(\`(() => {
         const root = document.querySelector('[data-set="\${name}"]');
         const chips = [...root.querySelectorAll('.embed-editor_selector-chip')].map((chip) => chip.getBoundingClientRect());
         const input = root.querySelector('.embed-editor_selector-add').getBoundingClientRect();
         const last = chips[chips.length - 1];
         return {
           well: root.querySelector('.embed-editor_selector-well').getBoundingClientRect().height,
           rows: new Set(chips.map((box) => Math.round(box.top))).size,
           chipHeight: Math.round(last.height),
           inputHeight: Math.round(input.height),
           inputBesideLast: Math.abs(input.top - last.top) <= 1 && input.left >= last.right,
           inputWidth: input.width,
           focused: document.activeElement === root.querySelector('.embed-editor_selector-add'),
         };
       })()\`);
       const focus = (name) => js(\`(() => { document.querySelector('[data-set="\${name}"] .embed-editor_selector-add').focus(); return true })()\`);
       const blur = () => js('(() => { document.activeElement && document.activeElement.blur(); return true })()');
       // A hidden window never has the system's focus, so Chromium sends no focus or
       // blur events; focus emulation makes the page behave as the focused one does.
       const cdp = win.webContents.debugger;
       if (!cdp.isAttached()) {
         cdp.attach('1.3');
       }
       await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
       const out = { sets: {} };
       for (const name of ['one', 'three', 'many']) {
         const rest = await measure(name);
         await focus(name);
         await waitFor({ what: name + ' focused', read: () => measure(name), until: (state) => state.focused });
         const focused = await measure(name);
         await blur();
         await waitFor({ what: name + ' blurred', read: () => measure(name), until: (state) => !state.focused });
         out.sets[name] = { rest, focused, after: await measure(name) };
       }
       // The press from the focused field onto Flex, in the 'three' panel.
       const flexCentre = () => js("(() => { const box = document.querySelector('[data-set=\\"three\\"] .probe-flex').getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } })()");
       const press = async (point) => {
         await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
         await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
       };
       const clicks = () => js('window.__flexClicks');
       await focus('three');
       await waitFor({ what: 'spacer gone while focused', read: () => js("document.querySelector('[data-set=\\"three\\"] .probe-spacer') === null"), until: (gone) => gone });
       const before = await flexCentre();
       await press(before);
       await waitFor({ what: 'the press settled', read: () => js("document.querySelector('[data-set=\\"three\\"] .probe-spacer') !== null"), until: (back) => back });
       await waitFor({ what: 'the click delivered', read: clicks, until: (count) => count >= 1 });
       out.fromField = { clicks: await clicks(), moved: (await flexCentre()).y - before.y };
       // And at rest, a press on Flex where it now is: one click, as ever.
       await press(await flexCentre());
       await waitFor({ what: 'the second click', read: clicks, until: (count) => count >= 2 });
       out.atRest = { clicks: await clicks() };
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
    for (const [name, { rest, focused, after }] of Object.entries(out.sets)) {
      check(`${name}: the well is as tall focused as at rest`, focused.well === rest.well, `${rest.well} → ${focused.well}`);
      check(`${name}: and as tall again once left`, after.well === rest.well, `${rest.well} → ${after.well}`);
      check(`${name}: the caret is a chip high`, focused.inputHeight === focused.chipHeight, `${focused.inputHeight} vs ${focused.chipHeight}`);
      check(`${name}: and keeps at least four characters`, focused.inputWidth >= 20, String(focused.inputWidth));
    }
    check('one chip: the caret sits beside it', out.sets.one?.focused.inputBesideLast === true, JSON.stringify(out.sets.one?.focused));
    check('three chips: the caret sits beside the last', out.sets.three?.focused.inputBesideLast === true, JSON.stringify(out.sets.three?.focused));
    check('many chips wrap onto more than one row', (out.sets.many?.rest.rows ?? 0) > 1, JSON.stringify(out.sets.many?.rest));
    check('the restored pick moved Flex under the pointer, as the panel does', out.fromField.moved > 0, String(out.fromField.moved));
    check('and the press from the focused field clicked Flex once', out.fromField.clicks === 1, String(out.fromField.clicks));
    check('a press at rest clicks it once more', out.atRest.clicks === 2, String(out.atRest.clicks));
  }
  if (failures.length) {
    console.error(`selector-field-layout: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`selector-field-layout: ${checked} passed  [real layout]`);
})();
