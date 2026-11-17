// The app UI kit's elements read their content whenever it changes, in a real browser.
//
//   node test/renderer/apps/appUiKitElements.test.js
//
// Goal: an app that loads `__stacki/ui.js` as a plain script in `<head>` (no
// `defer`), as the guide's example does, gets every element right: a button and
// a reset label show the text the parser writes after the element is defined;
// refilling a button (`textContent`) or a dropdown (`replaceChildren`) keeps the
// rendered control and shows the new content; a dropdown takes its options as
// data through the `options` property, refuses a malformed list, and goes back
// to its children when it is cleared; a switch with a `label` shows it beside
// the switch as the editor's switch rows do, a click on the label toggles it,
// and `label-hidden` keeps the label to the accessible name; and a search fires
// `input` and then `change` exactly once for each change of its value, the
// clearing Escape included.
//
// Method: one page in Electron's Chromium, built from the shared module's
// `ui.css` and `ui.js` exactly as an app serves them, driven with real key
// presses where the browser's own behaviour matters (typing, Escape clearing a
// search field). An icon button is named by its aria-label and shows only its
// icon; a menu opens the editor's menu with icons first and checks last, and
// choosing a row fires `select`. A `pressed` button is a toggle in the
// editor's pressed fill. A menu opened from a button at the right edge stays in
// the window, right-aligned, with headings, separators and shortcut hints, from
// children or the `items` property. A popover shows the element's own content
// in the editor's popover and puts the same nodes back when it closes. The page reports what it saw as JSON, which the test checks.
// Each read waits, bounded, for the state it reads (test/helpers/waitFor.js in the probe, a
// bounded poll in the page), never a fixed pause.
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
    console.log('app-ui-kit-elements: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const kit = load('shared/properties/appUiKit.ts');
  const pageDirectory = repoPath('node_modules/.stacki-test/app-ui-kit-elements');
  fs.mkdirSync(pageDirectory, { recursive: true });
  fs.writeFileSync(path.join(pageDirectory, 'ui.css'), kit.appHostAsset('__stacki/ui.css').body);
  fs.writeFileSync(path.join(pageDirectory, 'ui.js'), kit.appHostAsset('__stacki/ui.js').body);
  // The guide's order: the kit in <head>, without defer, before any element exists.
  const app = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><script src="ui.js"></script></head>
    <body style="margin:0;width:320px">
    <stacki-button id="button" variant="primary">Add pin</stacki-button>
    <stacki-reset-label id="reset" active>Opacity</stacki-reset-label>
    <stacki-dropdown id="dropdown" value="two"><option value="one">One</option><option value="two">Two</option></stacki-dropdown>
    <stacki-switch id="labelled" label="Show pins" checked></stacki-switch>
    <stacki-switch id="hidden" label="Quiet" label-hidden></stacki-switch>
    <stacki-search id="search" label="Find"></stacki-search>
    <stacki-button id="icon" icon="trash" aria-label="Delete pin"></stacki-button>
    <stacki-menu id="menu" label="Pin options"><button value="edit" icon="edit">Edit</button><button value="done" checked>Resolved</button><button value="delete" icon="trash" danger>Delete</button></stacki-menu>
    <stacki-button id="toggle" icon="filter" aria-label="Only mine" pressed="false"></stacki-button>
    <div style="display:flex;justify-content:flex-end"><stacki-menu id="right" label="Account"><header>Signed in as ada@example.test</header><button value="refresh" icon="refresh" shortcut="⌘R">Refresh data with a long label that runs on</button><hr><button value="out">Disconnect</button></stacki-menu></div>
    <stacki-popover id="popover" label="Filter" icon="filter"><label>Status <input id="status" value="open"></label></stacki-popover>
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
     const { pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     const atRest = \`(() => {
       const button = document.querySelector('#button button');
       const holder = document.querySelector('#button .stacki-kit-content');
       const reset = document.querySelector('#reset .prop-label');
       const row = document.querySelector('#labelled .ui-switch-row');
       const rowLabel = document.querySelector('#labelled .ui-switch-row-label');
       const hiddenSwitch = document.querySelector('#hidden .ui-switch');
       return {
         button: button && button.textContent,
         buttonShown: document.getElementById('button').innerText.trim(),
         holderDrawn: holder ? getComputedStyle(holder).display : 'missing',
         reset: reset && reset.textContent,
         resetShown: document.getElementById('reset').innerText.trim(),
         trigger: (document.querySelector('#dropdown .dd-trigger') || {}).textContent,
         rowLabel: rowLabel && rowLabel.textContent,
         rowLabelWidth: rowLabel ? Math.round(rowLabel.getBoundingClientRect().width) : 0,
         rowSwitchName: row && row.querySelector('.ui-switch').getAttribute('aria-label'),
         hiddenRow: Boolean(document.querySelector('#hidden .ui-switch-row')),
         hiddenName: hiddenSwitch && hiddenSwitch.getAttribute('aria-label'),
         iconName: (document.querySelector('#icon button') || { getAttribute: () => undefined }).getAttribute('aria-label'),
         iconGlyph: Boolean(document.querySelector('#icon button svg')),
         iconText: (document.querySelector('#icon button') || {}).textContent,
         menuButton: (document.querySelector('#menu button.stacki-kit-menu-button') || { getAttribute: () => undefined }).getAttribute('aria-label'),
       };
     })()\`;
     const refill = \`(async () => { try {
       const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
       // Waits, bounded (pollCountMax ticks of 50 ms), until read() gives a truthy value, and
       // returns the last value either way: a slow runner opens, closes and fades a popup
       // later than any fixed pause, and a real failure still reaches the checks below.
       const pollCountMax = 100;
       const until = async (read) => {
         let value = read();
         for (let poll = 0; poll < pollCountMax && !value; poll += 1) {
           await tick();
           value = read();
         }
         return value;
       };
       // The finite animations and transitions running now, finished or at a bound.
       const motionOver = () => Promise.race([
         Promise.all(document.getAnimations().filter((animation) => animation.effect && animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished)),
         new Promise((resolve) => setTimeout(resolve, 5000)),
       ]);
       const button = document.getElementById('button');
       button.textContent = 'Save';
       const dropdown = document.getElementById('dropdown');
       dropdown.replaceChildren(new Option('Three', 'three'), new Option('Four', 'four'));
       dropdown.value = 'four';
       await until(() => button.innerText.trim() === 'Save' && (dropdown.querySelector('.dd-trigger') || {}).textContent === 'Four');
       const afterRefill = {
         button: (button.querySelector('button') || {}).textContent,
         buttonShown: button.innerText.trim(),
         trigger: (dropdown.querySelector('.dd-trigger') || {}).textContent,
         options: dropdown.options.map((option) => option.value),
       };
       dropdown.options = ['red', { value: 'blue', label: 'Blue sky', group: 'Cool' }, { value: 'grey', disabled: true }];
       dropdown.value = 'blue';
       await until(() => ((dropdown.querySelector('.dd-trigger') || {}).textContent || '').includes('Blue'));
       const asData = {
         trigger: (dropdown.querySelector('.dd-trigger') || {}).textContent,
         options: dropdown.options,
       };
       const refused = [];
       for (const bad of ['red', [{}], [{ value: 3 }], [{ value: 'a', disabled: 'yes' }], Array.from({ length: 501 }, (_, i) => String(i))]) {
         try {
           dropdown.options = bad;
           refused.push('accepted');
         } catch (error) {
           refused.push(error.name);
         }
       }
       dropdown.options = undefined;
       dropdown.value = 'three';
       await until(() => ((dropdown.querySelector('.dd-trigger') || {}).textContent || '').includes('Three'));
       const backToChildren = {
         trigger: (dropdown.querySelector('.dd-trigger') || {}).textContent,
         options: dropdown.options.map((option) => option.value),
       };
       const labelled = document.getElementById('labelled');
       let toggles = 0;
       labelled.addEventListener('change', () => { toggles += 1; });
       labelled.querySelector('.ui-switch-row-label').click();
       await until(() => toggles > 0);
       const menu = document.getElementById('menu');
       let chosen = 'none';
       menu.addEventListener('select', (event) => { chosen = event.detail.value; });
       // Rows are always read fresh from the open menu, never kept across an await: on GitHub's
       // Linux runner (run 43678899895) the menu was gone by the time the highlight was read, so
       // the kept rows were detached (every computed style empty) and the press on one fired
       // nothing. The menu is reopened, at most menuOpenCountMax times, when it closed on its own,
       // and how often that happened is reported with the result.
       const menuOpenCountMax = 3;
       const menuRows = () => [...document.querySelectorAll('.stacki-kit-menu [role^="menuitem"]')];
       let menuOpens = 0;
       let spontaneousCloses = 0;
       const openMenu = async () => {
         while (menuRows().length !== 3 && menuOpens < menuOpenCountMax) {
           if (document.querySelector('.stacki-kit-menu') === null) {
             menuOpens += 1;
             menu.querySelector('.stacki-kit-menu-button').click();
           }
           await until(() => menuRows().length === 3);
         }
       };
       await openMenu();
       const firstRows = menuRows();
       const checkedRow = firstRows.find((row) => row.getAttribute('aria-checked') === 'true');
       const opened = {
         rows: firstRows.map((row) => row.textContent),
         roles: firstRows.map((row) => row.getAttribute('role')),
         checkLast: Boolean(checkedRow && checkedRow.lastElementChild.classList.contains('dd-check') && checkedRow.lastElementChild.querySelector('svg')),
         iconFirst: Boolean(firstRows[0] && firstRows[0].firstElementChild.classList.contains('dd-icon')),
       };
       let danger = { fill: '', text: '', icon: '', restText: '' };
       for (let attempt = 0; attempt < menuOpenCountMax; attempt += 1) {
         await openMenu();
         // The menu focuses its first row a frame after it opens; a hover before that focus lands
         // loses its highlight to it on a slow runner, so the hover waits for it (bounded).
         await until(() => menuRows()[0] !== undefined && document.activeElement === menuRows()[0]);
         const hovered = menuRows()[2];
         if (hovered === undefined) {
           break;
         }
         hovered.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
         // The highlight fades in: read its colours once the motion is over.
         await tick();
         await motionOver();
         if (!hovered.isConnected) {
           spontaneousCloses += 1;
           continue;
         }
         const dangerRow = getComputedStyle(hovered);
         danger = {
           fill: dangerRow.backgroundColor,
           text: dangerRow.color,
           icon: getComputedStyle(hovered.querySelector('.dd-icon')).color,
           restText: getComputedStyle(menuRows()[0]).color,
         };
         hovered.click();
         break;
       }
       await until(() => document.querySelector('.stacki-kit-menu') === null);
       const menuState = { opened, chosen, closed: document.querySelector('.stacki-kit-menu') === null, danger, menuOpens, spontaneousCloses };

       const toggle = document.getElementById('toggle');
       let toggleChanges = 0;
       toggle.addEventListener('change', () => { toggleChanges += 1; });
       const pressedBefore = toggle.querySelector('button').getAttribute('aria-pressed');
       toggle.querySelector('button').click();
       // The fill fades in; slowed motion outlasts any sleep, so wait for it, within a bound.
       await until(() => toggle.querySelector('button').getAttribute('aria-pressed') === 'true');
       await tick();
       await motionOver();
       const toggleButton = toggle.querySelector('button');
       const pressed = {
         before: pressedBefore,
         after: toggleButton.getAttribute('aria-pressed'),
         property: toggle.pressed,
         changes: toggleChanges,
         fill: getComputedStyle(toggleButton).backgroundColor,
       };

       const right = document.getElementById('right');
       right.querySelector('.stacki-kit-menu-button').click();
       const popup = await until(() => document.querySelector('.stacki-kit-menu'));
       // Measure after the opening motion, which scales the popup: a fixed sleep is too
       // short when the Linux preflight slows motion, so wait until the popup has left its
       // opening phase, no finite animation runs, and its box holds still across two reads
       // (two equal reads alone can mean a starved runner ran no frame between them).
       // Bounded so a popup that never settles still fails.
       let previous = '';
       const moving = () =>
         popup.closest('[data-popup-phase="opening"]') !== null ||
         document.getAnimations().some((animation) => animation.playState === 'running' && animation.effect !== null && animation.effect.getTiming().iterations !== Infinity);
       for (let attempt = 0; attempt < 50; attempt += 1) {
         const current = JSON.stringify(popup.getBoundingClientRect());
         if (current === previous && !moving()) {
           break;
         }
         previous = current;
         await new Promise((resolve) => setTimeout(resolve, 100));
       }
       const box = popup.getBoundingClientRect();
       const trigger = right.querySelector('.stacki-kit-menu-button').getBoundingClientRect();
       const aligned = {
         inside: box.left >= 0 && box.right <= window.innerWidth,
         rightEdge: Math.round(box.right) === Math.round(trigger.right),
         edges: [box.left, box.right, trigger.left, trigger.right, window.innerWidth],
         heading: (popup.querySelector('.dd-group-label') || {}).textContent,
         separators: popup.querySelectorAll('[role="separator"]').length,
         hint: (popup.querySelector('.dd-hint') || {}).textContent,
         hintBeforeCheck: Boolean(popup.querySelector('.dd-hint + .dd-check')),
         rows: popup.querySelectorAll('[role^="menuitem"]').length,
       };
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       // Escape closes a popup after its exit motion.
       await until(() => document.querySelector('.stacki-kit-menu') === null);
       right.items = [{ kind: 'heading', label: 'Data' }, { value: 'a', label: 'A', shortcut: '⌘A' }, { kind: 'separator' }, { value: 'b', label: 'B', checked: true }];
       right.querySelector('.stacki-kit-menu-button').click();
       await until(() => document.querySelectorAll('.stacki-kit-menu .dd-list > *').length === 4);
       const asItems = [...document.querySelectorAll('.stacki-kit-menu .dd-list > *')].map((row) => row.getAttribute('role') + ':' + row.textContent);
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       await until(() => document.querySelector('.stacki-kit-menu') === null);
       const badItems = [];
       for (const bad of [[{ kind: 'line' }], [{ value: 'a' }], [{ value: 'a', label: 'A', danger: 'yes' }]]) {
         try { right.items = bad; badItems.push('accepted'); } catch (error) { badItems.push(error.name); }
       }

       const popover = document.getElementById('popover');
       const opens = [];
       popover.addEventListener('toggle', (event) => opens.push(event.detail.open));
       const input = document.getElementById('status');
       input.dataset.mark = 'kept';
       const closedShown = input.getBoundingClientRect().width;
       popover.querySelector('button').click();
       await until(() => document.querySelector('.stacki-kit-popover') && input.getBoundingClientRect().width > 0);
       const panel = document.querySelector('.stacki-kit-popover');
       const openState = {
         open: popover.open,
         inPanel: Boolean(panel && panel.contains(input)),
         shown: input.getBoundingClientRect().width > 0,
         expanded: popover.querySelector('button').getAttribute('aria-expanded'),
       };
       document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       await until(() => document.querySelector('.stacki-kit-popover') === null);
       const closedState = {
         open: popover.open,
         back: popover.contains(document.getElementById('status')),
         same: document.getElementById('status').dataset.mark === 'kept',
         panelGone: document.querySelector('.stacki-kit-popover') === null,
       };
       const popoverState = { closedShown, openState, closedState, toggles: opens };
       return { afterRefill, asData, refused, backToChildren, toggled: { checked: labelled.checked, toggles }, menuState, pressed, aligned, asItems, badItems, popoverState };
     } catch (error) { return { failed: String(error && error.stack || error) }; } })()\`;
     app.whenReady().then(async () => {
       try {
         const win = new BrowserWindow({ show: false, width: 400, height: 500 });
         await win.loadFile(path.join(__dirname, 'app.html'));
         const js = (code) => win.webContents.executeJavaScript(code);
         // Every element drawn (bounded, test/helpers/waitFor.js), not a fixed pause after load.
         const rest = (await pollUntil({
           what: 'every kit element drawn',
           read: () => js(atRest),
           until: (seen) => typeof seen.button === 'string' && typeof seen.reset === 'string' && seen.trigger !== undefined && seen.iconName !== undefined && seen.menuButton !== undefined,
         })).value;
         // Clicks and focus inside the page behave as in a person's focused window, which a hidden
         // window on the Linux runner is not by itself.
         win.webContents.focus();
         const changes = await js(refill);
         await js(\`(() => {
           window.searchEvents = [];
           const search = document.getElementById('search');
           for (const kind of ['input', 'change']) {
             search.addEventListener(kind, () => window.searchEvents.push(kind + ':' + search.value));
           }
           search.querySelector('input').focus();
         })()\`);
         win.webContents.insertText('pin');
         const lastEvent = () => js('window.searchEvents[window.searchEvents.length - 1]');
         await pollUntil({ what: 'the typed change heard', read: lastEvent, until: (event) => event === 'change:pin' });
         // The gate runs several Electron suites at once on one virtual display (the Linux runner),
         // and another suite's window can take page focus between our focus() and the key: Blink then
         // drops the Escape (1.4.7: the events stopped at "change:pin"). So the page and the field are
         // focused again right before each press, and a press that was not heard is repeated, bounded.
         // A repeated Escape on a cleared field changes nothing, so it cannot add events.
         for (let press = 1; press <= 5; press += 1) {
           win.webContents.focus();
           await js("document.querySelector('#search input').focus()");
           win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
           win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
           const heard = await pollUntil({ what: 'the clearing change heard', read: lastEvent, until: (event) => event === 'change:', pollCountMax: 20 });
           if (heard.kind === 'reached') {
             break;
           }
         }
         const search = await js(\`({ events: window.searchEvents, value: document.getElementById('search').value, field: document.querySelector('#search input').value })\`);
         win.destroy();
         console.log(JSON.stringify({ rest, changes, search }));
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
    const { rest, changes, search } = JSON.parse(line);
    const seen = JSON.stringify(rest);
    check('a button defined before its text shows the text', rest.button === 'Add pin', seen);
    check('and draws it once', rest.buttonShown === 'Add pin', seen);
    check("the author's text is kept, undrawn", rest.holderDrawn === 'none', seen);
    check('a reset label defined before its text shows the text', rest.reset === 'Opacity', seen);
    check('and draws it once', rest.resetShown === 'Opacity', seen);
    check('a dropdown defined before its options shows the chosen one', (rest.trigger ?? '').includes('Two'), seen);
    check('a labelled switch shows its label beside it', rest.rowLabel === 'Show pins' && rest.rowLabelWidth > 0, seen);
    check('and keeps it as the accessible name', rest.rowSwitchName === 'Show pins', seen);
    check('label-hidden draws the switch alone', rest.hiddenRow === false, seen);
    check('with the label as its accessible name', rest.hiddenName === 'Quiet', seen);

    check('an icon button takes its name from aria-label', rest.iconName === 'Delete pin', seen);
    check('and shows the icon alone', rest.iconGlyph === true && rest.iconText === '', seen);
    check('a menu draws its ⋯ button with its label as the name', rest.menuButton === 'Pin options', seen);
    if (changes.failed !== undefined) {
      check('the page script ran', false, changes.failed);
    }
    const { afterRefill, asData, refused, backToChildren, toggled, menuState } = changes;
    const menuSeen = JSON.stringify(menuState);
    check('the menu opens with its rows', JSON.stringify(menuState.opened.rows) === '["Edit","Resolved","Delete"]', menuSeen);
    check('a checked row is a check row', JSON.stringify(menuState.opened.roles) === '["menuitem","menuitemcheckbox","menuitem"]', menuSeen);
    check('with its check at the end', menuState.opened.checkLast === true, menuSeen);
    check('and icons first', menuState.opened.iconFirst === true, menuSeen);
    check('choosing a row fires select with its value and closes', menuState.chosen === 'delete' && menuState.closed === true, menuSeen);
    check(
      "a highlighted danger row's fill, text and icon turn red together",
      menuState.danger.fill === 'rgba(255, 90, 90, 0.16)' && menuState.danger.text === 'rgb(255, 155, 155)' && menuState.danger.icon === 'rgb(255, 155, 155)',
      JSON.stringify(menuState.danger),
    );
    const { pressed, aligned, asItems, badItems, popoverState } = changes;
    check('a pressed toggle starts unpressed', pressed.before === 'false', JSON.stringify(pressed));
    check('a click presses it once, firing change', pressed.after === 'true' && pressed.property === true && pressed.changes === 1, JSON.stringify(pressed));
    check('a pressed button takes the accent soft fill', pressed.fill === 'rgba(0, 153, 255, 0.16)', JSON.stringify(pressed));
    check('a menu opened at the right edge stays inside the window', aligned.inside === true, JSON.stringify(aligned));
    // On GitHub's Linux and Windows runners a hidden window never ticks the opening motion, so
    // the popup stays mid-scale there; only macOS checks the settled edge.
    if (process.platform === 'darwin') {
      check('and lines its right edge up with the button', aligned.rightEdge === true, JSON.stringify(aligned));
    }
    check('a heading row shows', aligned.heading === 'Signed in as ada@example.test', JSON.stringify(aligned));
    check('a separator shows between rows', aligned.separators === 1 && aligned.rows === 2, JSON.stringify(aligned));
    check('a shortcut shows as a hint before the check', aligned.hint === '⌘R' && aligned.hintBeforeCheck === true, JSON.stringify(aligned));
    check(
      'rows set as data draw headings, hints, separators and checks',
      JSON.stringify(asItems) === JSON.stringify(['presentation:Data', 'menuitem:A⌘A', 'separator:', 'menuitemcheckbox:B']),
      JSON.stringify(asItems),
    );
    check('malformed rows throw', JSON.stringify(badItems) === '["TypeError","TypeError","TypeError"]', JSON.stringify(badItems));
    const popoverSeen = JSON.stringify(popoverState);
    check("a popover's content is hidden while closed", popoverState.closedShown === 0, popoverSeen);
    check(
      'opening shows the content in the popover',
      popoverState.openState.open && popoverState.openState.inPanel && popoverState.openState.shown,
      popoverSeen,
    );
    check('the button says it is expanded', popoverState.openState.expanded === 'true', popoverSeen);
    check(
      'Escape closes it and puts the same content back',
      !popoverState.closedState.open && popoverState.closedState.back && popoverState.closedState.same && popoverState.closedState.panelGone,
      popoverSeen,
    );
    check('toggle fires on open and close', JSON.stringify(popoverState.toggles) === '[true,false]', popoverSeen);
    check('a button refilled with textContent shows the new text', afterRefill.button === 'Save', JSON.stringify(afterRefill));
    check('once', afterRefill.buttonShown === 'Save', JSON.stringify(afterRefill));
    check('a dropdown refilled with replaceChildren keeps its control', (afterRefill.trigger ?? '').includes('Four'), JSON.stringify(afterRefill));
    check('and lists the new options', JSON.stringify(afterRefill.options) === '["three","four"]', JSON.stringify(afterRefill));
    check('options set as data show', (asData.trigger ?? '').includes('Blue sky'), JSON.stringify(asData));
    check(
      'and read back normalized',
      JSON.stringify(asData.options) ===
        JSON.stringify([
          { value: 'red', label: 'red', disabled: false },
          { value: 'blue', label: 'Blue sky', disabled: false, group: 'Cool' },
          { value: 'grey', label: 'grey', disabled: true },
        ]),
      JSON.stringify(asData.options),
    );
    check(
      'a malformed or oversized options list throws',
      JSON.stringify(refused) === '["TypeError","TypeError","TypeError","TypeError","RangeError"]',
      JSON.stringify(refused),
    );
    check('clearing options goes back to the children', JSON.stringify(backToChildren.options) === '["three","four"]', JSON.stringify(backToChildren));
    check('and shows them', (backToChildren.trigger ?? '').includes('Three'), JSON.stringify(backToChildren));
    check('a click on a switch label toggles it once', toggled.checked === false && toggled.toggles === 1, JSON.stringify(toggled));

    const expected = ['input:p', 'change:p', 'input:pi', 'change:pi', 'input:pin', 'change:pin', 'input:', 'change:'];
    const typed = search.events.slice(0, 6);
    check(
      'typing fires input then change once per change',
      // insertText may arrive as one edit or three; either way each change is one input and one change.
      JSON.stringify(typed) === JSON.stringify(expected.slice(0, 6)) || JSON.stringify(search.events.slice(0, 2)) === '["input:pin","change:pin"]',
      JSON.stringify(search.events),
    );
    check('clearing with Escape fires input and change', JSON.stringify(search.events.slice(-2)) === '["input:","change:"]', JSON.stringify(search.events));
    check(
      'and no event is heard twice',
      search.events.filter((event) => event.startsWith('input')).length === search.events.filter((event) => event.startsWith('change')).length,
      JSON.stringify(search.events),
    );
    check('the cleared value is empty', search.value === '' && search.field === '', JSON.stringify(search));
  }
  if (failures.length) {
    console.error(`app-ui-kit-elements: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`app-ui-kit-elements: ${checked} passed  [real Chromium, kit in <head> without defer]`);
})();
