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
// popups are in the document, which the test checks; each read waits, bounded,
// for the count the step expects (test/helpers/waitFor.js) and keeps the last
// count it saw, so a slow runner gets time and a real failure still shows.
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
     const { pollUntil: pollUntilShared } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     // Every wait that ran out is kept for the failure report: which step the page never reached.
     const timedOut = [];
     const pollUntil = async (options) => {
       const outcome = await pollUntilShared(options);
       if (outcome.kind === 'timedOut') {
         timedOut.push(options.what + ': ' + JSON.stringify(outcome.value));
       }
       return outcome;
     };
     app.whenReady().then(async () => {
       try {
         const win = new BrowserWindow({ show: false, width: 400, height: 500 });
         await win.loadFile(path.join(__dirname, 'app.html'));
         const js = (code) => win.webContents.executeJavaScript(code);
         const shown = () => js("document.querySelectorAll('.popup-tooltip').length");
         const centre = (id) => js(\`(() => { const target = document.querySelector('#\${id} .stacki-kit-mount > span'); if (!target) { return undefined; } const box = target.getBoundingClientRect(); return { x: Math.round(box.left + 10), y: Math.round(box.top + box.height / 2) }; })()\`);
         // Every read waits, bounded, until the popup count is what the step expects
         // (test/helpers/waitFor.js), never a fixed sleep: a slow runner delivers the move,
         // press or key, and finishes the exit motion, later than any sleep guesses. The last
         // count is returned either way, so a real failure still reports what the page held.
         const shownBecomes = async (wanted) => (await pollUntil({ what: wanted + ' tooltip popups', read: shown, until: (count) => count === wanted })).value;
         // The pointer's arrival is observable as :hover; waiting on it (not on a sleep) keeps a
         // later move from being coalesced with this one into a single jump on a slow frame.
         const hoverIn = (selector) => js(\`document.querySelector(\${JSON.stringify(selector)}) !== null\`);
         const pointerOff = async () => {
           win.webContents.sendInputEvent({ type: 'mouseMove', x: 390, y: 480 });
           await pollUntil({ what: 'the pointer off the list', read: () => hoverIn('#list:hover'), until: (inside) => inside === false });
         };
         const away = async () => {
           await pointerOff();
           await shownBecomes(0); // Past the exit motion of a tooltip closed by leaving.
         };
         const hover = async (id) => {
           const located = await pollUntil({ what: id + ' laid out', read: () => centre(id), until: (point) => point !== undefined });
           const point = located.value ?? { x: 0, y: 0 };
           win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
           await pollUntil({ what: 'the pointer on ' + id, read: () => hoverIn('#' + id + ' :hover'), until: (inside) => inside === true });
           return point;
         };
         const result = {};
         // The page events that dismiss a kit tooltip, logged for the failure report.
         await js("window.__dismissals = []; for (const kind of ['pointerdown', 'click', 'scroll', 'wheel', 'keydown', 'visibilitychange']) { document.addEventListener(kind, (event) => { if (window.__dismissals.length < 40) { window.__dismissals.push(kind + ':' + (event.target.id || event.target.nodeName)); } }, true); } window.addEventListener('blur', () => window.__dismissals.push('blur')); true");

         await hover('t0');
         result.hovered = await shownBecomes(1);
         await js("document.getElementById('t0').remove()");
         result.removed = await shownBecomes(0);
         await away();

         const point = await hover('t1');
         result.beforePress = await shownBecomes(1);
         win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
         win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
         result.pressed = await shownBecomes(0);
         await away();

         const wheelAt = await hover('t2');
         result.beforeWheel = await shownBecomes(1);
         // The wheel scrolls the list smoothly, over frames after the event, and each of those
         // scroll events would dismiss a later step's tooltip. Two equal reads of scrollTop are
         // not proof it ended (a starved runner may run no frame between them), so the step waits
         // for the list's own scrollend event, which fires once the smooth scroll has finished.
         await js("window.__scrollEnds = 0; document.getElementById('list').addEventListener('scrollend', () => { window.__scrollEnds += 1; }); true");
         win.webContents.sendInputEvent({ type: 'mouseWheel', x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: -60 });
         result.wheeled = await shownBecomes(0);
         await pollUntil({ what: 'the wheel scroll ended', read: () => js('window.__scrollEnds'), until: (count) => count > 0 });
         await away();

         await hover('t3');
         result.beforeScroll = await shownBecomes(1);
         await js("document.getElementById('list').scrollTop += 40");
         result.scrolled = await shownBecomes(0);
         await away();

         await hover('t4');
         result.beforeEscape = await shownBecomes(1);
         // Keys go to the focused page; a hidden window is not focused by itself.
         win.webContents.focus();
         win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
         win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
         result.escaped = await shownBecomes(0);
         await away();

         await hover('t5');
         result.beforeText = await shownBecomes(1);
         await js("document.getElementById('t5').setAttribute('text', 'Row 5, renamed')");
         result.retexted = await shownBecomes(0);
         await away();

         // A second tooltip hovered while the first still shows (a row slid under the pointer).
         // Both hovers are page script with the real pointer parked off the list: with the pointer
         // left on t6, t7 closed with no dismissing event in 2 of 15 stressed runs, as when the page
         // hears the real pointer reach t6 again after the popups change the page; the kit is right
         // to close t7 then, so the real pointer is kept out of this check.
         const scriptHover = (id) => js(\`document.querySelector('#\${id} .stacki-kit-mount > span').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))\`);
         await scriptHover('t6');
         await shownBecomes(1);
         result.first = await js("document.querySelector('.popup-tooltip') && document.querySelector('.popup-tooltip').textContent");
         await scriptHover('t7');
         const openTexts = "[...document.querySelectorAll('.popup-tooltip')].filter((popup) => popup.dataset.popupPhase !== 'closing').map((popup) => popup.textContent)";
         result.second = (await pollUntil({ what: 'the second tooltip open', read: () => js(openTexts), until: (texts) => texts.includes('Row 7 has a long name') })).value;
         // The first one's exit motion ends, leaving the second alone.
         result.secondCount = await shownBecomes(1);
         result.popupsAfterSecond = await js("[...document.querySelectorAll('.popup-tooltip')].map((popup) => popup.textContent + '/' + popup.dataset.popupPhase)");
         // The pointer never entered t7 (its hover was page script), so leaving cannot close it;
         // the scroll below does.

         // A dismissed tooltip opens again on the next hover. The wheel and the scroll above
         // moved t1 out of the list's view, so it is scrolled back first (that scroll also
         // dismisses t7), and only a popup with t1's own text counts as it opening again.
         await js("document.getElementById('t1').scrollIntoView({ block: 'nearest' })");
         await shownBecomes(0);
         await hover('t1');
         const popupsOfFirstRow = "[...document.querySelectorAll('.popup-tooltip')].filter((popup) => popup.textContent === 'Row 1 has a long name').length";
         result.again = (await pollUntil({ what: "t1's popup open again", read: () => js(popupsOfFirstRow), until: (count) => count === 1 })).value;
         result.timedOut = timedOut;
         result.dismissals = await js('window.__dismissals');
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
