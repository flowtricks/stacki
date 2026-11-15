// Goal: the "Used in N places · M files" line of a breakpoint card is itself the disclosure button, with its chevron right after the
// text on the same line and centered with it; the expanded list shows each file's kind as an icon (component, page, stylesheet, style
// tag) in a column of fixed width, centered on the path, with nothing scrolling sideways; the card's rhythm is the same open or closed.
// Method: jsdom has no layout, so this bundles the real BreakpointsSettings for the browser, mounts it under the app's real stylesheets in
// a hidden Chromium window (as settingsLayout.test.js does) over an in-memory breakpoints file and a stubbed `window.avb` that answers
// the usage scan with one file of each kind, and reads real boxes with getBoundingClientRect: for Laptop, Tablet, Phone and an added
// breakpoint, collapsed and expanded, the chevron's center against the text's center (within 1px), the gap between them, and the input
// column's box before and after; then the kind icons and paths of every row, at 560, 720 and 960px window widths. Set
// STACKI_SETTINGS_SHOTS to a folder to also write a PNG of the expanded card.
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
const entries = ['bp-1', 'laptop', 'tablet', 'phone'].map((id) => ({ id, files: FILES }));
window.avb = {
  scanBreakpointSync: async () => ({ ok: false }),
  scanBreakpointUsage: async () => ({ ok: true, usage: { entries, lumos: false, truncated: false, skipped: 0 } }),
  projectMetadata: async () => ({ ok: true, value: {} }),
};
const source = JSON.stringify({ version: 3, breakpoints: [{ id: 'bp-1', name: 'Large', direction: 'up', value: 100, unit: 'rem' }, { id: 'laptop', direction: 'down', value: 64, unit: 'rem' }, { id: 'tablet', direction: 'down', value: 48, unit: 'rem' }, { id: 'phone', direction: 'down', value: 30, unit: 'rem' }] });
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
// The Settings dialog is min(880px, window - 48px) wide, its sidebar moves above the page at 640px, and a card puts its field under its
// text at 760px: the windows below show each of those layouts.
const WIDTHS = [560, 720, 960];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1000 });
  await win.loadFile(path.join(__dirname, 'index.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  await waitFor({ what: 'the usage lines drawn', read: () => js("document.querySelectorAll('.breakpoints-usage-toggle').length >= 4"), until: (drawn) => drawn });
  await pollUntil({ what: 'the opening motion over', read: () => js(MOTION_SETTLED_EXPRESSION), until: (settled) => settled });
  const results = {};
  for (const width of WIDTHS) {
    win.setContentSize(width, 1000);
    await pollUntil({ what: 'the window ' + width + 'px wide', read: () => js('innerWidth'), until: (now) => now === width });
    const measure = (id) => js(\`(() => {
      const card = document.querySelector('[data-breakpoint="\${id}"]');
      const button = card.querySelector('.breakpoints-usage-toggle');
      const text = button.querySelector('.breakpoints-usage-line');
      const chevron = button.querySelector('svg');
      const range = document.createRange();
      range.selectNodeContents(text);
      const textBox = range.getBoundingClientRect();
      const chevronBox = chevron.getBoundingClientRect();
      const input = card.querySelector('.breakpoints-input').getBoundingClientRect();
      const remove = card.querySelector('.breakpoints-remove').getBoundingClientRect();
      const label = card.querySelector('.breakpoints-query').getBoundingClientRect();
      const tile = card.querySelector('.breakpoints-tile').getBoundingClientRect();
      return {
        centerGap: Math.abs((textBox.top + textBox.height / 2) - (chevronBox.top + chevronBox.height / 2)),
        textToChevron: chevronBox.left - textBox.right,
        chevronInsideCard: chevronBox.right < card.getBoundingClientRect().right - 40,
        expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls'),
        cardHeight: card.getBoundingClientRect().height, inputLeft: card.getBoundingClientRect().right - input.left, inputTop: input.top, removeLeft: card.getBoundingClientRect().right - remove.left,
        labelLeft: label.left - card.getBoundingClientRect().left, tileLeft: tile.left - card.getBoundingClientRect().left, cardWidth: card.getBoundingClientRect().width, cursor: getComputedStyle(button).cursor,
        rotation: getComputedStyle(chevron).transform,
      };
    })()\`);
    const ids = ['bp-1', 'laptop', 'tablet', 'phone'];
    const collapsed = {};
    for (const id of ids) collapsed[id] = await measure(id);
    const expanded = {};
    for (const id of ids) {
      await js(\`document.querySelector('[data-breakpoint="\${id}"] .breakpoints-usage-toggle').click()\`);
      await pollUntil({ what: id + ' list open', read: () => js(\`document.getElementById('breakpoints-usage-list-\${id}') !== null\`), until: (open) => open });
      await pollUntil({ what: 'motion over', read: () => js(MOTION_SETTLED_EXPRESSION), until: (settled) => settled });
      expanded[id] = await measure(id);
    }
    const rows = await js(\`(() => [...document.querySelectorAll('[data-breakpoint="laptop"] .breakpoint-sync-file')].map((file) => {
      const row = file.querySelector('.breakpoint-sync-row');
      const kind = file.querySelector('.breakpoint-sync-kind');
      const pathBox = file.querySelector('.breakpoint-sync-path');
      const range = document.createRange();
      range.selectNodeContents(pathBox);
      const textBox = range.getBoundingClientRect();
      const kindBox = kind.getBoundingClientRect();
      return { kind: kind.dataset.kind, label: kind.getAttribute('aria-label'), tooltip: kind.dataset.tooltip, width: kindBox.width,
        iconLeft: kindBox.left - row.getBoundingClientRect().left, centerGap: Math.abs((kindBox.top + kindBox.height / 2) - (textBox.top + textBox.height / 2)),
        svg: kind.querySelector('svg').innerHTML.length, color: getComputedStyle(kind).color, pill: file.querySelector('.breakpoint-sync-pill') !== null,
        rowRight: row.getBoundingClientRect().right, pathRight: textBox.right };
    }))()\`);
    const overflow = await js(\`(() => { const list = document.querySelector('[data-breakpoint="laptop"] .breakpoints-usage-files'); const card = document.querySelector('[data-breakpoint="laptop"]');
      return { listScrollsSideways: list.scrollWidth > list.clientWidth, cardScrollsSideways: card.scrollWidth > card.clientWidth, maxHeight: getComputedStyle(list).maxHeight, overflowX: getComputedStyle(list).overflowX,
        pageScrollsSideways: document.querySelector('.app-settings-scroll').scrollWidth > document.querySelector('.app-settings-scroll').clientWidth }; })()\`);
    results[width] = { collapsed, expanded, rows, overflow };
    const dir = process.env.STACKI_SETTINGS_SHOTS;
    if (dir && width === 720) {
      fs.mkdirSync(dir, { recursive: true });
      await js("document.querySelector('[data-breakpoint=\\"laptop\\"]').scrollIntoView({ block: 'start' }); document.querySelectorAll('[data-breakpoint=\\"laptop\\"] .breakpoint-sync-open').forEach((button) => button.click());");
      await pollUntil({ what: 'places open', read: () => js(MOTION_SETTLED_EXPRESSION), until: (settled) => settled });
      fs.writeFileSync(path.join(dir, 'breakpoint-usage-expanded.png'), (await win.webContents.capturePage()).toPNG());
    }
    for (const id of ids) await js(\`document.querySelector('[data-breakpoint="\${id}"] .breakpoints-usage-toggle').click()\`);
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
    console.log('breakpoint-usage-layout: skipped  [needs a Chromium]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/breakpoint-usage-layout');
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
    for (const [width, found] of Object.entries(results)) {
      for (const state of ['collapsed', 'expanded']) {
        for (const [id, box] of Object.entries(found[state])) {
          const where = `${width}px ${state} ${id}: ${JSON.stringify(box)}`;
          check(`${width}px ${state} ${id}: the chevron is centered on the text line (within 1px)`, box.centerGap <= 1, where);
          check(`${width}px ${state} ${id}: the chevron follows the text closely`, box.textToChevron >= 0 && box.textToChevron <= 8, where);
          check(`${width}px ${state} ${id}: the chevron is not at the card's edge`, box.chevronInsideCard === true, where);
          check(
            `${width}px ${state} ${id}: the line is a button that says whether it is open`,
            box.expanded === (state === 'expanded' ? 'true' : 'false') && box.controls === `breakpoints-usage-list-${id}`,
            where,
          );
          check(`${width}px ${state} ${id}: the line has a pointer`, box.cursor === 'pointer', where);
          if (state === 'expanded') {
            const before = found.collapsed[id];
            check(
              `${width}px ${id}: the columns do not move when the card opens`,
              box.inputLeft === before.inputLeft &&
                box.removeLeft === before.removeLeft &&
                box.labelLeft === before.labelLeft &&
                box.tileLeft === before.tileLeft,
              `${JSON.stringify(before)} -> ${JSON.stringify(box)}`,
            );
            check(`${width}px ${id}: the card only grows when it opens`, box.cardHeight > before.cardHeight, `${before.cardHeight} -> ${box.cardHeight}`);
            check(
              `${width}px ${id}: the chevron turns down`,
              box.rotation !== found.collapsed[id].rotation,
              `${found.collapsed[id].rotation} -> ${box.rotation}`,
            );
          }
        }
      }
      check(
        `${width}px: all cards have the same collapsed height`,
        new Set(Object.values(found.collapsed).map((box) => Math.round(box.cardHeight))).size === 1,
        JSON.stringify(Object.values(found.collapsed).map((box) => box.cardHeight)),
      );
      const kinds = found.rows.map((row) => row.kind);
      check(`${width}px: the files are component, page, css and style tag`, kinds.join(',') === 'component,page,css,style', kinds.join(','));
      check(
        `${width}px: the kinds are icons with their words as the tooltip and label`,
        found.rows.every((row) => row.tooltip === row.label && row.label.length > 0 && row.svg > 20 && row.pill === false),
        JSON.stringify(found.rows),
      );
      check(
        `${width}px: the labels are Component, Page, CSS file and Style tag`,
        found.rows.map((row) => row.label).join('|') === 'Component|Page|CSS file|Style tag',
        found.rows.map((row) => row.label).join('|'),
      );
      check(
        `${width}px: the icon column has one width and one place`,
        new Set(found.rows.map((row) => row.width)).size === 1 && new Set(found.rows.map((row) => Math.round(row.iconLeft))).size === 1,
        JSON.stringify(found.rows),
      );
      check(
        `${width}px: each icon is centered on its path (within 1px)`,
        found.rows.every((row) => row.centerGap <= 1),
        JSON.stringify(found.rows.map((row) => row.centerGap)),
      );
      check(
        `${width}px: the component icon is green and the others are not`,
        found.rows[0].color !== found.rows[1].color && found.rows[1].color === found.rows[2].color,
        JSON.stringify(found.rows.map((row) => row.color)),
      );
      check(`${width}px: the icons differ`, new Set(found.rows.map((row) => row.svg)).size >= 3, JSON.stringify(found.rows.map((row) => row.svg)));
      check(
        `${width}px: nothing scrolls sideways, the list scrolls vertically inside a max height`,
        !found.overflow.listScrollsSideways &&
          !found.overflow.cardScrollsSideways &&
          !found.overflow.pageScrollsSideways &&
          found.overflow.overflowX === 'hidden' &&
          found.overflow.maxHeight !== 'none',
        JSON.stringify(found.overflow),
      );
    }
  }
  if (failures.length) {
    console.error(`breakpoint-usage-layout: ${failures.length} of ${checked} failed\n${failures.slice(0, 12).join('\n')}`);
    process.exit(1);
  }
  console.log(`breakpoint-usage-layout: ${checked} passed  [real layout]`);
})();
