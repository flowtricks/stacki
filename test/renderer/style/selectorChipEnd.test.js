// A selector chip too long for the well shows the end of its selector, not the start.
//
//   node test/renderer/style/selectorChipEnd.test.js
//
// Goal: the chips of one nested rule share their whole beginning, so cutting from the
// end left three identical chips. They are cut from the start instead, and the
// selector's order survives that: a plain `direction: rtl` draws `:open > a::after` as
// `open > a::after:`, because the bidi algorithm moves punctuation at the ends of a run.
//
// Method: the real SelectorChips with the app's stylesheets, laid out in Electron, since
// jsdom has neither bidi nor layout. Each character's drawn box comes from a Range: their
// left edges must rise through the text, which fails on any reordering, and the ones
// inside the chip must be a suffix of the selector. Then the same chips are hovered,
// clicked and widened. Without Electron the layout half is skipped, as
// popoverDropdown.test.js does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const PANEL_WIDTH_PX = 220;
const WIDE_PANEL_WIDTH_PX = 700;
// The selectors of the user's FAQ, and shapes whose ends are all punctuation.
const SELECTORS = [
  'section.faq {details {summary {&::after}}}',
  'section.faq {details {summary {&:hover::after}}}',
  'section.faq {details {summary {:open > &::after}}}',
  ':open > section.faq details summary::after',
  'section.faq a[href="/x"]:not(.b, .c) > .d:is(.e, .f)',
];

