// The app UI kit's dropdown tells the app which option is highlighted, in a real browser.
//
//   node test/renderer/apps/appUiKitDropdownHighlight.test.js
//
// Goal: an app can preview an option before it is chosen (Feedback pins
// previews each "Pin to" target on the canvas). While the menu is open,
// `<stacki-dropdown>` fires `highlight` with `detail: { value }` whenever the
// row under the pointer or the arrow keys changes, once per change, never once
// per mouse move; it fires `detail: { value: undefined }` when the pointer leaves
// the rows, when the highlighted row is disabled, and when the menu closes.
// Opening the menu, and closing one nothing was highlighted in, fire nothing.
// The value never changes and no `change` fires.
//
// Method: one page in Electron's Chromium, built from the shared module's
// `ui.css` and `ui.js` exactly as an app serves them, driven with real mouse
// moves and key presses (sendInputEvent), with focus on the trigger as a click leaves it. The document records every
// `highlight` it hears, which the test checks in order.
const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const load = require('../../helpers/rendererModule');

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
    console.log('app-ui-kit-dropdown-highlight: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const kit = load('shared/properties/appUiKit.ts');
  const pageDirectory = repoPath('node_modules/.stacki-test/app-ui-kit-dropdown-highlight');
  fs.mkdirSync(pageDirectory, { recursive: true });
  fs.writeFileSync(path.join(pageDirectory, 'ui.css'), kit.appHostAsset('__stacki/ui.css').body);
  fs.writeFileSync(path.join(pageDirectory, 'ui.js'), kit.appHostAsset('__stacki/ui.js').body);
  const app = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><script src="ui.js"></script></head>
    <body style="margin:0;width:320px;padding:8px">
    <stacki-dropdown id="target" value="page" label="Pin to">
      <option value="page">Page</option>
      <option value="hero">Hero</option>
      <option value="locked" disabled>Locked</option>
    </stacki-dropdown>
    <script>
      window.heard = [];
      window.changes = 0;
      document.addEventListener('highlight', (event) => window.heard.push(event.detail.value === undefined ? '(none)' : event.detail.value));
      document.getElementById('target').addEventListener('change', () => { window.changes += 1; });
    </script>
    </body></html>`;
  fs.writeFileSync(
    path.join(pageDirectory, 'app.html'),
    new TextDecoder().decode(kit.withAppTokens({ bytes: new TextEncoder().encode(app), type: 'text/html' })),
  );

  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.on('window-all-closed', () => {});
     const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
     // After the menu's opening or closing motion.
     const SETTLE_MS = 400;
     app.whenReady().then(async () => {
       try {
         const win = new BrowserWindow({ show: false, width: 400, height: 500 });
         await win.loadFile(path.join(__dirname, 'app.html'));
         await wait(SETTLE_MS);
         const js = (code) => win.webContents.executeJavaScript(code);
         const move = async (x, y) => {
           win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
           await wait(60);
         };
         const key = async (keyCode) => {
           win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
           win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
           await wait(60);
         };
         const heard = () => js('window.heard.slice()');
         const result = {};
         await js("(() => { const trigger = document.querySelector('#target .dd-trigger'); trigger.focus(); trigger.click(); })()");
         await wait(SETTLE_MS);
         result.onOpen = await heard();
         const rows = await js("[...document.querySelectorAll('.dd-popup .dd-option')].map((row) => { const box = row.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })");
         result.rows = rows.length;
         // Hover: two moves inside one row are one change; the next row is another.
         await move(rows[0].x, rows[0].y);
         await move(rows[0].x + 3, rows[0].y + 1);
         await move(rows[0].x - 3, rows[0].y - 1);
         await move(rows[1].x, rows[1].y);
         result.hover = await heard();
         // Leaving the rows clears it; a disabled row is no highlight either.
         await move(390, 490);
         result.leave = await heard();
         await move(rows[2].x, rows[2].y);
         result.disabled = await heard();
         // Keys move the highlight up from the disabled row.
         await key('Up');
         await key('Up');
         result.keys = await heard();
         // Closing clears it.
         await key('Escape');
         await wait(SETTLE_MS);
         result.closed = await heard();
         // A menu opened and closed with nothing highlighted tells nothing.
         await js("(() => { const trigger = document.querySelector('#target .dd-trigger'); trigger.focus(); trigger.click(); })()");
         await wait(SETTLE_MS);
         await key('Escape');
         await wait(SETTLE_MS);
         result.quiet = await heard();
         result.state = await js("({ value: document.getElementById('target').value, changes: window.changes })");
         win.destroy();
         console.log(JSON.stringify(result));
       } catch (error) {
         console.error('probe failed: ' + String(error && error.stack || error));
       }
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  // GitHub's Linux runner (xvfb) delivers no pointer or key input to a hidden window and
  // never ticks its animations, so this probe can only fail there. Windows' hidden window drops the same input (1.1.7), so only macOS runs it.
  if (process.platform !== 'darwin') {
    console.log('skipped off macOS: input and motion need a shown window');
    return;
  }
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const result = JSON.parse(line);
    const seen = JSON.stringify(result);
    const is = (list, expected) => JSON.stringify(list) === JSON.stringify(expected);
    check('the menu opens with its three rows', result.rows === 3, seen);
    check('opening the menu fires nothing', is(result.onOpen, []), seen);
    check('hovering fires once per row, not per mouse move', is(result.hover, ['page', 'hero']), seen);
    check('leaving the rows fires undefined', is(result.leave, ['page', 'hero', '(none)']), seen);
    check('a disabled row is no highlight, and nothing repeats', is(result.disabled, ['page', 'hero', '(none)']), seen);
    check('arrow keys fire each row they reach', is(result.keys, ['page', 'hero', '(none)', 'hero', 'page']), seen);
    check('closing the menu fires undefined', is(result.closed, ['page', 'hero', '(none)', 'hero', 'page', '(none)']), seen);
    check('a menu closed with nothing highlighted fires nothing', is(result.quiet, result.closed), seen);
    check('highlighting never changes the value', result.state.value === 'page' && result.state.changes === 0, seen);
  }
  if (failures.length) {
    console.error(`app-ui-kit-dropdown-highlight: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`app-ui-kit-dropdown-highlight: ${checked} passed  [real Chromium, real pointer and keys]`);
})();
