// A colour swatch looks the same at rest, under the pointer, pressed and focused: the checkerboard under a transparent
// or translucent colour, the colour over it, and only a focus ring added outside it.
//
//   node test/renderer/app/swatchHover.test.js
//
// Goal: pin the owner's report that the transparent swatch in Frame settings turned grey on hover. The app-wide button
// hover (controls.css) set the `background` shorthand on every button, which replaced the swatch's checkerboard with a
// grey wash. Every swatch is the shared ColorSwatch (`.u-color-swatch`), so one exclusion covers the Style panel,
// variables and the canvas panels.
//
// Methodology: as accentButtonHover.test.js does, a hidden Electron window loads the app's real stylesheets, in both
// orders, over probe swatches built as ColorSwatch builds them (a button holding a fill span: transparent, translucent
// and solid). Hover, pressed and focus are forced through the DevTools protocol, so nothing depends on a pointer or on
// timing; transitions are off. The swatch's background and its fill's are compared with their resting values.
const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const FILLS = ['transparent', 'rgba(255, 0, 0, 0.4)', 'rgb(20, 120, 220)'];
const BASE = ['src/features/style/tokens.css', 'src/ui/controls.css'];
const SHEETS = ['src/features/style/utilities.css', 'src/app/styles.css', 'src/features/preview/componentCanvas/componentCanvas.css'];
const ORDERS = { 'base first': [...BASE, ...SHEETS], 'feature first': [...SHEETS, ...BASE] };
const BODY = FILLS.map(
  (fill, index) =>
    `<div class="component-canvas-color"><button type="button" id="s${index}" class="u-color-swatch"><span class="u-color-swatch-fill" style="background:${fill}"></span></button></div>`,
).join('');

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const COUNT = ${FILLS.length};
const ORDERS = ${JSON.stringify(Object.keys(ORDERS))};
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  const results = {};
  for (const [orderIndex, order] of ORDERS.entries()) {
    results[order] = await measure(path.join(__dirname, 'index-' + orderIndex + '.html'));
  }
  console.log(JSON.stringify(results));
  app.quit();
});
async function measure(page) {
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadFile(page);
  const cdp = win.webContents.debugger;
  if (!cdp.isAttached()) cdp.attach('1.3');
  await cdp.sendCommand('DOM.enable');
  await cdp.sendCommand('CSS.enable');
  const { root } = await cdp.sendCommand('DOM.getDocument', { depth: -1 });
  const node = async (selector) => (await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
  const force = async (selector, classes) => cdp.sendCommand('CSS.forcePseudoState', { nodeId: await node(selector), forcedPseudoClasses: classes });
  const read = (selector) => win.webContents.executeJavaScript('(() => { const b = getComputedStyle(document.querySelector(' + JSON.stringify(selector) + ')); const f = getComputedStyle(document.querySelector(' + JSON.stringify(selector + ' > span') + ')); return { image: b.backgroundImage, color: b.backgroundColor, fill: f.backgroundColor, opacity: b.opacity, outline: b.outlineStyle }; })()');
  const out = [];
  for (let index = 0; index < COUNT; index += 1) {
    const id = '#s' + index;
    const rest = await read(id);
    await force(id, ['hover']);
    const hover = await read(id);
    await force(id, ['hover', 'active']);
    const pressed = await read(id);
    await force(id, ['focus', 'focus-visible']);
    const focus = await read(id);
    await force(id, []);
    out.push({ rest, hover, pressed, focus });
  }
  cdp.detach();
  return out;
}`;

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('swatch-hover: skipped  [needs a Chromium]');
    return;
  }
  const pageDirectory = repoPath('node_modules/.stacki-test/swatch-hover');
  fs.mkdirSync(pageDirectory, { recursive: true });
  for (const [orderIndex, sheets] of Object.values(ORDERS).entries()) {
    fs.writeFileSync(path.join(pageDirectory, `app-${orderIndex}.css`), sheets.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n'));
    fs.writeFileSync(
      path.join(pageDirectory, `index-${orderIndex}.html`),
      `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app-${orderIndex}.css"><style>*,*::before,*::after{transition:none!important}</style>${BODY}`,
    );
  }
  const probe = path.join(pageDirectory, 'probe.js');
  fs.writeFileSync(probe, PROBE);
  const { spawnSync } = require('child_process');
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120000 });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 500));
  } else {
    const results = JSON.parse(line);
    for (const [order, swatches] of Object.entries(results)) {
      swatches.forEach((swatch, index) => {
        const name = `${order}, a ${FILLS[index]} swatch`;
        check(`${name}: the checkerboard is drawn at rest`, /conic-gradient/.test(swatch.rest.image), swatch.rest.image);
        for (const state of ['hover', 'pressed', 'focus']) {
          for (const property of ['image', 'color', 'fill', 'opacity']) {
            check(
              `${name}: ${state} keeps its ${property}`,
              swatch[state][property] === swatch.rest[property],
              `${swatch.rest[property]} -> ${swatch[state][property]}`,
            );
          }
        }
        check(`${name}: focus shows a ring`, swatch.focus.outline !== 'none', swatch.focus.outline);
      });
    }
  }
  if (failures.length) {
    console.error(`swatch-hover: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`swatch-hover: ${checked} passed  [real layout]`);
})();
