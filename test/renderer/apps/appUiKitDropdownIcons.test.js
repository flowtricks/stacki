// The app UI kit's dropdown draws option icons as the Navigator does, in a real browser.
//
//   node test/renderer/apps/appUiKitDropdownIcons.test.js
//
// Goal: an app's dropdown matches the editor's when its options carry icons.
// `icon: 'component'` draws the Navigator's component cube, `icon: 'tag:<tag>'`
// the Navigator's icon for that tag (ElementIcons.tsx `elementIcon`), and a kit
// icon's name that icon; a value none of these knows draws no icon and throws
// nothing. The icon shows in each option row and in the closed trigger for the
// selected value, at Desktop's dropdown option icon size (16px). Icons come from
// `<option icon>` children and from the `options` property alike; a non-string
// or overlong icon set as data throws.
//
// Method: one page in Electron's Chromium, built from the shared module's
// `ui.css` and `ui.js` exactly as an app serves them. Each icon is identified by
// its named Central glyph or Stacki's component cube path.
// The page reports what it saw as JSON, which the test checks.
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
    console.log('app-ui-kit-dropdown-icons: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const kit = load('shared/properties/appUiKit.ts');
  const pageDirectory = repoPath('node_modules/.stacki-test/app-ui-kit-dropdown-icons');
  fs.mkdirSync(pageDirectory, { recursive: true });
  fs.writeFileSync(path.join(pageDirectory, 'ui.css'), kit.appHostAsset('__stacki/ui.css').body);
  fs.writeFileSync(path.join(pageDirectory, 'ui.js'), kit.appHostAsset('__stacki/ui.js').body);
  const app = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><script src="ui.js"></script></head>
    <body style="margin:0;width:320px">
    <stacki-dropdown id="children" value="card" label="Target">
      <option value="card" icon="component">Card</option>
      <option value="link" icon="tag:a">Link</option>
      <option value="odd" icon="sparkles">Odd</option>
      <option value="plain">Plain</option>
    </stacki-dropdown>
    <stacki-dropdown id="data" label="Element"></stacki-dropdown>
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
     const page = \`(async () => { try {
       const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
       const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
       // What one icon slot shows: its path, its size, and whether it leads the row.
       const icon = (row) => {
         const slot = row && row.querySelector('.dd-icon');
         const svg = slot && slot.querySelector('svg');
         return {
           glyph: svg?.dataset.centralIcon,
           path: svg ? [...svg.querySelectorAll('path')].map((part) => part.getAttribute('d')).join(' ') : undefined,
           size: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
           first: Boolean(slot && row.firstElementChild === slot),
         };
       };
       const rows = async (dropdown) => {
         dropdown.querySelector('.dd-trigger').click();
         await settle();
         const found = [...document.querySelectorAll('.dd-popup .dd-option')].map((row) => ({ label: row.textContent, ...icon(row) }));
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         await settle();
         return found;
       };
       const children = document.getElementById('children');
       const trigger = icon(children.querySelector('.dd-trigger'));
       const childRows = await rows(children);
       children.value = 'link';
       await tick();
       const triggerAfter = icon(children.querySelector('.dd-trigger'));
       children.value = 'odd';
       await tick();
       const triggerUnknown = icon(children.querySelector('.dd-trigger'));

       const data = document.getElementById('data');
       data.options = [
         { value: 'h', label: 'Heading', icon: 'tag:h2' },
         { value: 't', label: 'Trash', icon: 'trash' },
         { value: 'bad', label: 'Bad tag', icon: 'tag:<b>' },
         { value: 'x', label: 'Unknown', icon: 'nope' },
       ];
       data.value = 'h';
       await tick();
       const dataTrigger = icon(data.querySelector('.dd-trigger'));
       const dataRows = await rows(data);
       const readBack = data.options.map((option) => option.icon);
       const refused = [];
       for (const bad of [[{ value: 'a', icon: 3 }], [{ value: 'a', icon: 'x'.repeat(65) }]]) {
         try { data.options = bad; refused.push('accepted'); } catch (error) { refused.push(error.name); }
       }
       return { trigger, childRows, triggerAfter, triggerUnknown, dataTrigger, dataRows, readBack, refused };
     } catch (error) { return { failed: String(error && error.stack || error) }; } })()\`;
     app.whenReady().then(async () => {
       try {
         const win = new BrowserWindow({ show: false, width: 400, height: 500 });
         await win.loadFile(path.join(__dirname, 'app.html'));
         await wait(400);
         const result = await win.webContents.executeJavaScript(page);
         win.destroy();
         console.log(JSON.stringify(result));
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
    const result = JSON.parse(line);
    if (result.failed !== undefined) {
      check('the page script ran', false, result.failed);
    } else {
      const seen = (value) => JSON.stringify(value);
      // An icon is identified by its own path among the SVG's paths (a heading icon shares its H with the others).
      const has = (drawn, expected) => typeof drawn === 'string' && drawn.split(' M').some((part, index) => (index === 0 ? part : `M${part}`) === expected);
      const component = 'M8 2 13.5 5v6L8 14 2.5 11V5Zm-5.5 3L8 8l5.5-3M8 8v6';
      const { trigger, childRows, triggerAfter, triggerUnknown, dataTrigger, dataRows, readBack, refused } = result;
      check("the trigger shows the selected option's component cube", has(trigger.path, component), seen(trigger));
      check("at Desktop's option icon size, before the label", trigger.size === 16 && trigger.first, seen(trigger));
      check("a component row draws the Navigator's component cube", childRows[0] && has(childRows[0].path, component), seen(childRows));
      check("a tag:a row draws the Navigator's link icon", childRows[1] && childRows[1].glyph === 'link', seen(childRows));
      check('rows draw their icon first, at 16px', childRows[0].first && childRows[0].size === 16 && childRows[1].size === 16, seen(childRows));
      check('an unknown icon draws none', childRows[2] && childRows[2].path === undefined && childRows[2].label === 'Odd', seen(childRows));
      check('an option with no icon draws none', childRows[3] && childRows[3].path === undefined, seen(childRows));
      check('choosing another value moves its icon to the trigger', triggerAfter.glyph === 'link', seen(triggerAfter));
      check('a selected option with an unknown icon leaves the trigger without one', triggerUnknown.path === undefined, seen(triggerUnknown));
      check('options set as data draw a tag icon in the trigger', dataTrigger.glyph === 'h2', seen(dataTrigger));
      check(
        'and in their rows: a tag, a kit icon, nothing for a malformed tag or an unknown name',
        dataRows.length === 4 &&
          dataRows[0].glyph === 'h2' &&
          typeof dataRows[1].path === 'string' &&
          dataRows[2].path === undefined &&
          dataRows[3].path === undefined,
        seen(dataRows),
      );
      check('the icon reads back as given', seen(readBack) === '["tag:h2","trash","tag:<b>","nope"]', seen(readBack));
      check('a non-string or overlong icon throws', seen(refused) === '["TypeError","RangeError"]', seen(refused));
    }
  }
  if (failures.length) {
    console.error(`app-ui-kit-dropdown-icons: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`app-ui-kit-dropdown-icons: ${checked} passed  [real Chromium, Navigator icons in the kit's dropdown]`);
})();
