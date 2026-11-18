// Goal: in Settings > Breakpoints the Desktop card has no delete button, yet its value input and its "frame" caption sit exactly where the
// other cards' do; it holds an invisible slot (aria-hidden, not focusable, same width and gap as the delete button) in the button's place.
// Method: jsdom has no layout, so this bundles the real BreakpointsSettings, mounts it under the app's real stylesheets in a hidden
// Chromium window (as breakpointUsageLayout.test.js does) over an in-memory breakpoints file, and reads real boxes with
// getBoundingClientRect: for Desktop, Laptop, Tablet and Phone the input's left and right edges and the caption's right edge (the caption is right-aligned under the input, so its left edge follows its text)
// agree within 0.5px at three window widths (wide, mid, and narrow where the field stacks under the text) and the right padding of every
// card is equal; Desktop contains the placeholder slot. Set STACKI_SETTINGS_SHOTS to a folder to write before/after PNGs.
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

const SHEETS = [
  'src/features/style/tokens.css',
  'src/app/styles.css',
  'src/ui/popup.css',
  'src/ui/switch.css',
  'src/ui/dropdown.css',
  'src/ui/infoHint.css',
  'src/ui/skeleton.css',
  'src/app/settings/settings.css',
  'src/app/settings/breakpointsSettings.css',
  'src/app/settings/breakpointSyncDialog.css',
];

const ENTRY = `
import { createRoot } from 'react-dom/client';
import { BreakpointsSettings } from ${JSON.stringify(repoPath('src/app/settings/BreakpointsSettings.tsx'))};
import { breakpointsStore } from ${JSON.stringify(repoPath('src/ipc/projectBreakpoints.ts'))};

const place = (locator, line, overrides) => ({
  locator, start: line * 10, end: line * 10 + 5, line, before: '64rem', after: '64rem',
  beforeText: '@media (min-width: 64rem)', afterText: '@media (min-width: 64rem)',
  reason: 'exact', excluded: false, checked: true, ...overrides,
});
const FILES = [
  { rel: 'src/components/wrapper/Grid.astro', kind: 'component', digest: 'a', occurrences: [place('00000001:0', 3)] },
  { rel: 'src/pages/index.astro', kind: 'page', digest: 'b', occurrences: [place('00000002:0', 9), place('00000002:1', 14, { reason: 'inclusive', checked: false, before: '1023px' })] },
  { rel: 'src/styles/site.css', kind: 'css', digest: 'c', occurrences: [place('00000003:0', 2)] },
  { rel: 'public/legacy.html', kind: 'style', digest: 'd', occurrences: [place('00000004:0', 4)] },
];
const entries = ['laptop', 'tablet', 'phone'].map((id) => ({ id, files: FILES }));
window.avb = {
  scanBreakpointSync: async () => ({ ok: false }),
  scanBreakpointUsage: async () => ({ ok: true, usage: { entries, lumos: false, truncated: false, skipped: 0 } }),
  projectMetadata: async () => ({ ok: true, value: {} }),
};
const source = JSON.stringify({ version: 3, breakpoints: [{ id: 'laptop', direction: 'down', value: 64, unit: 'rem' }, { id: 'tablet', direction: 'down', value: 48, unit: 'rem' }, { id: 'phone', direction: 'down', value: 30, unit: 'rem' }] });
breakpointsStore('layout', { read: async () => ({ source }), write: async ({ source: next }) => ({ source: next }) });
const dialog = document.createElement('dialog');
dialog.className = 'popup-dialog';
document.body.append(dialog);
createRoot(dialog).render(
  <div className="app-settings" style={{ position: 'relative', display: 'block' }}>
    <div className="app-settings-layout">
      <nav className="app-settings-sidebar"><h2>Settings</h2><div className="app-settings-tabs"><button role="tab" aria-selected="true">Breakpoints</button></div></nav>
      <div className="app-settings-main">
        <header className="app-settings-header"><h3>Breakpoints</h3></header>
        <div className="app-settings-scroll"><div className="app-settings-content"><div className="app-settings-panel"><BreakpointsSettings projectPath="layout" onOpenFile={() => {}} /></div></div></div>
      </div>
    </div>
  </div>,
);
dialog.showModal();
`;

