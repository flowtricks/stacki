// The app UI kit's confirm asks inside the app, in a real browser.
//
//   node test/renderer/apps/appUiKitConfirm.test.js
//
// Goal: an app never needs the browser's alert(), confirm() or prompt().
// `stackiConfirm(options)` and `<stacki-confirm>.ask()` open Stacki's own
// question and resolve true only for the confirm button (or Return on it);
// Cancel, Escape and a click outside resolve false. A question with no anchor is
// the editor's modal, centred in the frame; with an anchor it is a popover beside
// that control. A danger question draws its confirm button in the danger token's
// red and starts on Cancel, so a stray Return cannot confirm it; any other
// question starts on its confirm button. Tab stays on the two buttons, focus
// returns to the control that asked, and the surface is a fill with no border.
// Malformed options throw at the app's own call.
//
// Method: one page in Electron's Chromium, built from the shared module's
// `ui.css` and `ui.js` exactly as an app serves them. Each scenario opens a
// question from page script, answers it the way a person would (a real Return
// key press, a click, an Escape key event, a press on the backdrop), and reports
// the answer, the focus and the computed styles as JSON, which the test checks.
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
    console.log('app-ui-kit-confirm: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const kit = load('shared/properties/appUiKit.ts');
  const pageDirectory = repoPath('node_modules/.stacki-test/app-ui-kit-confirm');
  fs.mkdirSync(pageDirectory, { recursive: true });
  fs.writeFileSync(path.join(pageDirectory, 'ui.css'), kit.appHostAsset('__stacki/ui.css').body);
  fs.writeFileSync(path.join(pageDirectory, 'ui.js'), kit.appHostAsset('__stacki/ui.js').body);
  const app = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><script src="ui.js"></script></head>
    <body style="margin:0;width:400px">
    <button id="opener">Delete</button>
    <div style="padding:40px"><stacki-button id="anchor" variant="ghost" icon="trash" aria-label="Delete pin"></stacki-button></div>
    <stacki-confirm id="element" title="Discard changes?" tone="danger" confirm-label="Discard">Your edits to this pin are lost.</stacki-confirm>
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
     // The most any one wait may take. A wait ends on the event it names; this only bounds a hang.
     const BOUND_MS = 5000;
     // Polls a condition inside the page, within BOUND_MS. It returns whether the condition held, so
     // the checks that follow report the real state instead of a timeout.
     const PAGE_WAITS = \`
       const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
       const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
       const until = async (condition) => {
         for (let waited = 0; waited < \${BOUND_MS}; waited += 10) {
           if (condition()) { return true; }
           await pause(10);
         }
         return condition();
       };
       // Every opening or closing motion finished, and the frame after it painted.
       const calm = async () => {
         await frames();
         await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
         await frames();
       };
     \`;
     // Opens a question from the opener and records what shows.
     const open = (call) => \`(async () => { try {
       \${PAGE_WAITS}
       const opener = document.getElementById('opener');
       opener.focus();
       window.answer = 'pending';
       const asked = \${call};
       asked.then((value) => { window.answer = value; }, (error) => { window.answer = 'rejected: ' + String(error); });
       // Shown, with focus moved into it (a question the page hides never gets there), then at rest.
       await until(() => document.querySelector('.stacki-kit-confirm') !== null);
       await until(() => { const shown = document.querySelector('.stacki-kit-confirm'); return shown !== null && shown.contains(document.activeElement); });
       await calm();
       const surface = document.querySelector('.stacki-kit-confirm');
       const buttons = surface ? [...surface.querySelectorAll('.stacki-kit-confirm-actions button')] : [];
       const confirm = buttons[1];
       const style = surface ? getComputedStyle(surface) : undefined;
       const swatch = document.createElement('div');
       swatch.style.background = 'var(--stacki-danger)';
       document.body.appendChild(swatch);
       const danger = getComputedStyle(swatch).backgroundColor;
       swatch.style.background = 'var(--stacki-accent)';
       const accent = getComputedStyle(swatch).backgroundColor;
       swatch.remove();
       const dialog = surface ? surface.closest('dialog') : null;
       return {
         shown: Boolean(surface),
         modal: Boolean(dialog && dialog.open),
         role: dialog ? dialog.getAttribute('role') : surface && surface.getAttribute('role'),
         anchored: Boolean(surface && surface.classList.contains('stacki-kit-confirm-anchored')),
         heading: (surface && surface.querySelector('.stacki-kit-confirm-heading') || {}).textContent,
         message: (surface && surface.querySelector('.stacki-kit-confirm-message') || {}).textContent,
         labels: buttons.map((button) => button.textContent),
         focused: document.activeElement ? document.activeElement.textContent : '',
         confirmFill: confirm ? getComputedStyle(confirm).backgroundColor : '',
         danger,
         accent,
         fill: style ? style.backgroundColor : '',
         border: style ? style.borderTopWidth : '',
         box: surface ? surface.getBoundingClientRect().toJSON() : undefined,
         anchorBox: document.getElementById('anchor').getBoundingClientRect().toJSON(),
       };
     } catch (error) { return { failed: String(error && error.stack || error) }; } })()\`;
     const after = \`(async () => {
       \${PAGE_WAITS}
       // Answered and gone: the exit motion keeps the surface mounted until it ends.
       await until(() => document.querySelector('.stacki-kit-confirm') === null && window.answer !== 'pending');
       await calm();
       const focused = document.activeElement;
       return {
         answer: window.answer,
         gone: document.querySelector('.stacki-kit-confirm') === null,
         focusedOpener: focused === document.getElementById('opener'),
         focusedAnchor: focused === document.querySelector('#anchor button'),
         helperElementsLeft: document.querySelectorAll('stacki-confirm').length,
       };
     })()\`;
     app.whenReady().then(async () => {
       try {
         const win = new BrowserWindow({ show: false, width: 400, height: 500, webPreferences: { backgroundThrottling: false } });
         await win.loadFile(path.join(__dirname, 'app.html'));
         const js = (code) => win.webContents.executeJavaScript(code);
         for (let waited = 0; waited < BOUND_MS && (await js("typeof window.stackiConfirm")) !== 'function'; waited += 10) {
           await wait(10);
         }
         // Return, as the keyboard sends it: a button acts on the character event, not the key down.
         const pressReturn = () => {
           win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
           win.webContents.sendInputEvent({ type: 'char', keyCode: '\\r' });
           win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
         };
         const results = {};
         results.native = await js(\`({ alert: typeof window.alert, helper: typeof window.stackiConfirm })\`);

         // Return on the starting button confirms a default question; Tab stays on the two buttons.
         results.enterOpen = await js(open("stackiConfirm({ title: 'Save the pin?', message: 'It shows to everyone.', confirmLabel: 'Save' })"));
         results.tabs = await js(\`(() => {
           const seen = [];
           for (const shiftKey of [false, false, true, false]) {
             document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
             seen.push(document.activeElement.textContent);
           }
           return seen;
         })()\`);
         pressReturn();
         results.enter = await js(after);

         // Cancel answers no.
         results.cancelOpen = await js(open("stackiConfirm({ message: 'Leave without saving?' })"));
         await js(\`document.querySelector('.stacki-kit-confirm-actions button').click()\`);
         results.cancel = await js(after);

         // Escape answers no.
         await js(open("stackiConfirm({ title: 'Archive?' })"));
         await js(\`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))\`);
         results.escape = await js(after);

         // A press on the backdrop, outside the question, answers no.
         await js(open("stackiConfirm({ title: 'Archive?' })"));
         await js(\`(() => {
           const dialog = document.querySelector('.stacki-kit-confirm').closest('dialog');
           for (const kind of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
             dialog.dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true }));
           }
         })()\`);
         results.outside = await js(after);

         // A danger question: red, and it starts on Cancel, so Return answers no.
         results.dangerOpen = await js(open("stackiConfirm({ title: 'Delete pin?', confirmLabel: 'Delete', tone: 'danger' })"));
         pressReturn();
         results.dangerEnter = await js(after);

         // Anchored: a popover beside the control, and focus goes back to that control's button.
         results.anchoredOpen = await js(open("stackiConfirm({ title: 'Delete pin?', tone: 'danger', confirmLabel: 'Delete', anchor: document.getElementById('anchor') })"));
         await js(\`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))\`);
         results.anchored = await js(after);
         await js(open("stackiConfirm({ title: 'Delete pin?', anchor: document.getElementById('anchor') })"));
         await js(\`document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))\`);
         results.anchoredOutside = await js(after);

         // The element itself: ask() resolves, open reflects, close fires with the answer.
         await js(\`(() => {
           window.closes = [];
           document.getElementById('element').addEventListener('close', (event) => window.closes.push(event.detail.confirmed));
         })()\`);
         results.elementOpen = await js(open("document.getElementById('element').ask()"));
         results.elementWhileOpen = await js(\`({ open: document.getElementById('element').open, attribute: document.getElementById('element').hasAttribute('open') })\`);
         await js(\`[...document.querySelectorAll('.stacki-kit-confirm-actions button')][1].click()\`);
         results.element = await js(after);
         results.elementAfter = await js(\`({ open: document.getElementById('element').open, closes: window.closes, kept: document.getElementById('element').isConnected })\`);

         // Malformed options throw at the call.
         results.refused = await js(\`(() => {
           const seen = [];
           for (const bad of [undefined, 'Delete?', { title: 3 }, { tone: 'loud' }, { anchor: 'button' }, { message: 'x'.repeat(2001) }]) {
             try { stackiConfirm(bad); seen.push('accepted'); } catch (error) { seen.push(error.name); }
           }
           return seen;
         })()\`);
         win.destroy();
         console.log(JSON.stringify(results));
       } catch (error) {
         console.error('probe failed: ' + String(error && error.stack || error));
       }
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const results = JSON.parse(line);
    const seen = (value) => JSON.stringify(value);
    for (const [name, value] of Object.entries(results)) {
      if (value && typeof value === 'object' && 'failed' in value) {
        check(`${name}: the page script ran`, false, value.failed);
      }
    }
    check('ui.js gives apps stackiConfirm', results.native.helper === 'function', seen(results.native));

    const { enterOpen, tabs, enter } = results;
    check('a question with no anchor opens as a modal', enterOpen.shown && enterOpen.modal && !enterOpen.anchored, seen(enterOpen));
    check('as an alertdialog', enterOpen.role === 'alertdialog', seen(enterOpen));
    check('with its title and message', enterOpen.heading === 'Save the pin?' && enterOpen.message === 'It shows to everyone.', seen(enterOpen));
    check('Cancel first, the confirm label last', seen(enterOpen.labels) === '["Cancel","Save"]', seen(enterOpen));
    check('a default question starts on its confirm button', enterOpen.focused === 'Save', seen(enterOpen));
    check('in the accent', enterOpen.confirmFill === enterOpen.accent, seen(enterOpen));
    check('the surface is a popover fill', enterOpen.fill === 'rgb(35, 35, 35)', seen(enterOpen));
    check('with no border', enterOpen.border === '0px', seen(enterOpen));
    check('Tab moves between the two buttons and stays in the question', seen(tabs) === '["Cancel","Save","Cancel","Save"]', seen(tabs));
    check('Return on the confirm button answers yes', enter.answer === true && enter.gone, seen(enter));
    check('focus returns to the control that asked', enter.focusedOpener === true, seen(enter));
    check("the helper's element leaves with its answer", enter.helperElementsLeft === 1, seen(enter));

    check("the confirm label defaults to the editor's", seen(results.cancelOpen.labels) === '["Cancel","Continue"]', seen(results.cancelOpen));
    check('Cancel answers no', results.cancel.answer === false && results.cancel.gone && results.cancel.focusedOpener, seen(results.cancel));
    check('Escape answers no', results.escape.answer === false && results.escape.gone && results.escape.focusedOpener, seen(results.escape));
    check('a click outside answers no', results.outside.answer === false && results.outside.gone, seen(results.outside));

    const { dangerOpen, dangerEnter } = results;
    check(
      'a danger question draws its confirm button in the danger red',
      dangerOpen.confirmFill === dangerOpen.danger && dangerOpen.danger !== dangerOpen.accent,
      seen(dangerOpen),
    );
    check('and starts on Cancel', dangerOpen.focused === 'Cancel', seen(dangerOpen));
    check('so Return answers no', dangerEnter.answer === false && dangerEnter.focusedOpener, seen(dangerEnter));

    const { anchoredOpen, anchored, anchoredOutside } = results;
    check('an anchored question is a popover, not a modal', anchoredOpen.shown && anchoredOpen.anchored && !anchoredOpen.modal, seen(anchoredOpen));
    check('as an alertdialog', anchoredOpen.role === 'alertdialog', seen(anchoredOpen));
    check(
      'placed beside its anchor',
      anchoredOpen.box &&
        (Math.abs(anchoredOpen.box.top - anchoredOpen.anchorBox.bottom) < 16 || Math.abs(anchoredOpen.box.bottom - anchoredOpen.anchorBox.top) < 16),
      seen(anchoredOpen),
    );
    check('and inside the window', anchoredOpen.box && anchoredOpen.box.left >= 0 && anchoredOpen.box.right <= 400, seen(anchoredOpen));
    check('Escape answers no and focus returns to the anchor', anchored.answer === false && anchored.gone && anchored.focusedAnchor, seen(anchored));
    check('a press outside the popover answers no', anchoredOutside.answer === false && anchoredOutside.gone, seen(anchoredOutside));

    check(
      'the element shows its own title, message and labels',
      results.elementOpen.heading === 'Discard changes?' &&
        results.elementOpen.message === 'Your edits to this pin are lost.' &&
        seen(results.elementOpen.labels) === '["Cancel","Discard"]',
      seen(results.elementOpen),
    );
    check('open reflects a question being asked', results.elementWhileOpen.open && results.elementWhileOpen.attribute, seen(results.elementWhileOpen));
    check('ask() resolves true for the confirm button', results.element.answer === true, seen(results.element));
    check(
      'close fires with the answer, and the element stays',
      results.elementAfter.open === false && seen(results.elementAfter.closes) === '[true]' && results.elementAfter.kept,
      seen(results.elementAfter),
    );
    check(
      'malformed options throw',
      seen(results.refused) === '["TypeError","TypeError","TypeError","TypeError","TypeError","RangeError"]',
      seen(results.refused),
    );
  }
  if (failures.length) {
    console.error(`app-ui-kit-confirm: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`app-ui-kit-confirm: ${checked} passed  [real Chromium, the kit's confirm]`);
})();
