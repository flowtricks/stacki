// A dropdown inside a layer popover.
//
//   node test/popover-dropdown.js
//
// The layer editors (a transition, a shadow, a background layer) open in a
// popover, and the first control in most of them is a dropdown. The popover's
// box was a scroll container — `max-height: 94vh; overflow-y: auto`, there so a
// tall editor could not run off the screen — and a scroll container clips. This
// far down the panel there is rarely room below the trigger, so the menu opens
// UPWARD, lands outside the box, and was clipped away: invisible, and worse,
// not there to be clicked. The press went through to the panel behind it, which
// read as a click outside, which closed the popover. Choosing a transition type
// shut the editor instead.
//
// Clipping is a question about layout, so this runs in a real browser — jsdom
// has none, and would report every one of these as fine. It mounts the actual
// LayerPopover with a real Select inside it, opens the menu, and asks the page
// the only question that matters: at the option's own coordinates, is the
// option what you would hit?

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
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test', 'popover');
  fs.mkdirSync(buildDir, { recursive: true });

  // The popover anchored near the bottom of the window, which is where a layer
  // row sits in the panel — and the reason the menu has to open upward.
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import LayerPopover from './src/style-panel/LayerPopover'
    import Select from './src/style-panel/components/Select'
    import './src/style-panel/tokens.css'
    import './src/style-panel/utilities.css'
    import './src/style-panel/embed-editor.css'

    const OPTIONS = Array.from({ length: 24 }, (_, i) => ({ value: 'p' + i, label: 'Property ' + i }))

    function Harness() {
      const [anchor, setAnchor] = useState(null)
      const [tall, setTall] = useState(false)
      window.__setTall = setTall
      return (
        <div className="embed-editor_root">
          <div ref={(el) => el && !anchor && setAnchor(el)} id="anchor" style={{ position: 'fixed', bottom: 24, left: 12, width: 280, height: 28, background: '#333' }}>row</div>
          {anchor ? (
            <LayerPopover anchorEl={anchor} ariaLabel="Layer" onClose={() => { window.__closed = (window.__closed || 0) + 1 }}>
              <div style={{ height: tall ? 4000 : undefined }}>
                <Select value="p0" options={OPTIONS} onChange={() => {}} ariaLabel="Type" />
              </div>
            </LayerPopover>
          ) : null}
        </div>
      )
    }
    createRoot(document.getElementById('root')).render(<Harness />)
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
    console.log('popover-dropdown: skipped — no Electron to lay it out in (see test/gap-bands.js for the pattern)');
    return;
  }

  const scriptPath = path.join(buildDir, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 900, height: 700 });
       await win.loadFile(${JSON.stringify(path.join(buildDir, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       // A real press, from the browser's own input pipeline — a dispatched event
       // would be delivered to the element it is dispatched ON, which is exactly
       // the question being asked here.
       const clickAt = async (x, y) => {
         win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
         win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
         await new Promise((r) => setTimeout(r, 60));
       };
       await new Promise((r) => setTimeout(r, 400));

       const out = {};
       out.box = await js("(() => { const b = document.querySelector('.embed-editor_layer-popover-box'); return { overflow: getComputedStyle(b).overflowY, scrollingClass: b.className.includes('is-scrolling') } })()");
       const trigger = await js("(() => { const r = document.querySelector('.u-select-button').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()");
       await js("window.__why = []; document.addEventListener('mousedown', (e) => window.__why.push('mousedown on ' + String(e.target.className || e.target.nodeName).slice(0, 30) + (document.querySelector('.embed-editor_layer-popover').contains(e.target) ? ' (inside)' : ' (OUTSIDE)')), true); window.addEventListener('scroll', (e) => window.__why.push('scroll from ' + String(e.target.className || e.target.nodeName).slice(0, 30)), true); true");
       await clickAt(trigger.x, trigger.y);
       out.opened = await js("!!document.querySelector('.u-select-list')");
       out.dropUp = await js("!!document.querySelector('.u-select-list.is-up')");
       out.menu = await js("(() => { const l = document.querySelector('.u-select-list'); const b = document.querySelector('.embed-editor_layer-popover-box'); if (!l) return null; const lr = l.getBoundingClientRect(), br = b.getBoundingClientRect(); return { above: lr.top < br.top, o: [...l.querySelectorAll('[role=\\"option\\"]')].length } })()");
       // The question: at an option's own coordinates, what would you hit?
       out.hit = await js("(() => { const o = document.querySelectorAll('.u-select-list [role=\\"option\\"]')[3]; const r = o.getBoundingClientRect(); const at = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)); return { isTheOption: at === o || o.contains(at), hit: String(at && at.className || '').slice(0, 40), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()");
       // And pressing there must not shut the popover. Record what any close is
       // actually reacting to, so a failure here names its own cause.
       await clickAt(out.hit.x, out.hit.y);
       out.why = await js('window.__why');
       out.afterPick = await js("({ popover: !!document.querySelector('.embed-editor_layer-popover'), closes: window.__closed || 0 })");

       // A box that really does outgrow the screen still scrolls — the reason the
       // overflow was there in the first place.
       await js('window.__setTall(true)');
       await new Promise((r) => setTimeout(r, 200));
       out.tall = await js("(() => { const b = document.querySelector('.embed-editor_layer-popover-box'); return { overflow: getComputedStyle(b).overflowY, scrollingClass: b.className.includes('is-scrolling') } })()");

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
    check('the popover does not clip by default', out.box.overflow === 'visible', out.box.overflow);
    check('and is not marked as scrolling', out.box.scrollingClass === false);
    check('the menu opens', out.opened === true);
    check('upward, having no room below', out.dropUp === true);
    check('so it hangs outside the popover box', out.menu?.above === true, JSON.stringify(out.menu));
    check('and the option is what is at the option', out.hit.isTheOption === true, out.hit.hit);
    check('pressing it leaves the popover open', out.afterPick.popover === true);
    check('and asks nobody to close it', out.afterPick.closes === 0, `${out.afterPick.closes} close calls — ${JSON.stringify(out.why)}`);
    check('a box taller than the screen still scrolls', out.tall.scrollingClass === true && out.tall.overflow === 'auto', JSON.stringify(out.tall));
  }

  if (failures.length) {
    console.error(`popover-dropdown: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`popover-dropdown: ${checked} passed  [real layout, real press]`);
})();
