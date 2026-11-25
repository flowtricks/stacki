// Every blue (accent) button stays blue on hover and pressed, and a disabled one stays the same blue, dimmed.
//
//   node test/renderer/app/accentButtonHover.test.js
//
// Goal: pin, in a real cascade, the bug where Settings > Breakpoints' Add button went grey on hover (the app-wide grey wash from
// controls.css beat a bare class). test/renderer/app/accentButtonStates.test.js holds the same rule at source level; this checks the
// computed colours in Chromium, for the Add button as the component names it, the shared primary variant, the other accent buttons,
// and an "on" switch.
//
// Methodology: jsdom has no cascade, so a hidden Electron window loads the app's real stylesheets over probe buttons that carry the
// classes the components use (the Add button's class list is read from its component source, so renaming it breaks this test, not the
// button). Hover and pressed are forced through the DevTools protocol (CSS.forcePseudoState), so there is no pointer and nothing
// depends on timing or the platform; transitions are off so the computed colour is the settled one. Sheets load in both orders,
// because a tie on specificity is decided by order. The wait for the page is a bounded number of frames.
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

/** The class list a component gives its Add button, read from source so the probe cannot drift from the real element. */
function addButtonClasses() {
  for (const file of ['src/app/settings/BreakpointAddCard.tsx', 'src/app/settings/BreakpointsSettings.tsx']) {
    const match = fs.readFileSync(repoPath(file), 'utf8').match(/className="([^"]*\bbreakpoints-add-confirm\b[^"]*)"/);
    if (match) {
      return match[1];
    }
  }
  return 'breakpoints-add-confirm';
}

// [name, wrapper class, button class list]; the wrapper supplies the ancestors the real rules select through.
// The AI send button is no longer an accent button: it is a plain icon button like the microphone (composer.css).
const TARGETS = [
  ['Settings > Breakpoints Add', 'breakpoints-add-actions', addButtonClasses()],
  ['a plain primary button', 'probe', 'primary'],
  ['the Apps panel Open', 'apps-row', 'apps-open primary'],
  ['the AI trust button', 'ai-gate', 'ai-primary'],
  ['the AI keep-all button', 'ai-changes-bulk', 'ai-changes-keep'],
  ['the AI permission allow', 'ai-ask-actions', 'ai-allow'],
  ['the Audits run button', 'probe', 'audits-card-button'],
  ['the merge-conflict choice', 'conflict-choice', 'on'],
  ['the loop binder primary', 'probe', 'loop-bind-button primary'],
  ['comment pins Send all', 'ai-pin-bar', 'primary ai-pin-send'],
  ['comment pin Save', 'ai-pin-tools', 'primary ai-pin-save'],
];
const SHEETS = [
  'src/app/styles.css',
  'src/app/settings/breakpointsSettings.css',
  'src/features/apps/apps.css',
  'src/features/ai/aiShell.css',
  'src/features/ai/composer/composer.css',
  'src/features/ai/transcript/diff.css',
  'src/features/ai/transcript/chrome.css',
  'src/features/ai/transcript/transcript.css',
  'src/features/audits/audits.css',
  'src/features/props/loopSettings.css',
  'src/ui/switch.css',
  'src/features/ai/pins/pins.css',
];
const BASE = ['src/features/style/tokens.css', 'src/ui/controls.css'];
const ORDERS = { 'base first': [...BASE, ...SHEETS], 'feature first': [...SHEETS.slice(1), ...BASE, SHEETS[0]] };

