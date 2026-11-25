// Goal: the "Property settings" form a field's purple dot opens ("New Plain
// Text property", "New Class list property") sits inside its pop-up with the
// same inset as the same form in the loop Source pop-up: its heading, fields,
// Required row and buttons clear the left, right and bottom edges by the same
// amount, from every entry point (an element's class field, its style field, a
// data attribute's value, a prop field of an instance).
//
// Method: jsdom has no layout, so the real fields are rendered in Electron with
// the stylesheets the app loads. The reference is the form inside the pop-up
// the loop Source picker opens it in (.loop-settings-popup). For each entry
// point the test presses the field's dot, presses the New … property row, waits
// for the form, and measures its heading, name field, Required row and buttons
// against the pop-up's padding box: left, right and bottom insets must be above
// zero and within 1 px of the reference's. A screenshot of each is written to
// node_modules/.stacki-test/new-prop-form-inset/screens for a person to look
// at. Skipped where no Chromium is available.

const fs = require('fs');
const path = require('path');
const { repoPath, sourceSpecifier } = require('../../helpers/sources.js');

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
    console.log('new-prop-form-inset: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const esbuild = require('esbuild');
  const pageDirectory = repoPath('node_modules/.stacki-test/new-prop-form-inset');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const entry = path.join(pageDirectory, 'entry.jsx');
  fs.writeFileSync(
    entry,
    `import React from 'react'
     import { createRoot } from 'react-dom/client'
     import ${sourceSpecifier('src/app/styles.css')}
     import ${sourceSpecifier('src/features/style/tokens.css')}
     import PropField from ${sourceSpecifier('src/features/props/PropField.tsx')}
     import NewPropForm from ${sourceSpecifier('src/features/props/NewPropForm.tsx')}
     import { AttributesSection } from ${sourceSpecifier('src/features/props/propAttributes.tsx')}
     import { classListOfferOf } from ${sourceSpecifier('src/features/props/classListProp.ts')}
     window.avb = { platform: 'darwin' }
     const host = { componentName: 'Card.astro', propKeys: ['tone'], restLocal: undefined, create: () => ({ ok: true, value: 'className' }) }
     const context = { frontmatter: 'interface Props {\\n  tone?: string;\\n}\\nconst { tone } = Astro.props;\\n', newProp: host }
     const card = { kind: 'element', name: 'div', props: { class: { type: 'string', value: 'card' } } }
     const panel = (children) => React.createElement('div', { className: 'props-panel', style: { width: 280, padding: 12 } }, children)
     const views = {
       reference: () => React.createElement('div', { className: 'loop-settings-popup', style: { left: 20, top: 20, width: 300 } },
         React.createElement(NewPropForm, { host, seed: { fit: 'text', label: 'class', value: 'card' }, onCreated() {}, onCancel() {} })),
       classField: () => panel(React.createElement(PropField, { field: { name: 'class', type: 'string' }, value: card.props.class, bindContext: context,
         classList: classListOfferOf(card, host, () => {}), onChange() {} })),
       styleField: () => panel(React.createElement(PropField, { field: { name: 'style', type: 'style' }, value: { type: 'string', value: 'color: red' }, bindContext: context, onChange() {} })),
       instanceProp: () => panel(React.createElement(PropField, { field: { name: 'title', type: 'string' }, value: { type: 'string', value: 'Hello' }, bindContext: context, onChange() {} })),
       attributeValue: () => panel(React.createElement(AttributesSection, { node: { id: 'n1', props: { 'data-label': { type: 'string', value: 'Hi' } } }, names: ['data-label'],
         bindContext: context, tag: 'div', onSetProp() {}, onRenameProp() {} })),
     }
     const root = createRoot(document.getElementById('root'))
     let generation = 0
     window.show = (name) => root.render(React.createElement('div', { key: generation++ }, views[name]()))`,
  );
  await esbuild.build({
    entryPoints: [entry],
    outdir: path.join(pageDirectory, 'out'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.png': 'dataurl', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="out/entry.css"><style>body{margin:0;background:#1a1a1a;color:#eee}</style><div id="root"></div><script src="out/entry.js"></script>',
  );
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     const { MOTION_SETTLED_EXPRESSION, waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
     // Each part of the form against the padding box of the pop-up it sits in.
     const MEASURE = \`(() => {
       const form = document.querySelector('.new-prop-form');
       const popup = form.closest('.bind-menu, .loop-settings-popup');
       const box = popup.getBoundingClientRect();
       const innerLeft = box.left + popup.clientLeft;
       const innerRight = innerLeft + popup.clientWidth;
       const contentBottom = box.top + popup.clientTop + popup.scrollHeight - popup.scrollTop;
       const part = (selector) => { const element = form.querySelector(selector); return element ? element.getBoundingClientRect() : undefined; };
       const parts = { head: part('.loop-property-head'), name: part('.loop-bind-name input'), required: part('.property-flags'), actions: part('.loop-bind-actions') };
       const insets = {};
       for (const [name, rectangle] of Object.entries(parts)) {
         if (rectangle) { insets[name] = { left: Math.round((rectangle.left - innerLeft) * 10) / 10, right: Math.round((innerRight - rectangle.right) * 10) / 10 }; }
       }
       return { insets, bottom: parts.actions ? Math.round((contentBottom - parts.actions.bottom) * 10) / 10 : undefined, scrollWide: popup.scrollWidth > popup.clientWidth + 1 };
     })()\`;
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 760, height: 900 });
       await win.loadFile(path.join(__dirname, 'index.html'));
       const run = (code) => win.webContents.executeJavaScript(code).catch((error) => { throw new Error(String(error) + ' in: ' + code.slice(0, 160)); });
       const shows = (what, expression) => waitFor({ what, read: () => run('Boolean(' + expression + ')'), until: (shown) => shown });
       const settled = () => waitFor({ what: 'the motion settled', read: () => run(MOTION_SETTLED_EXPRESSION), until: (still) => still });
       const press = (selector) => run("(() => { const element = document.querySelector(" + JSON.stringify(selector) + "); element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); element.click(); })()");
       const pressText = (text) => run("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === " + JSON.stringify(text) + ").click()");
       const screens = path.join(__dirname, 'screens');
       require('fs').mkdirSync(screens, { recursive: true });
       const results = {};
       const record = async (name) => {
         await shows(name + ': the form', "document.querySelector('.new-prop-form .loop-bind-actions')");
         await settled();
         results[name] = await run(MEASURE);
         require('fs').writeFileSync(path.join(screens, name + '.png'), (await win.webContents.capturePage()).toPNG());
       };
       await run("window.show('reference')");
       await record('reference');
       for (const [name, row] of [['classField', 'New Class list property'], ['classFieldText', 'New Plain Text property'], ['styleField', 'New Plain Text property'], ['instanceProp', 'New Plain Text property'], ['attributeValue', 'New Plain Text property']]) {
         await run("window.show(" + JSON.stringify(name === 'classFieldText' ? 'classField' : name) + ")");
         if (name === 'attributeValue') {
           await shows(name + ': the row', "document.querySelector('.attr-row')");
           await run("document.querySelector('.attr-row').click()");
           await shows(name + ': the editor', "document.querySelector('.attr-editor .attr-value-field .bind-handle')");
           await press('.attr-editor .attr-value-field .bind-handle');
         } else {
           await shows(name + ': the dot', "document.querySelector('.bind-handle')");
           await press('.bind-handle');
         }
         await shows(name + ': the menu', "[...document.querySelectorAll('.bind-menu button')].some((button) => button.textContent.trim() === " + JSON.stringify(row) + ")");
         await pressText(row);
         await record(name);
       }
       console.log(JSON.stringify(results));
       app.quit();
     }).catch((error) => {
       console.log(JSON.stringify({ probeError: String(error) }));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const ran = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000, env: environment });
  const line = (ran.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (ran.stderr || ran.stdout || '').slice(0, 800));
  } else {
    const results = JSON.parse(line);
    if (results.probeError !== undefined) {
      console.error(`new-prop-form-inset: the probe failed: ${results.probeError}`);
      process.exit(1);
    }
    const reference = results.reference;
    const within = (value, expected) => value !== undefined && expected !== undefined && Math.abs(value - expected) <= 1;
    check('the reference form clears the bottom edge', reference.bottom > 0, JSON.stringify(reference));
    for (const [name, measured] of Object.entries(results)) {
      check(`${name}: the pop-up does not scroll sideways`, measured.scrollWide === false, JSON.stringify(measured));
      for (const [part, inset] of Object.entries(reference.insets)) {
        const own = measured.insets[part];
        check(`${name}: ${part} clears the left edge`, own !== undefined && own.left > 0, JSON.stringify(measured.insets));
        check(`${name}: ${part} clears the right edge`, own !== undefined && own.right > 0, JSON.stringify(measured.insets));
        check(
          `${name}: ${part} sits as far from the left as in the reference`,
          own !== undefined && within(own.left, inset.left),
          JSON.stringify({ own, inset }),
        );
        check(
          `${name}: ${part} sits as far from the right as in the reference`,
          own !== undefined && within(own.right, inset.right),
          JSON.stringify({ own, inset }),
        );
      }
      check(`${name}: the buttons clear the bottom edge`, measured.bottom > 0, JSON.stringify(measured));
      check(
        `${name}: as far as in the reference`,
        within(measured.bottom, reference.bottom),
        JSON.stringify({ own: measured.bottom, reference: reference.bottom }),
      );
    }
  }
  if (failures.length > 0) {
    console.error(`new-prop-form-inset: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`new-prop-form-inset: ${checked} checks passed`);
})();
