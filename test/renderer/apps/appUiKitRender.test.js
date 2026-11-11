// The app UI kit renders like the editor, in a real browser.
//
//   node test/renderer/apps/appUiKitRender.test.js
//
// Goal: an app's button, switch, tabs and dropdown are the editor's: the same
// colour, radius and height, at rest and with the dropdown open, with its check
// at the end of the chosen row. The kit is the editor's components compiled
// (scripts/build/appUiKit.mts); this holds what an app sees, under the kit's
// scoped stylesheet, against what the editor draws under its own stylesheets.
//
// Method: two pages in Electron's Chromium. The editor page mounts the real
// Switch, SegmentedTabs and Dropdown and a primary and a plain button under the
// app's stylesheets (bundled with esbuild, as appsViewTabs.test.js does). The
// kit page is what an app serves: the injected tokens, `__stacki/ui.css` and
// `__stacki/ui.js` from the shared module, and `<stacki-*>` elements. Each page
// opens its dropdown with a real click, and the computed styles are compared.
const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');
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
    console.log('app-ui-kit-render: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const esbuild = require('esbuild');
  const kit = load('shared/properties/appUiKit.ts');
  const pageDirectory = repoPath('node_modules/.stacki-test/app-ui-kit-render');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import Dropdown from './src/ui/Dropdown'
    import { Switch } from './src/ui/Switch'
    import { SegmentedTabs } from './src/ui/SegmentedTabs'
    import './src/features/style/tokens.css'
    import './src/app/styles.css'

    function Harness() {
      const [value, setValue] = useState('two')
      const [on, setOn] = useState(true)
      const [tab, setTab] = useState('a')
      return (
        <div style={{ width: 240, padding: 12 }}>
          <button className="primary" id="primary">Add</button>
          <button id="secondary">Cancel</button>
          <div id="switch"><Switch label="Pins" checked={on} onToggle={() => setOn(!on)} /></div>
          <div id="tabs"><SegmentedTabs tabs={[{ value: 'a', label: 'Open' }, { value: 'b', label: 'Resolved' }]} value={tab} label="Pins" onPick={setTab} /></div>
          <div id="dropdown"><Dropdown value={value} options={[{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]} onChange={setValue} /></div>
        </div>
      )
    }
    createRoot(document.getElementById('root')).render(<Harness />)
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx' },
    outfile: path.join(pageDirectory, 'editor.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(pageDirectory, 'editor.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="editor.css"><style>body{margin:0;overflow:visible}</style><div id="root"></div><script src="editor.js"></script>',
  );
  // What an app serves: its page with the tokens injected, linking the kit.
  fs.writeFileSync(path.join(pageDirectory, 'ui.css'), kit.appHostAsset('__stacki/ui.css').body);
  fs.writeFileSync(path.join(pageDirectory, 'ui.js'), kit.appHostAsset('__stacki/ui.js').body);
  const app = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><script src="ui.js"></script>
    <style>body{margin:0}</style></head><body><div style="width:240px;padding:12px">
    <div class="stacki-ui"><button class="primary" id="primary">Add</button><button id="secondary">Cancel</button></div>
    <div id="switch"><stacki-switch label="Pins" checked></stacki-switch></div>
    <div id="tabs"><stacki-tabs value="a" label="Pins"><button value="a">Open</button><button value="b">Resolved</button></stacki-tabs></div>
    <div id="dropdown"><stacki-dropdown value="two"><option value="one">One</option><option value="two">Two</option></stacki-dropdown></div>
    </div></body></html>`;
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
     const read = \`(() => {
       const look = (element) => {
         if (!element) { return undefined; }
         const style = getComputedStyle(element);
         const box = element.getBoundingClientRect();
         return { background: style.backgroundColor, color: style.color, radius: style.borderTopLeftRadius, height: Math.round(box.height * 10) / 10, font: style.fontSize + ' ' + style.fontWeight };
       };
       const trigger = document.querySelector('#dropdown .dd-trigger');
       const box = trigger.getBoundingClientRect();
       return {
         primary: look(document.getElementById('primary')),
         secondary: look(document.getElementById('secondary')),
         switch: look(document.querySelector('#switch .ui-switch')),
         thumb: look(document.querySelector('#switch .ui-switch-thumb')),
         tabs: look(document.querySelector('#tabs .ui-tabs')),
         tab: look(document.querySelector('#tabs .ui-tab.on')),
         trigger: look(trigger),
         at: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
       };
     })()\`;
     const readMenu = \`(() => {
       const popup = document.querySelector('.dd-popup');
       const rows = [...document.querySelectorAll('.dd-option')];
       const chosen = rows.find((row) => row.querySelector('.dd-check svg'));
       const look = (element) => {
         const style = getComputedStyle(element);
         return { background: style.backgroundColor, radius: style.borderTopLeftRadius, height: Math.round(element.getBoundingClientRect().height * 10) / 10, shadow: style.boxShadow };
       };
       return {
         popup: popup && look(popup),
         rows: rows.length,
         row: rows[0] && look(rows[0]),
         checkLast: Boolean(chosen && chosen.lastElementChild && chosen.lastElementChild.classList.contains('dd-check')),
         checkRight: Boolean(chosen && chosen.querySelector('.dd-check').getBoundingClientRect().left > chosen.querySelector('.dd-option-label').getBoundingClientRect().right),
       };
     })()\`;
     async function session(file) {
       const win = new BrowserWindow({ show: false, width: 400, height: 500 });
       await win.loadFile(path.join(__dirname, file));
       await wait(400);
       const js = (code) => win.webContents.executeJavaScript(code);
       const rest = await js(read);
       win.webContents.sendInputEvent({ type: 'mouseDown', x: rest.at.x, y: rest.at.y, button: 'left', clickCount: 1 });
       win.webContents.sendInputEvent({ type: 'mouseUp', x: rest.at.x, y: rest.at.y, button: 'left', clickCount: 1 });
       await wait(400);
       const menu = await js(readMenu);
       win.destroy();
       return { rest, menu };
     }
     app.whenReady().then(async () => {
       try {
         const editor = await session('editor.html');
         const kit = await session('app.html');
         console.log(JSON.stringify({ editor, kit }));
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
    const { editor, kit: app } = JSON.parse(line);
    for (const part of ['primary', 'secondary', 'switch', 'thumb', 'tabs', 'tab', 'trigger']) {
      check(
        `the ${part} is drawn`,
        editor.rest[part] !== undefined && app.rest[part] !== undefined,
        JSON.stringify({ editor: editor.rest[part], app: app.rest[part] }),
      );
      for (const property of ['background', 'color', 'radius', 'height', 'font']) {
        const want = editor.rest[part] && editor.rest[part][property];
        const got = app.rest[part] && app.rest[part][property];
        check(`${part} ${property} matches the editor`, want === got, `editor ${want}, app ${got}`);
      }
    }
    check('the primary button is the accent', app.rest.primary.background === 'rgb(0, 153, 255)', app.rest.primary.background);
    check('the switch is on, in the accent', app.rest.switch.background === 'rgb(0, 153, 255)', app.rest.switch.background);
    check('the dropdown opens in both', editor.menu.rows === 2 && app.menu.rows === 2, JSON.stringify({ editor: editor.menu, app: app.menu }));
    for (const part of ['popup', 'row']) {
      check(
        `the open ${part} matches the editor`,
        JSON.stringify(editor.menu[part]) === JSON.stringify(app.menu[part]),
        JSON.stringify({ editor: editor.menu[part], app: app.menu[part] }),
      );
    }
    check("the chosen row's check ends the row", app.menu.checkLast && app.menu.checkRight, JSON.stringify(app.menu));
  }
  if (failures.length) {
    console.error(`app-ui-kit-render: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`app-ui-kit-render: ${checked} passed  [real Chromium, editor against app]`);
})();