const PROBE = `const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
const { MOTION_SETTLED_EXPRESSION, pollUntil, waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
process.on('unhandledRejection', (error) => {
  console.error('probe failed: ' + String((error && error.stack) || error));
  app.exit(1);
});
// The last width also takes the "before" shot, which removes the slot for good, so it must stay last.
const WIDTHS = [560, 720, 960];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1000 });
  await win.loadFile(path.join(__dirname, 'index.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  await waitFor({ what: 'the cards drawn', read: () => js("document.querySelectorAll('.breakpoints-card').length >= 4"), until: (drawn) => drawn });
  await pollUntil({ what: 'the opening motion over', read: () => js(MOTION_SETTLED_EXPRESSION), until: (settled) => settled });
  const results = {};
  const shots = process.env.STACKI_SETTINGS_SHOTS;
  for (const width of WIDTHS) {
    win.setContentSize(width, 1000);
    await pollUntil({ what: 'the window ' + width + 'px wide', read: () => js('innerWidth'), until: (now) => now === width });
    await pollUntil({ what: 'motion over', read: () => js(MOTION_SETTLED_EXPRESSION), until: (settled) => settled });
    const measure = () => js(\`(() => Object.fromEntries(['desktop', 'laptop', 'tablet', 'phone'].map((id) => {
      const card = document.querySelector('[data-breakpoint="' + id + '"]');
      const box = (element) => element.getBoundingClientRect();
      const input = box(card.querySelector('.breakpoints-input'));
      const caption = box(card.querySelector('.breakpoints-canvas'));
      const slot = card.querySelector('.breakpoints-remove, .breakpoints-spacer');
      return [id, { inputLeft: input.left, inputRight: input.right, captionLeft: caption.left, captionRight: caption.right,
        paddingRight: getComputedStyle(card).paddingRight, slotTag: slot === null ? '' : slot.tagName, slotAriaHidden: slot === null ? '' : slot.getAttribute('aria-hidden'),
        slotFocusable: slot !== null && slot.tabIndex >= 0 && slot.tagName === 'BUTTON', slotWidth: slot === null ? 0 : box(slot).width,
        spacer: card.querySelector('.breakpoints-spacer') !== null, overflowsSideways: card.scrollWidth > card.clientWidth }];
    })))()\`);
    results[width] = await measure();
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, 'breakpoints-desktop-after-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      if (width === 960) {
        await js("document.querySelector('.breakpoints-spacer').remove()");
        await pollUntil({ what: 'motion over', read: () => js(MOTION_SETTLED_EXPRESSION), until: (settled) => settled });
        fs.writeFileSync(path.join(shots, 'breakpoints-desktop-before-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log(JSON.stringify(results));
  app.quit();
});`;

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('breakpoint-desktop-alignment: skipped  [needs a Chromium]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/breakpoint-desktop-alignment');
  fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(entry, ENTRY);
  buildSync({
    entryPoints: [entry],
    outfile: path.join(directory, 'entry.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(directory, 'app.css'), SHEETS.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n'));
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="app.css"><style>body{margin:0;background:#0d0d0d}*,*::before,*::after{transition:none!important}.app-settings{margin:auto}</style><script defer src="entry.js"></script>',
  );
  fs.writeFileSync(path.join(directory, 'probe.js'), PROBE);
  const { spawnSync } = require('child_process');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [path.join(directory, 'probe.js')], { encoding: 'utf8', timeout: 120000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const results = JSON.parse(line);
    const TOLERANCE_PX = 0.5;
    for (const [width, cards] of Object.entries(results)) {
      const desktop = cards.desktop;
      const detail = `${width}px ${JSON.stringify(cards)}`;
      check(`${width}px: Desktop holds the placeholder slot`, desktop.spacer === true, detail);
      check(`${width}px: the placeholder is aria-hidden`, desktop.slotAriaHidden === 'true', detail);
      check(`${width}px: the placeholder is not a button, so not focusable`, desktop.slotFocusable === false && desktop.slotTag === 'SPAN', detail);
      for (const id of ['laptop', 'tablet', 'phone']) {
        const other = cards[id];
        check(`${width}px ${id}: the input's left edge matches Desktop`, Math.abs(other.inputLeft - desktop.inputLeft) <= TOLERANCE_PX, detail);
        check(`${width}px ${id}: the input's right edge matches Desktop`, Math.abs(other.inputRight - desktop.inputRight) <= TOLERANCE_PX, detail);
        // Wide cards right-align the caption under the input (the right edges agree); a narrow window puts it beside the input (the left edges agree).
        const captionEdge = Number(width) > 760 ? 'captionRight' : 'captionLeft';
        check(`${width}px ${id}: the caption's ${captionEdge} matches Desktop`, Math.abs(other[captionEdge] - desktop[captionEdge]) <= TOLERANCE_PX, detail);
        check(`${width}px ${id}: the right padding matches Desktop`, other.paddingRight === desktop.paddingRight, detail);
        check(`${width}px ${id}: the card does not scroll sideways`, other.overflowsSideways === false, detail);
      }
      check(`${width}px: the Desktop card does not scroll sideways`, desktop.overflowsSideways === false, detail);
    }
  }
  if (failures.length) {
    console.error(`breakpoint-desktop-alignment: ${failures.length} of ${checked} failed\n${failures.slice(0, 12).join('\n')}`);
    process.exit(1);
  }
  console.log(`breakpoint-desktop-alignment: ${checked} passed  [real layout]`);
})();