const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail === undefined ? '' : `\n    ${detail}`}`);
  }
};

const css = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
assert.match(css, /\.embed-editor_selector-chip-text \{[^}]*direction: rtl;[^}]*text-overflow: ellipsis;/, 'the ellipsis leads');

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/selector-chip-end');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import './src/app/styles.css'
    import './src/features/style/tokens.css'
    import './src/features/style/utilities.css'
    import './src/features/style/embedEditor.css'
    import { SelectorChips } from './src/features/style/embed/SelectorPicker'
    import { classifySelector } from './src/features/style/embed/LayoutRows'

    const entries = ${JSON.stringify(SELECTORS)}.map((text) =>
      classifySelector({ text, specificity: [0, 1, 0], state: '', simple: false, fromComponent: false, key: text }),
    )
    window.picks = []
    const Panel = () => {
      const [active, setActive] = useState('')
      const select = (text) => {
        window.picks.push(text)
        setActive(text)
      }
      return (
        <div id="panel" className="embed-editor_root" style={{ width: ${PANEL_WIDTH_PX} }}>
          <div className="embed-editor_selector-well">
            <SelectorChips entries={entries} activeSelector={active} busy={false} onSelect={select} onDeselect={() => setActive('')} />
          </div>
        </div>
      )
    }
    createRoot(document.getElementById('root')).render(<Panel />)
  `;
  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'jsx' },
    outfile: path.join(buildDirectory, 'bundle.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl', '.woff2': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(buildDirectory, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><div id="root"></div><script src="bundle.js"></script>',
  );

  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('selector chip end: layout skipped, no Electron');
    return;
  }

  const measure = async (wideWidth) => {
    const chips = () => [...document.querySelectorAll('.embed-editor_selector-chip')];
    const chipBox = (chip) => {
      const cutBox = chip.querySelector('.embed-editor_selector-chip-text');
      const text = cutBox.querySelector('bdi').firstChild;
      const box = cutBox.getBoundingClientRect();
      const lefts = [];
      let shown = '';
      for (let index = 0; index < text.length; index += 1) {
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        const rect = range.getBoundingClientRect();
        lefts.push(rect.left);
        if (rect.left >= box.left && rect.right <= box.right) {
          shown += text.data[index];
        }
      }
      return { text: chip.textContent, label: chip.getAttribute('aria-label'), lefts, shown, scrollWidth: cutBox.scrollWidth, clientWidth: cutBox.clientWidth };
    };
    const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const narrow = chips().map(chipBox);

    const chip = chips()[1];
    chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await pause(650);
    const tip = document.querySelector('[role="tooltip"]');
    const tipBox = tip?.getBoundingClientRect();
    const tooltip = {
      text: tip?.querySelector('code')?.textContent,
      direction: tip === null ? undefined : getComputedStyle(tip).direction,
      inside: tipBox !== undefined && tipBox.left >= 0 && tipBox.right <= window.innerWidth,
      title: chip.getAttribute('title'),
    };
    chip.click();
    await pause(50);
    const clicked = { picks: [...window.picks], pressed: chip.getAttribute('aria-pressed'), tipGone: document.querySelector('[role="tooltip"]') === null };

    document.getElementById('panel').style.width = `${wideWidth}px`;
    await pause(50);
    const wide = chips().map(chipBox);
    return { narrow, tooltip, clicked, wide };
  };
  const measurePath = path.join(buildDirectory, 'measure.js');
  fs.writeFileSync(measurePath, `(${measure.toString()})(${WIDE_PANEL_WIDTH_PX})`);
  const scriptPath = path.join(buildDirectory, 'probe.js');
  fs.writeFileSync(
    scriptPath,
    `const { app, BrowserWindow } = require('electron');
     const fs = require('node:fs');
     app.on('window-all-closed', () => app.quit());
     app.whenReady().then(async () => {
       const win = new BrowserWindow({ show: false, width: 900, height: 600 });
       await win.loadFile(${JSON.stringify(path.join(buildDirectory, 'index.html'))});
       await new Promise((resolve) => setTimeout(resolve, 300));
       const out = await win.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(measurePath)}, 'utf8'));
       console.log(JSON.stringify(out));
       app.quit();
     });`,
  );

  const { spawnSync } = require('node:child_process');
  // Electron run as plain Node has no BrowserWindow; the gate's shell may set it.
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [scriptPath], { encoding: 'utf8', timeout: 90000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (line === undefined) {
    check('the probe ran in a browser', false, (run.stderr || run.stdout || '').slice(0, 400));
  } else {
    assertLayout(JSON.parse(line));
  }
  if (failures.length > 0) {
    console.error(`selector chip end: ${failures.length} failure(s)\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('selector chip end: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function assertLayout(out) {
  SELECTORS.forEach((selector, index) => {
    const chip = out.narrow[index];
    check(`${selector}: the whole selector stays in the DOM`, chip.text === selector, chip.text);
    check(`${selector}: and in the accessible name`, chip.label.includes(selector), chip.label);
    check(`${selector}: it is cut, which the tooltip reads`, chip.scrollWidth > chip.clientWidth, JSON.stringify([chip.scrollWidth, chip.clientWidth]));
    check(
      `${selector}: every character is drawn in order`,
      chip.lefts.every((left, at) => at === 0 || left > chip.lefts[at - 1]),
      chip.lefts.join(' '),
    );
    check(`${selector}: its end shows`, chip.shown.length >= 10 && selector.endsWith(chip.shown), chip.shown);
    check(`${selector}: and its start does not`, !chip.shown.startsWith(selector.slice(0, 4)), chip.shown);
  });
  const ends = out.narrow.slice(0, 3).map((chip) => chip.shown);
  check('chips sharing a beginning read apart', new Set(ends).size === 3, ends.join(' | '));

  check('the tooltip shows the whole selector', out.tooltip.text === SELECTORS[1], out.tooltip.text);
  check('reading left to right', out.tooltip.direction === 'ltr', out.tooltip.direction);
  check('inside the window', out.tooltip.inside);
  check('with no native title beside it', out.tooltip.title === null, out.tooltip.title);

  check('a click picks the real selector', out.clicked.picks.length === 1 && out.clicked.picks[0] === SELECTORS[1], out.clicked.picks.join(' | '));
  check('and the chip reads as picked', out.clicked.pressed === 'true', out.clicked.pressed);
  check('and the tooltip goes', out.clicked.tipGone);

  SELECTORS.forEach((selector, index) => {
    const chip = out.wide[index];
    check(`${selector}: given room, it refits whole`, chip.shown === selector && chip.scrollWidth <= chip.clientWidth, chip.shown);
  });
}
