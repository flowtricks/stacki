// Goal: the sections the two property forms share read like the rest of each
// form. A List's Default items is the instance's own field: a small label chip
// with its `{}` beside it on one row, then the list at the same left and right
// edges as Name and Tooltip, in the Properties panel and the Settings pop-up,
// in list view and code view, with the list's chrome exactly the instance's.
// The Code type field keeps a one-line input's height and fill, and marks its
// tokens in colour. A list item's popup spaces its fields as a form does. A
// tooltip is as tall as its text, and every header's close is the same square.
//
// Method: the real forms and a real instance field, in a real browser. This was
// invisible to jsdom: `.property-editor label` turned the instance's label into
// a stretched column and `.props-field`'s panel gutter inset the list, and only
// a cascade and a layout show either. So each host is rendered in Electron with
// every stylesheet the app loads, and the boxes and computed styles are measured.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath, sourceSpecifier } = require('../../helpers/sources.js');

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
    console.log('property-form-layout: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }

  const esbuild = require('esbuild');
  const pageDirectory = repoPath('node_modules/.stacki-test/property-form-layout');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const entry = path.join(pageDirectory, 'entry.jsx');
  fs.writeFileSync(
    entry,
    `import React from 'react'
     import { createRoot } from 'react-dom/client'
     import { PropertyEditor } from ${sourceSpecifier('src/features/componentProperties/PropertyEditor.tsx')}
     import NewPropForm from ${sourceSpecifier('src/features/props/NewPropForm.tsx')}
     import PropField from ${sourceSpecifier('src/features/props/PropField.tsx')}
     import PropertySettingsDialog from ${sourceSpecifier('src/features/componentProperties/PropertySettingsDialog.tsx')}
     import { listDefaultField } from ${sourceSpecifier('src/features/props/PropertySections.tsx')}
     const items = '[{ title: "One", text: "Two" }]'
     const type = 'readonly { title: string; text: string }[]'
     const fields = [{ name: 'title', kind: 'text' }, { name: 'text', kind: 'text' }]
     const property = { name: 'features', type, required: false, readonly: false, defaultValue: items, description: '' }
     // The picker's form reads its prop through the bridge; here that is the prop above.
     window.avb = { componentProperties: async () => ({ ok: true, value: { source: '', frontmatter: '', advanced: false, properties: [property] } }) }
     const saver = { projectPath: '/site', file: '/site/src/components/Card.astro', flushSave: async () => {}, changePhase() {}, recordUndo() {}, completeSave: async () => {} }
     // Mounted last: its Name takes focus, which dismisses the panel's popover, and
     // the two are never on screen together in the app.
     window.mountDialog = () => createRoot(document.getElementById('dialog')).render(
       React.createElement(PropertySettingsDialog, { propertyKey: 'features', saver, onClose() {} }))
     const host = { componentName: 'Card.astro', propKeys: [], restLocal: undefined, create: () => ({ ok: true, value: 'x' }) }
     const seed = { fit: 'list', label: 'features', value: items }
     createRoot(document.getElementById('panel')).render(
       React.createElement(PropertyEditor, {
         property, originalName: 'features', frontmatter: '', access: 'editable',
         onClose() {}, onSave: async () => {},
         saveHost: { save: async () => ({ kind: 'saved', source: '' }), reload: async () => ({ ok: false, error: '' }) },
       }))
     createRoot(document.getElementById('popup')).render(
       React.createElement(NewPropForm, { host, seed, onCreated() {}, onCancel() {} }))
     createRoot(document.getElementById('instance')).render(
       React.createElement(PropField, {
         nodeKey: 'instance', field: listDefaultField(fields), value: { type: 'expr', value: items }, bindContext: { frontmatter: '' }, onChange() {},
       }))`,
  );
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(pageDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(pageDirectory, 'app.css'),
    [
      'src/features/style/tokens.css',
      'src/app/styles.css',
      'src/ui/popup.css',
      'src/features/componentProperties/componentProperties.css',
      'src/features/props/loopSettings.css',
    ]
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(pageDirectory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css">' +
      '<style>body{margin:0;background:#1a1a1a;display:flex;gap:24px;align-items:flex-start}#panel,#popup,#instance,#dialog{position:relative;width:280px;flex:none}' +
      '#popup{padding:10px;background:#232323}</style>' +
      '<div id="panel"></div><div id="popup"></div><div id="instance"></div><div id="dialog"></div><script src="bundle.js"></script>',
  );

  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron');
     const path = require('path');
     app.disableHardwareAcceleration();
     app.on('window-all-closed', () => app.quit());
     const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
     const READ = \`((hostId) => {
       const host = document.getElementById(hostId);
       const box = (element) => {
         if (!element) { return undefined; }
         const r = element.getBoundingClientRect();
         return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
       };
       const field = host.querySelector('.props-field');
       const label = field.querySelector(':scope > label');
       const list = field.querySelector('.list-field');
       const add = field.querySelector('.list-field-add');
       const code = field.querySelector('.expr-input');
       // What the field lines up with: the panel's full-width Tooltip, or the pop-up's
       // own edges, since its Tooltip sits beside a label in two columns.
       const reference = host.querySelector('.loop-bind-dialog') ?? host.querySelector('textarea');
       const style = (element, names) => element ? Object.fromEntries(names.map((name) => [name, getComputedStyle(element)[name]])) : undefined;
       const edges = ['borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderLeftWidth', 'outlineStyle', 'backgroundColor', 'borderRadius'];
       return {
         label: box(label), labelStyle: style(label, ['display', 'flexDirection', 'fontSize', 'color']),
         pill: box(field.querySelector('.prop-label')),
         toggle: box(field.querySelector('.prop-expr-toggle')),
         list: box(list), listStyle: style(list, edges),
         add: box(add), addStyle: style(add, edges),
         code: box(code), field: box(field), reference: box(reference),
         flagLabel: style(host.querySelector('.property-flags label'), ['flexDirection']),
       };
     })\`;
     const CODE_TYPE = \`((hostId) => {
       const field = document.getElementById(hostId).querySelector('.property-code');
       const r = field.getBoundingClientRect();
       const tokens = [...field.querySelectorAll('.cm-line span')];
       const s = getComputedStyle(field);
       return {
         height: Math.round(r.height), width: Math.round(r.width),
         background: s.backgroundColor, borderColor: s.borderTopColor, overflow: s.overflowY,
         colors: new Set(tokens.map((token) => getComputedStyle(token).color)).size,
         text: field.querySelector('.cm-content').textContent,
         scrollsSideways: field.querySelector('.cm-scroller').scrollWidth > field.querySelector('.cm-scroller').clientWidth + 1,
       };
     })\`;
     const ITEM_GAPS = \`(() => {
       const fields = [...document.querySelectorAll('.list-item-editor .props-field')];
       const box = (element) => element.getBoundingClientRect();
       const label = fields[0].querySelector(':scope > label');
       const control = label.nextElementSibling;
       return {
         fields: fields.length,
         dots: document.querySelectorAll('.list-item-editor .bind-dot').length,
         labelToInput: Math.round(box(control).top - box(label).bottom),
         fieldToField: Math.round(box(fields[1]).top - box(fields[0]).bottom),
       };
     })()\`;
     const FORM_CHROME = \`(() => {
       const size = (element) => { const r = element.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
       const tooltip = document.querySelector('#panel fieldset > label:last-of-type textarea');
       return {
         closes: {
           panel: size(document.querySelector('#panel [aria-label="Close property settings"]')),
           popup: size(document.querySelector('#popup [aria-label="Close"]')),
         },
         tooltip: size(tooltip),
         resize: getComputedStyle(tooltip).resize,
         dropdowns: document.querySelectorAll('#panel [aria-label="Field type"].dd-trigger').length,
         selects: document.querySelectorAll('#panel select, #popup select, #dialog select').length,
       };
     })()\`;
     const DIALOG_CLOSE = \`(() => {
       const r = document.querySelector('#dialog [aria-label="Close property settings"]').getBoundingClientRect();
       return [Math.round(r.width), Math.round(r.height)];
     })()\`;
     const TOOLTIP_GROWS = \`(async () => {
       const tooltip = document.querySelector('#panel fieldset > label:last-of-type textarea');
       Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(tooltip, ['One', 'Two', 'Three'].join(String.fromCharCode(10)));
       tooltip.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise((resolve) => setTimeout(resolve, 50));
       return Math.round(tooltip.getBoundingClientRect().height);
     })()\`;
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 960, height: 1000 });
       await win.loadFile(path.join(__dirname, 'index.html'));
       await sleep(800);
       // Which read failed, since Electron's own error does not say.
       const run = (code) =>
         win.webContents.executeJavaScript(code).catch((error) => {
           throw new Error(String(error) + ' in: ' + code.slice(0, 120));
         });
       const read = (host) => run(READ + '(' + JSON.stringify(host) + ')');
       const listView = { panel: await read('panel'), popup: await read('popup'), instance: await read('instance') };
       const popupGaps = async () => {
         await run("document.querySelector('#instance .list-field-text').click()");
         await sleep(200);
         const gaps = await run(ITEM_GAPS);
         await run("document.querySelector('.list-item-editor button.ghost').click()");
         await sleep(100);
         return gaps;
       };
       const item = await popupGaps();
       const chrome = await run(FORM_CHROME);
       const typed = await run(TOOLTIP_GROWS);
       const clickIn = (host, selector) => run('document.getElementById(' + JSON.stringify(host) + ').querySelector(' + JSON.stringify(selector) + ').click()');
       await clickIn('panel', '.property-code-toggle');
       await clickIn('popup', '.property-code-toggle');
       await sleep(200);
       const codeType = {
         panel: await run(CODE_TYPE + '("panel")'),
         popup: await run(CODE_TYPE + '("popup")'),
         input: await run("(() => { const r = document.querySelector('#popup .new-prop-input').getBoundingClientRect(); return { height: Math.round(r.height), background: getComputedStyle(document.querySelector('#popup .new-prop-input')).backgroundColor }; })()"),
       };
       for (const host of ['panel', 'popup', 'instance']) {
         await clickIn(host, '.props-field .prop-expr-toggle');
       }
       await sleep(300);
       const codeView = { panel: await read('panel'), popup: await read('popup'), instance: await read('instance') };
       await run('window.mountDialog()');
       await sleep(300);
       chrome.closes.dialog = await run(DIALOG_CLOSE);
       console.log(JSON.stringify({ listView, codeType, codeView, item, chrome, typed }));
       app.quit();
     }).catch((error) => {
       // Without this a failed read leaves the window open until the runner's timeout.
       console.log(JSON.stringify({ probeError: String(error) }));
       app.quit();
     });`,
  );

  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 180000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const { listView, codeType, codeView, item, chrome, typed, probeError } = JSON.parse(line);
    if (probeError !== undefined) {
      console.error(`property-form-layout: the probe failed: ${probeError}`);
      process.exit(1);
    }
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

    for (const [view, hosts] of [
      ['list view', listView],
      ['code view', codeView],
    ]) {
      for (const name of ['panel', 'popup']) {
        const host = hosts[name];
        const where = `${name}, ${view}`;
        // The row: as the instance draws it, never a stretched column.
        check(
          `${where}: the label is the instance's`,
          same(host.labelStyle, hosts.instance.labelStyle),
          JSON.stringify([host.labelStyle, hosts.instance.labelStyle]),
        );
        check(
          `${where}: the chip is as small as the instance's`,
          // Within a pixel: the same chip lands on a different subpixel in each
          // host, and Linux text rounds it to 97 in one and 98 in the other.
          Math.abs(host.pill.width - hosts.instance.pill.width) <= 1,
          JSON.stringify([host.pill, hosts.instance.pill]),
        );
        check(
          `${where}: the {} sits on the chip's row`,
          host.toggle.top < host.pill.bottom && host.toggle.bottom > host.pill.top,
          JSON.stringify([host.pill, host.toggle]),
        );
        check(`${where}: the {} is right beside it`, host.toggle.left - host.pill.right <= 8, JSON.stringify([host.pill, host.toggle]));
        // The edges: the field runs as wide as the form's other fields.
        const body = view === 'list view' ? host.list : host.code;
        check(`${where}: the field starts at the form's left edge`, body.left === host.reference.left, JSON.stringify([body, host.reference]));
        check(`${where}: and ends at its right edge`, body.right === host.reference.right, JSON.stringify([body, host.reference]));
      }
    }
    // Letting the field's label out of the form's column must leave the rest in it.
    check('the Required and Readonly flags stay rows', listView.panel.flagLabel.flexDirection === 'row', JSON.stringify(listView.panel.flagLabel));
    // The list itself is the instance's own, line for line.
    for (const name of ['panel', 'popup']) {
      check(
        `${name}: the list's chrome is the instance's`,
        same(listView[name].listStyle, listView.instance.listStyle),
        JSON.stringify(listView[name].listStyle),
      );
      check(`${name}: so is the Add item row's`, same(listView[name].addStyle, listView.instance.addStyle), JSON.stringify(listView[name].addStyle));
    }

    // Header closes: one square, whatever the form and the mark inside it.
    for (const [name, size] of Object.entries(chrome.closes)) {
      check(`${name}: the close is a 24px square`, size[0] === 24 && size[1] === 24, JSON.stringify(chrome.closes));
    }
    check('an empty tooltip is one line tall', chrome.tooltip[1] <= 40, JSON.stringify(chrome));
    check('a tooltip has no resize handle', chrome.resize === 'none', chrome.resize);
    check('and grows with its text', typed >= chrome.tooltip[1] + 20, JSON.stringify([chrome.tooltip, typed]));
    check('the item fields use the app’s dropdown', chrome.dropdowns === 2, JSON.stringify(chrome));
    check('and no native select is left', chrome.selects === 0, JSON.stringify(chrome));

    // An item's popup: a prop field's label gap, the panel's field gap, and a dot on each.
    check('the item popup has both fields', item.fields === 2, JSON.stringify(item));
    check('an item field has a bind dot each', item.dots >= 2, JSON.stringify(item));
    check("its label sits a prop field's gap above its control", item.labelToInput === 5, JSON.stringify(item));
    check("its fields are the form's gap apart", item.fieldToField === 12, JSON.stringify(item));

    for (const name of ['panel', 'popup']) {
      const field = codeType[name];
      check(`${name}: the Code type holds the type`, field.text === 'readonly { title: string; text: string }[]' || field.text === '', field.text);
    }
    const shown = codeType.panel;
    check('the Code type marks its tokens in more than one colour', shown.colors >= 2, JSON.stringify(shown));
    check('it wraps a long type rather than scrolling sideways', !shown.scrollsSideways, JSON.stringify(shown));
    check(
      'it keeps a filled field, never an outline',
      shown.background !== 'rgba(0, 0, 0, 0)' && shown.borderColor === 'rgba(0, 0, 0, 0)',
      JSON.stringify(shown),
    );
    check(
      "an empty one in the pop-up is an input's height",
      Math.abs(codeType.popup.height - codeType.input.height) <= 2,
      JSON.stringify([codeType.popup, codeType.input]),
    );
    check("and has an input's fill", codeType.popup.background === codeType.input.background, JSON.stringify([codeType.popup, codeType.input]));
  }

  if (failures.length) {
    console.error(`property-form-layout: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`property-form-layout: ${checked} passed  [both forms, list and code views, real layout]`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
