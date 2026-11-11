// The Apps panel's Open button is a primary accent button, and hovering it
// brightens the accent a step; it never greys out.
//
//   node test/renderer/apps/appsOpenHover.test.js
//
// Goal: pin the hover a user saw break. Hovering Open swapped its accent fill
// for the base `button:hover` rule's grey wash: `.apps-open` alone was less
// specific than that rule, so the base rule won. The fix is central (the base
// wash skips `.primary`, and `button.primary:hover` is the brighter accent) and
// local (Open carries `.primary`, and apps.css spells out its hover), so this
// checks, for the row's Open, the details header's Open, the panel's own
// primary button and a plain primary button:
//   - at rest the fill is the accent;
//   - hovered, the fill is `--accent-hover`: not the accent, not the base wash,
//     and brighter than the accent.
//
// Methodology: jsdom has no cascade, so this renders the real `AppRow` and
// `AppDetails` popup in the page, loads them under the app's stylesheets in a hidden Chromium
// window, and reads computed styles. The stylesheets load in both orders,
// because a bundle may emit a feature's sheet before styles.css, and a tie on
// specificity is then decided by order. Hover is forced through the DevTools
// protocol rather than a pointer, so nothing depends on timing; transitions are
// switched off so the computed colour is the settled one.
const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// The buttons whose hover must keep the accent, by selector.
const TARGETS = [
  { name: 'the row’s Open', selector: '.apps-row .apps-open' },
  { name: 'the details header’s Open', selector: '.apps-details-header .apps-open' },
  { name: 'the panel’s primary button', selector: '#probe-apps-primary' },
  { name: 'a plain primary button', selector: '#probe-primary' },
];

