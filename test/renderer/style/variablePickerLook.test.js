// The variable picker's rows read cleanly: room to breathe, a clear hierarchy, values in one column.
//
//   node test/renderer/style/variablePickerLook.test.js
//
// Goal: pin the picker's look so it stays scannable: rows 1.75 to 2rem tall with 0.125rem between
// them in a card, the variable name 0.8125rem at weight 500 in the primary text colour, its value
// 0.6875rem monospace at weight 400 in secondary text that clears 4.5:1 on the row and on the selected
// row, group headings 0.75rem at weight 600 with room beneath, and no name cut off while it fits within 60% of the row. The list still fits the height cap and scrolls.
// Method: layout is the question, so the real VariablePicker is mounted in a hidden Chromium window
// (Electron, the pattern of popoverDropdown.test.js) with Font, Color and Length fixtures, measured
// with getComputedStyle and getBoundingClientRect, and captured to PNGs under
// node_modules/.stacki-test/picker-look for a person to look at.

const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

(async () => {
  const esbuild = require('esbuild');
  const directory = repoPath('node_modules/.stacki-test/picker-look');
  fs.mkdirSync(directory, { recursive: true });
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { VariablePicker } from './src/features/style/VariablePicker'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'

    const v = (name, value, type, group = ':root') => ({ name, value, collection: 'src/styles/tokens.css', group, binding: 'var(--' + name + ')', type, file: 'a.css' })
    const FIXTURES = {
      font: { prop: 'font-family', selected: 'var(--primary-family)', vars: [
        v('primary-family', 'var(--font-inter, system-ui, sans-serif)', 'FontFamily'),
        v('display-font-family', 'var(--primary-family)', 'FontFamily'),
        v('h1-font-family', 'var(--primary-family)', 'FontFamily'),
        v('text-large-font-family', 'var(--primary-family)', 'FontFamily'),
        v('mono-family', '"JetBrains Mono", ui-monospace, monospace', 'FontFamily'),
      ] },
      color: { prop: 'color', selected: 'var(--brand)', vars: [
        v('brand', '#c6fb50', 'Color'), v('background', 'var(--light-300)', 'Color'), v('light-300', '#f3f3f3', 'Color'),
        v('dark-900', '#1f1d1e', 'Color'), v('overlay-heavy-translucent', 'color-mix(in srgb, #000 40%, transparent)', 'Color'),
        v('accent', '#7c5cff', 'Color', '.theme-dark'), v('accent-soft', '#cbbcff', 'Color', '.theme-dark'),
      ] },
      length: { prop: 'width', selected: 'var(--space-4)', vars: [
        v('space-1', '0.25rem', 'Size'), v('space-2', '0.5rem', 'Size'), v('space-3', '0.75rem', 'Size'), v('space-4', '1rem', 'Size'),
        v('container-max-width', 'clamp(20rem, 80vw, 75rem)', 'Size'), v('radius', '0.5rem', 'Size'),
      ] },
    }
    function Harness() {
      const [name, setName] = useState(null)
      window.__show = (value) => setName(value)
      if (name === null) return null
      const fixture = FIXTURES[name]
      return (
        <div className="embed-editor_root">
          <div id="anchor" style={{ position: 'fixed', top: 24, left: 20, width: 320, height: 28, background: '#333' }}>row</div>
          <Picker key={name} fixture={fixture} />
        </div>
      )
    }
    function Picker({ fixture }) {
      const [anchor, setAnchor] = useState(null)
      return (
        <>
          <div ref={(el) => { if (el && !anchor) setAnchor(document.getElementById('anchor')) }} />
          {anchor ? <VariablePicker anchor={anchor} vars={fixture.vars} loading={false} prop={fixture.prop} selectedBinding={fixture.selected} onPick={() => {}} onClose={() => {}} /> : null}
        </>
      )
    }
    createRoot(document.getElementById('root')).render(<Harness />)
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx' },
    outfile: path.join(directory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.woff2': 'empty', '.woff': 'empty', '.svg': 'empty', '.png': 'empty' },
  });
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>html{font-size:16px}body{margin:0;background:#161616}</style><div id="root"></div><script src="bundle.js"></script>',
  );
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('variable-picker-look: skipped, no Electron to lay it out in');
    return;
  }
  const scriptPath = path.join(directory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     const fs = require('fs');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 380, height: 520, useContentSize: true });
       await win.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});
       const js = (code) => win.webContents.executeJavaScript(code);
       const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
       const measure = \`(() => {
         const popup = document.querySelector('.embed-editor_varpicker');
         const css = (node) => getComputedStyle(node);
         const rows = [...popup.querySelectorAll('.embed-editor_varpicker-item')].map((row) => {
           const name = row.querySelector('.embed-editor_varpicker-item-name');
           const value = row.querySelector('.embed-editor_varpicker-item-value');
           return {
             selected: row.classList.contains('is-selected'),
             card: (row.closest('.embed-editor_varpicker-family') || row.closest('.embed-editor_varpicker-group')) === null ? -1 : [...document.querySelectorAll('.embed-editor_varpicker-family, .embed-editor_varpicker-group')].indexOf(row.closest('.embed-editor_varpicker-family') || row.closest('.embed-editor_varpicker-group')),
             rect: row.getBoundingClientRect().toJSON(),
             nameCut: name.scrollWidth > name.clientWidth + 1,
             nameWidth: name.getBoundingClientRect().width,
             name: { size: css(name).fontSize, weight: css(name).fontWeight, color: css(name).color },
             value: { size: css(value).fontSize, weight: css(value).fontWeight, family: css(value).fontFamily, color: css(value).color, overflow: css(value).textOverflow },
             background: css(row).backgroundColor,
           };
         });
         const headings = [...popup.querySelectorAll('.embed-editor_varpicker-family-name, .embed-editor_varpicker-group-name')].map((node) => ({
           size: css(node).fontSize, weight: css(node).fontWeight, paddingBottom: css(node).paddingBottom,
         }));
         const collection = popup.querySelector('.embed-editor_varpicker-collection-name');
         return { rows, headings, collection: { size: css(collection).fontSize, weight: css(collection).fontWeight },
           popup: { background: css(popup).backgroundColor, height: popup.getBoundingClientRect().height }, rem: parseFloat(css(document.documentElement).fontSize),
           list: (() => { const l = popup.querySelector('.embed-editor_varpicker-list'); return { scrollHeight: l.scrollHeight, clientHeight: l.clientHeight }; })() };
       })()\`;
       const results = {};
       for (const name of ['font', 'color', 'length']) {
         await js('window.__show(null)');
         await wait(400);
         await js('window.__show(' + JSON.stringify(name) + ')');
         for (let tries = 0; tries < 40; tries += 1) {
           if (await js("document.querySelector('.embed-editor_varpicker')?.dataset.popupPhase === 'open'")) break;
           await wait(50);
         }
         await wait(150);
         results[name] = await js(measure);
         const image = await win.webContents.capturePage();
         fs.writeFileSync(${JSON.stringify(directory)} + '/' + name + '.png', image.toPNG());
       }
       console.log(JSON.stringify(results));
       app.quit();
     });`,
  );
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000, env });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  const failures = [];
  let checked = 0;
  const check = (what, condition, detail) => {
    checked += 1;
    if (!condition) {
      failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
    }
  };
  if (!line) {
    console.error(`variable-picker-look: the probe did not run\n${(run.stderr || run.stdout || '').slice(0, 600)}`);
    process.exit(1);
  }
  const channels = (color) => (/rgba?\(([^)]+)\)/.exec(color)?.[1] ?? '0,0,0').split(',').map((part) => Number.parseFloat(part));
  const over = (top, bottom) => {
    const [red, green, blue, alpha = 1] = channels(top);
    const [underRed, underGreen, underBlue] = channels(bottom);
    return [red * alpha + underRed * (1 - alpha), green * alpha + underGreen * (1 - alpha), blue * alpha + underBlue * (1 - alpha)];
  };
  const luminance = ([red, green, blue]) => {
    const linear = (value) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  };
  const contrast = (foreground, background) => {
    const [first, second] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
    return (first + 0.05) / (second + 0.05);
  };
  for (const [name, view] of Object.entries(JSON.parse(line))) {
    const rem = view.rem;
    check(`${name}: the popover fits the 18rem cap`, view.popup.height / rem <= 18.01, `${view.popup.height / rem}rem`);
    for (const row of view.rows) {
      check(`${name}: a row is 1.75 to 2rem tall`, row.rect.height / rem >= 1.749 && row.rect.height / rem <= 2.001, `${row.rect.height / rem}rem`);
      check(`${name}: the name is 0.8125rem at weight 500`, row.name.size === '13px' && row.name.weight === '500', JSON.stringify(row.name));
      check(
        `${name}: the value is 0.6875rem mono at weight 400`,
        row.value.size === '11px' && row.value.weight === '400' && /mono|menlo|courier|consolas/i.test(row.value.family),
        JSON.stringify(row.value),
      );
      check(
        `${name}: a name is cut only when it reaches 60% of the row`,
        !row.nameCut || row.nameWidth >= 0.55 * row.rect.width,
        `${row.nameWidth} of ${row.rect.width}`,
      );
      check(`${name}: a long value ends in an ellipsis`, row.value.overflow === 'ellipsis');
      const base = channels(view.popup.background);
      const onRow = over(row.background, base);
      check(
        `${name}: the value clears 4.5:1${row.selected ? ' on the selected row' : ''}`,
        contrast(over(row.value.color, onRow), onRow) >= 4.5,
        contrast(over(row.value.color, onRow), onRow).toFixed(2),
      );
    }
    const cards = new Map();
    for (const row of view.rows) {
      cards.set(row.card, [...(cards.get(row.card) ?? []), row]);
    }
    for (const [card, rows] of cards) {
      for (let index = 1; index < rows.length; index += 1) {
        const gap = rows[index].rect.top - rows[index - 1].rect.bottom;
        check(`${name}: card ${card}: 0.125rem between rows`, Math.abs(gap - 0.125 * rem) < 0.6, String(gap));
      }
    }
    for (const heading of view.headings) {
      check(
        `${name}: a heading is 0.75rem with room beneath`,
        heading.size === '12px' && Number.parseFloat(heading.paddingBottom) >= 0.5 * rem - 0.1,
        JSON.stringify(heading),
      );
    }
    check(
      `${name}: the file heading is 0.8125rem at 600`,
      view.collection.size === '13px' && view.collection.weight === '600',
      JSON.stringify(view.collection),
    );
  }
  if (failures.length > 0) {
    console.error(`variable-picker-look: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`variable-picker-look: ${checked} passed  [real layout, PNGs in node_modules/.stacki-test/picker-look]`);
})();