const BODY =
  TARGETS.map(([name, wrapper, classes], index) => {
    const button = `<button type="button" id="t${index}" class="${classes}">${name}</button>`;
    const disabled = `<button type="button" id="d${index}" class="${classes}" disabled>${name}</button>`;
    return wrapper === 'probe' ? `<div>${button}${disabled}</div>` : `<div class="${wrapper}">${button}${disabled}</div>`;
  }).join('') + '<button type="button" id="sw" class="ui-switch" role="switch" aria-checked="true"><span class="ui-switch-thumb"></span></button>';

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const COUNT = ${TARGETS.length};
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
  const win = new BrowserWindow({ show: false, width: 800, height: 600 });
  await win.loadFile(page);
  const cdp = win.webContents.debugger;
  if (!cdp.isAttached()) {
    cdp.attach('1.3');
  }
  await cdp.sendCommand('DOM.enable');
  await cdp.sendCommand('CSS.enable');
  const { root } = await cdp.sendCommand('DOM.getDocument', { depth: -1 });
  const node = async (selector) => (await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
  const force = async (selector, classes) => cdp.sendCommand('CSS.forcePseudoState', { nodeId: await node(selector), forcedPseudoClasses: classes });
  const read = (selector) => win.webContents.executeJavaScript('(() => { const s = getComputedStyle(document.querySelector(' + JSON.stringify(selector) + ')); return { fill: s.backgroundColor, opacity: s.opacity, filter: s.filter }; })()');
  const token = (name) => win.webContents.executeJavaScript(
    \`(() => { const probe = document.createElement('i'); probe.style.background = 'var(\${name})'; document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value; })()\`,
  );
  const result = { accent: await token('--accent'), accentHover: await token('--accent-hover'), accentPressed: await token('--accent-pressed'), targets: [] };
  const ids = [];
  for (let index = 0; index < COUNT; index += 1) { ids.push('#t' + index); }
  ids.push('#sw');
  for (const id of ids) {
    const rest = await read(id);
    await force(id, ['hover']);
    const hover = await read(id);
    await force(id, ['hover', 'active']);
    const pressed = await read(id);
    await force(id, ['focus', 'focus-visible']);
    const focus = await read(id);
    await force(id, []);
    result.targets.push({ id, rest, hover, pressed, focus });
  }
  for (let index = 0; index < COUNT; index += 1) {
    const rest = await read('#d' + index);
    await force('#d' + index, ['hover']);
    result.targets.push({ id: '#d' + index, rest, hover: await read('#d' + index) });
    await force('#d' + index, []);
  }
  cdp.detach();
  return result;
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
    console.log('accent-button-hover: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const pageDirectory = repoPath('node_modules/.stacki-test/accent-button-hover');
  fs.mkdirSync(pageDirectory, { recursive: true });
  for (const [orderIndex, sheets] of Object.values(ORDERS).entries()) {
    fs.writeFileSync(path.join(pageDirectory, `app-${orderIndex}.css`), sheets.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n'));
    fs.writeFileSync(
      path.join(pageDirectory, `index-${orderIndex}.html`),
      `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app-${orderIndex}.css">` +
        `<style>body{margin:0;background:#1a1a1a}*,*::before,*::after{transition:none!important}</style>${BODY}`,
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
    for (const order of Object.keys(ORDERS)) {
      checkOrder(order, results[order]);
    }
  }
  if (failures.length) {
    console.error(`accent-button-hover: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`accent-button-hover: ${checked} passed  [real layout]`);
})();

/** The three channels of a computed colour on a 0 to 255 scale; `color-mix()` computes to `color(srgb …)` in 0 to 1. */
function channels(color) {
  const scale = color.startsWith('color(srgb') ? 255 : 1;
  const values = (color.match(/[\d.]+/g) || []).slice(0, 3).map((value) => Number(value) * scale);
  return values.length === 3 ? values : [0, 0, 0];
}

/** Blue family: blue clearly dominates red and green, which no grey, white wash or neutral does. */
function isBlue(color) {
  const [red, green, blue] = channels(color);
  return blue - red > 60 && blue - green > 20;
}

function checkOrder(order, { accent, accentHover, accentPressed, targets }) {
  check(
    `${order}: the accent tokens are three distinct blues`,
    new Set([accent, accentHover, accentPressed]).size === 3 && [accent, accentHover, accentPressed].every(isBlue),
    `${accent} ${accentHover} ${accentPressed}`,
  );
  const names = [...TARGETS.map((target) => target[0]), 'an "on" switch'];
  for (const [index, target] of targets.filter((entry) => !entry.id.startsWith('#d')).entries()) {
    const name = `${order}, ${names[index]}`;
    for (const state of ['rest', 'hover', 'pressed', 'focus']) {
      const readout = target[state];
      check(`${name}: ${state} fill is blue`, isBlue(readout.fill), readout.fill);
    }
    if (target.id !== '#sw') {
      check(`${name}: hover is the brighter accent`, target.hover.fill === accentHover, `${target.hover.fill} vs ${accentHover}`);
      check(`${name}: pressed is the darker accent`, target.pressed.fill === accentPressed, `${target.pressed.fill} vs ${accentPressed}`);
    }
  }
  for (const [index, target] of targets.filter((entry) => entry.id.startsWith('#d')).entries()) {
    const name = `${order}, disabled ${names[index]}`;
    check(
      `${name}: still blue at rest and on hover, never grey`,
      isBlue(target.rest.fill) && isBlue(target.hover.fill),
      `${target.rest.fill} / ${target.hover.fill}`,
    );
    check(
      `${name}: dimmed, not repainted`,
      Number(target.hover.opacity) < 1 && target.hover.fill === target.rest.fill,
      `${target.hover.opacity} ${target.hover.fill} vs ${target.rest.fill}`,
    );
  }
}