// The real row and the real details popup render in the page itself, with
// react-dom/client: the row's badge count reads an external store, and the popup
// opens a native modal dialog, neither of which a server render can do.
function writePage(pageDirectory) {
  const entry = path.join(pageDirectory, 'entry.js');
  fs.writeFileSync(
    entry,
    `import React from 'react';
     import { flushSync } from 'react-dom';
     import { createRoot } from 'react-dom/client';
     import { AppRow } from ${JSON.stringify(repoPath('src/features/apps/AppsPanel.tsx'))};
     import { AppDetails } from ${JSON.stringify(repoPath('src/features/apps/AppDetails.tsx'))};
     import { parseAppManifest } from ${JSON.stringify(repoPath('shared/properties/apps.ts'))};
     const noop = () => {};
     // No main process here: every bridge call waits forever, and every subscription is a no-op.
     window.avb = new Proxy({}, { get: (_target, name) => (String(name).startsWith('on') ? () => noop : () => new Promise(noop)) });
     // Through the manifest parser, so every field a details section reads has its parsed default.
     const raw = ${JSON.stringify(APP)};
     const app = { ...raw, manifest: parseAppManifest(raw.manifest) };
     const actions = { admin: true, busy: false, projectPath: '/p', share: noop, submit: () => noop, open: noop, showDetails: noop, setAutoUpdate: noop, update: noop, uninstall: noop };
     const root = createRoot(document.querySelector('.apps-list'));
     flushSync(() => root.render([
       React.createElement(AppRow, { key: 'row', app, avatar: undefined, actions }),
       React.createElement(AppDetails, { key: 'details', app, avatar: undefined, actions, place: { place: undefined, listed: false }, onClose: noop }),
     ]));`,
  );
  buildSync({
    entryPoints: [entry],
    outfile: path.join(pageDirectory, 'page.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return (
    '<div class="apps-panel" style="width:320px"><div class="panel-body apps-body"><ul class="apps-list"></ul>' +
    '<div class="apps-actions"><button type="button" id="probe-apps-primary" class="apps-button primary">Update</button></div></div></div>' +
    '<button type="button" id="probe-primary" class="primary">Save</button><script src="page.js"></script>'
  );
}

const APP = {
  manifest: {
    manifestVersion: 1,
    id: 'heat-map',
    name: 'Heat map',
    version: '1.0.0',
    description: 'Clicks on the canvas',
    entry: 'index.html',
    capabilities: [],
    window: { mode: 'popup', widthPx: 300, heightPx: 300 },
    settings: [],
    commands: [],
    secretsAllowlist: [],
  },
  lock: {
    id: 'heat-map',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-10T00:00:00.000Z',
    source: { kind: 'file', fileName: 'heat-map.zip' },
  },
};

// styles.css @imports controls.css (where `button.primary` lives); the pages here are concatenated, so it is inlined.
const BASE_SHEETS = ['src/features/style/tokens.css', 'src/ui/controls.css', 'src/app/styles.css'];
const FEATURE_SHEETS = ['src/features/apps/apps.css', 'src/features/apps/appDetails.css'];
const ORDERS = {
  'base first': [...BASE_SHEETS, ...FEATURE_SHEETS],
  'feature first': ['src/features/style/tokens.css', ...FEATURE_SHEETS, 'src/ui/controls.css', 'src/app/styles.css'],
};

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const TARGETS = ${JSON.stringify(TARGETS)};
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
  // The details popup opens its dialog after a frame; wait for it.
  await win.webContents.executeJavaScript('new Promise((resolve) => { const tick = () => document.querySelector(".apps-details-header .apps-open") ? resolve() : requestAnimationFrame(tick); tick(); })');
  const cdp = win.webContents.debugger;
  // The Linux preflight's slow-motion profile may already hold the protocol; share it.
  if (!cdp.isAttached()) {
    cdp.attach('1.3');
  }
  await cdp.sendCommand('DOM.enable');
  await cdp.sendCommand('CSS.enable');
  const { root } = await cdp.sendCommand('DOM.getDocument', { depth: -1 });
  const node = async (selector) => (await cdp.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
  const force = async (selector, classes) => cdp.sendCommand('CSS.forcePseudoState', { nodeId: await node(selector), forcedPseudoClasses: classes });
  const fill = (selector) => win.webContents.executeJavaScript('getComputedStyle(document.querySelector(' + JSON.stringify(selector) + ')).backgroundColor');
  const token = (name) => win.webContents.executeJavaScript(
    \`(() => { const probe = document.createElement('i'); probe.style.background = 'var(\${name})'; document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value; })()\`,
  );
  const result = { accent: await token('--accent'), accentHover: await token('--accent-hover'), wash: await token('--bg-active'), targets: {} };
  for (const target of TARGETS) {
    const rest = await fill(target.selector);
    await force(target.selector, ['hover']);
    const hover = await fill(target.selector);
    await force(target.selector, []);
    result.targets[target.name] = { rest, hover };
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
    console.log('apps-open-hover: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const pageDirectory = repoPath('node_modules/.stacki-test/apps-open-hover');
  fs.mkdirSync(pageDirectory, { recursive: true });
  const body = writePage(pageDirectory);
  for (const [orderIndex, sheets] of Object.values(ORDERS).entries()) {
    fs.writeFileSync(path.join(pageDirectory, `app-${orderIndex}.css`), sheets.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n'));
    fs.writeFileSync(
      path.join(pageDirectory, `index-${orderIndex}.html`),
      `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app-${orderIndex}.css">` +
        '<style>body{margin:0;background:#1a1a1a}*,*::before,*::after{transition:none!important}</style>' +
        body,
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
    console.error(`apps-open-hover: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`apps-open-hover: ${checked} passed  [real layout]`);
})();

/** The channels of a computed colour, summed on a 0 to 255 scale: a brighter fill sums higher. `color-mix()` computes to `color(srgb …)`, in 0 to 1. */
function brightness(color) {
  const channels = (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const scale = color.startsWith('color(srgb') ? 255 : 1;
  return channels.reduce((sum, value) => sum + value * scale, 0);
}

function checkOrder(order, { accent, accentHover, wash, targets }) {
  check(`${order}: the hover token differs from the accent`, accentHover !== accent, `${accentHover} vs ${accent}`);
  for (const target of TARGETS) {
    const { rest, hover } = targets[target.name];
    const name = `${order}, ${target.name}`;
    check(`${name}: rests on the accent`, rest === accent, rest);
    check(`${name}: hovered, it is the brighter accent`, hover === accentHover, `${hover} vs ${accentHover}`);
    check(`${name}: hovered, it is never the base grey wash`, hover !== wash, hover);
    check(`${name}: hovered, it is brighter than at rest`, brightness(hover) > brightness(rest), `${hover} vs ${rest}`);
  }
}
