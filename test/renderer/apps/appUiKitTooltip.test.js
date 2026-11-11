// The app UI kit's tooltip never outlives the hover that opened it, in a real browser.
//
//   node test/renderer/apps/appUiKitTooltip.test.js
//
// Goal: a `<stacki-tooltip>` in a list the app re-renders cannot get stuck
// open. Its popup goes when the element is removed while it shows, and on a
// press, a scroll or wheel, Escape, and a change to the element's text; only one
// kit tooltip shows at a time; and after a dismissal the next hover opens it again.
//
// Method: one page in Electron's Chromium, built from the shared module's
// `ui.css` and `ui.js` exactly as an app serves them. The pointer is real
// (sendInputEvent mouse moves, presses and wheel turns); removal, a text change
// and a second hover without leaving the first are page script, as an app's
// re-render would do them. After each step the page reports how many tooltip
// popups are in the document, which the test checks.
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
    console.log('app-ui-kit-tooltip: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const kit = load('shared/properties/appUiKit.ts');
  const pageDirectory = repoPath('node_modules/.stacki-test/app-ui-kit-tooltip');
  fs.mkdirSync(pageDirectory, { recursive: true });
  fs.writeFileSync(path.join(pageDirectory, 'ui.css'), kit.appHostAsset('__stacki/ui.css').body);
  fs.writeFileSync(path.join(pageDirectory, 'ui.js'), kit.appHostAsset('__stacki/ui.js').body);
  const rows = Array.from(
    { length: 30 },
    (_, index) => `<li style="height:24px"><stacki-tooltip id="t${index}" text="Row ${index} has a long name"></stacki-tooltip></li>`,
  ).join('');
  const app = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><script src="ui.js"></script></head>
    <body style="margin:0;width:320px">
    <ul id="list" style="margin:0;padding:0 8px;list-style:none;height:300px;overflow:auto">${rows}</ul>
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
     app.whenReady().then(async () => {
       try {
         const win = new BrowserWindow({ show: false, width: 400, height: 500 });
         await win.loadFile(path.join(__dirname, 'app.html'));
         await wait(400);
         const js = (code) => win.webContents.executeJavaScript(code);
         const shown = () => js("document.querySelectorAll('.popup-tooltip').length");
         const centre = (id) => js(\`(() => { const box = document.querySelector('#\${id} .stacki-kit-mount > span').getBoundingClientRect(); return { x: Math.round(box.left + 10), y: Math.round(box.top + box.height / 2) }; })()\`);
         const away = async () => {
           win.webContents.sendInputEvent({ type: 'mouseMove', x: 390, y: 480 });
           await wait(250); // Past the exit motion of a tooltip closed by leaving.
         };
         const hover = async (id) => {
           const point = await centre(id);
           win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
           await wait(100);
           return point;
         };
         const result = {};

         await hover('t0');
         result.hovered = await shown();
         await js("document.getElementById('t0').remove()");
         await wait(100);
         result.removed = await shown();
         await away();

         const point = await hover('t1');
         result.beforePress = await shown();
         win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
         win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
         await wait(100);
         result.pressed = await shown();
         await away();

         const wheelAt = await hover('t2');
         result.beforeWheel = await shown();
         win.webContents.sendInputEvent({ type: 'mouseWheel', x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: -60 });
         await wait(150);
         result.wheeled = await shown();
         await away();

         await hover('t3');
         result.beforeScroll = await shown();
         await js("document.getElementById('list').scrollTop += 40");
         await wait(150);
         result.scrolled = await shown();
         await away();

         await hover('t4');
         result.beforeEscape = await shown();
         win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
         win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
         await wait(100);
         result.escaped = await shown();
         await away();

         await hover('t5');
         result.beforeText = await shown();
         await js("document.getElementById('t5').setAttribute('text', 'Row 5, renamed')");
         await wait(100);
         result.retexted = await shown();
         await away();

         // A second tooltip hovered while the first still shows (a row slid under the pointer).
         await hover('t6');
         result.first = await js("document.querySelector('.popup-tooltip') && document.querySelector('.popup-tooltip').textContent");
         await js("document.querySelector('#t7 .stacki-kit-mount > span').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))");
         await wait(100);
         result.second = await js("[...document.querySelectorAll('.popup-tooltip')].filter((popup) => popup.dataset.popupPhase !== 'closing').map((popup) => popup.textContent)");
         result.secondCount = await shown();
         await away();

         // A dismissed tooltip opens again on the next hover.
         await hover('t1');
         result.again = await shown();
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
  // never ticks its animations, so this probe can only fail there; macOS and Windows run it.
  if (process.platform === 'linux') {
    console.log('skipped on Linux: input and motion need a shown window');
    return;
  }
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const result = JSON.parse(line);
    const seen = JSON.stringify(result);
    check('hovering a tooltip shows its popup', result.hovered === 1, seen);
    check('removing the element while it shows leaves no popup', result.removed === 0, seen);
    check('a press hides it', result.beforePress === 1 && result.pressed === 0, seen);
    check('a wheel turn hides it', result.beforeWheel === 1 && result.wheeled === 0, seen);
    check('a scroll hides it', result.beforeScroll === 1 && result.scrolled === 0, seen);
    check('Escape hides it', result.beforeEscape === 1 && result.escaped === 0, seen);
    check("a change to the element's text hides it", result.beforeText === 1 && result.retexted === 0, seen);
    check(
      'only one kit tooltip shows at a time',
      result.first === 'Row 6 has a long name' && JSON.stringify(result.second) === '["Row 7 has a long name"]' && result.secondCount === 1,
      seen,
    );
    check('a dismissed tooltip opens again on the next hover', result.again === 1, seen);
  }
  if (failures.length) {
    console.error(`app-ui-kit-tooltip: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`app-ui-kit-tooltip: ${checked} passed  [real Chromium, real pointer]`);
})();
