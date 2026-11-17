// Goal: every row of the link field's "Choose a page…" menu is one row: the icon at the left, centred beside a two-line text
// block (title above, route below), the check at the end, and all rows one height. The bug this holds shut: the stacked menu's
// grid had no column for an icon, so the page icon fell onto a third line under the route. It also pins that a row a CMS
// template renders draws the CMS icon and a page file draws the page icon, that the template's group heading stays a muted,
// unclickable heading, and that a stacked menu with no icons (the commit type picker) still starts its labels at the left.
// Method: jsdom has no layout, so this bundles the real LinkPageChooser and Dropdown for the browser, mounts them under the
// app's real stylesheets in a hidden Electron window (as titleBarButtonHeights.test.js does), opens each menu, and compares
// getBoundingClientRect boxes. Each read waits, bounded, for the menu to be drawn and settled, never a fixed pause.
// With STACKI_LAYOUT_SHOT set to a file path, the probe also saves a screenshot of the open page menu there.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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

const SHEETS = ['src/features/style/tokens.css', 'src/app/styles.css', 'src/ui/popup.css', 'src/ui/dropdown.css', 'src/ui/skeleton.css'];

const ENTRY = `
import { createRoot } from 'react-dom/client';
import LinkPageChooser from ${JSON.stringify(repoPath('src/features/props/LinkPageChooser.tsx'))};
import Dropdown from ${JSON.stringify(repoPath('src/ui/Dropdown.tsx'))};
import { linkEntriesFromAnswer } from ${JSON.stringify(repoPath('src/features/props/linkEntries.ts'))};

const page = (name, route, title) => ({ path: '/site/src/pages/' + name, name, route, title });
const pages = [
  page('index.astro', '/', undefined),
  page('404.astro', '/404', 'Page not found'),
  page('about/long.astro', '/about/long', 'A page whose title runs far past the width of the window, so the menu cannot grow to fit it and must clip it with an ellipsis'),
  page('posts/[slug].astro', '/posts/[slug]', undefined),
];
const entry = (slug) => ({ route: '/posts/' + slug, label: slug, props: undefined });
const loadEntries = async (route) => linkEntriesFromAnswer(route, { entries: [entry('1'), entry('2')] });
const plain = [
  { value: 'feat', label: 'feat', description: 'A new feature' },
  { value: 'fix', label: 'fix', description: 'A bug fix', hint: 'F' },
];
createRoot(document.getElementById('root')).render(
  <div style={{ display: 'flex', gap: 24, width: 520 }}>
    <div className="chooser" style={{ width: 220 }}>
      <LinkPageChooser text="/404" pages={pages} loadEntries={loadEntries} onPick={() => {}} />
    </div>
    <div className="plain" style={{ width: 220 }}>
      <Dropdown value="feat" options={plain} optionLayout="stacked" menuClassName="plain-menu" livePreview={false} onChange={() => {}} />
    </div>
  </div>,
);
`;

const PROBE = `const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
const { MOTION_SETTLED_EXPRESSION, pollUntil, waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
process.on('unhandledRejection', (error) => {
  console.error('probe failed: ' + String((error && error.stack) || error));
  app.exit(1);
});
const MEASURE = \`((popupSelector) => {
  const popup = document.querySelector(popupSelector);
  const box = (element) => {
    if (!element) {
      return undefined;
    }
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
  };
  const rows = [...popup.querySelectorAll('.dd-option')].map((row) => {
    const label = row.querySelector('.dd-option-label');
    return {
      row: box(row),
      icon: box(row.querySelector('.dd-icon')),
      iconSymbol: row.querySelector('.dd-icon svg') ? row.querySelector('.dd-icon svg').innerHTML : '',
      label: box(label),
      labelText: label.textContent,
      labelClips: label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis',
      description: box(row.querySelector('.dd-description')),
      hint: box(row.querySelector('.dd-hint')),
      check: box(row.querySelector('.dd-check')),
      checked: row.querySelector('.dd-check svg') !== null,
      group: row.previousElementSibling && row.previousElementSibling.classList.contains('dd-group-label') ? row.previousElementSibling.textContent : '',
    };
  });
  const heading = popup.querySelector('.dd-group-label');
  const list = popup.querySelector('.dd-list') || popup;
  return {
    rows,
    heading: heading ? { text: heading.textContent, cursor: getComputedStyle(heading).cursor, color: getComputedStyle(heading).color, marginTop: getComputedStyle(heading).marginTop } : undefined,
    rowColor: rows.length > 0 ? getComputedStyle(popup.querySelector('.dd-option')).color : '',
    gutter: getComputedStyle(list).scrollbarGutter,
  };
})\`;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 520, backgroundColor: '#191919' });
  await win.loadURL('file://' + path.join(__dirname, 'index.html'));
  await waitFor({ what: 'the triggers drawn', read: () => win.webContents.executeJavaScript("document.querySelectorAll('.dd-trigger').length"), until: (count) => count === 2 });
  const out = {};
  await win.webContents.executeJavaScript("document.querySelector('.chooser .dd-trigger').click()");
  await waitFor({
    what: 'the page menu drawn with its CMS rows',
    read: () => win.webContents.executeJavaScript("document.querySelectorAll('.dd-popup.dd-stacked .dd-option').length"),
    until: (count) => count === 5,
  });
  await pollUntil({ what: 'the page menu settled', read: () => win.webContents.executeJavaScript(MOTION_SETTLED_EXPRESSION), until: (settled) => settled });
  out.chooser = await win.webContents.executeJavaScript(MEASURE + "('.dd-popup.dd-stacked')");
  if (process.env.STACKI_LAYOUT_SHOT) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(process.env.STACKI_LAYOUT_SHOT, image.toPNG());
  }
  await win.webContents.executeJavaScript("document.querySelector('.chooser .dd-trigger').click()");
  await waitFor({ what: 'the page menu closed', read: () => win.webContents.executeJavaScript("document.querySelector('.dd-popup') === null"), until: (gone) => gone });
  await win.webContents.executeJavaScript("document.querySelector('.plain .dd-trigger').click()");
  await waitFor({ what: 'the plain menu drawn', read: () => win.webContents.executeJavaScript("document.querySelectorAll('.plain-menu .dd-option').length"), until: (count) => count === 2 });
  await pollUntil({ what: 'the plain menu settled', read: () => win.webContents.executeJavaScript(MOTION_SETTLED_EXPRESSION), until: (settled) => settled });
  out.plain = await win.webContents.executeJavaScript(MEASURE + "('.plain-menu')");
  console.log(JSON.stringify(out));
  app.quit();
});`;

// One row is laid out as one row: icon and text side by side inside the row, title over route, check at the end.
const checkRow = (menu, row) => {
  const { iconSymbol, ...boxes } = row;
  const detail = `${JSON.stringify(boxes)} icon ${iconSymbol.length > 0 ? 'drawn' : 'absent'}`;
  const name = `${menu} "${row.labelText}"`;
  check(`${name}: the title sits inside the row`, row.label.top >= row.row.top && row.label.bottom <= row.row.bottom, detail);
  check(`${name}: the route sits inside the row`, row.description.top >= row.row.top && row.description.bottom <= row.row.bottom, detail);
  check(`${name}: the title is above the route`, row.label.bottom <= row.description.top, detail);
  check(`${name}: the title and the route start at one left edge`, Math.abs(row.label.left - row.description.left) < 1, detail);
  check(`${name}: the check ends the row`, row.check.right <= row.row.right && row.check.left >= row.label.right, detail);
  if (row.icon !== undefined) {
    check(`${name}: the icon's top is within the row`, row.icon.top >= row.row.top && row.icon.top <= row.row.bottom, detail);
    check(`${name}: the icon's bottom is within the row`, row.icon.bottom <= row.row.bottom, detail);
    check(`${name}: the icon is left of the text`, row.icon.right <= row.label.left, detail);
    check(
      `${name}: the icon is centred on the text block`,
      Math.abs((row.icon.top + row.icon.bottom) / 2 - (row.label.top + row.description.bottom) / 2) < 3,
      detail,
    );
  }
};

(() => {
  const electronPath = (() => {
    try {
      return require('electron');
    } catch {
      return undefined;
    }
  })();
  if (typeof electronPath !== 'string') {
    console.log('link-page-chooser-layout: skipped  [needs a Chromium]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/link-page-chooser-layout');
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
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    `<!doctype html><meta charset=utf-8>${SHEETS.map((file) => `<link rel="stylesheet" href="file://${path.join(ROOT, file)}">`).join('')}<style>body{margin:24px;background:#191919;font-family:system-ui}*,*::before,*::after{transition:none!important;animation:none!important}</style><div id="root"></div><script defer src="entry.js"></script>`,
  );
  fs.writeFileSync(path.join(directory, 'probe.js'), PROBE);
  // The variable must be absent, not empty: on Windows an empty value still counts as set and Electron then runs as plain Node.
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [path.join(directory, 'probe.js')], { encoding: 'utf8', timeout: 120000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{'));
  if (!line) {
    check('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const { chooser, plain } = JSON.parse(line);
    const detail = JSON.stringify({ ...chooser, rows: chooser.rows.map((row) => [row.labelText, row.row]) });
    check('the page menu lists the three pages and the two CMS entries', chooser.rows.length === 5, detail);
    for (const row of chooser.rows) {
      checkRow('page menu', row);
      check(`page menu "${row.labelText}": draws an icon`, row.icon !== undefined, detail);
    }
    const heights = new Set(chooser.rows.map((row) => row.row.height));
    check('page menu: every row is one height', heights.size === 1, detail);
    check('page menu: rows are 40px', heights.has(40), detail);
    const pageRows = chooser.rows.filter((row) => row.labelText !== '1' && row.labelText !== '2');
    const cmsRows = chooser.rows.filter((row) => row.labelText === '1' || row.labelText === '2');
    check('page menu: three page rows', pageRows.length === 3, detail);
    check('page menu: two CMS rows', cmsRows.length === 2, detail);
    const pageSymbols = new Set(pageRows.map((row) => row.iconSymbol));
    const cmsSymbols = new Set(cmsRows.map((row) => row.iconSymbol));
    check('page menu: every page row draws one icon', pageSymbols.size === 1, detail);
    check('page menu: every CMS row draws one icon', cmsSymbols.size === 1, detail);
    check('page menu: the CMS icon is not the page icon', [...cmsSymbols][0] !== [...pageSymbols][0], detail);
    check('page menu: the chosen page carries the check', chooser.rows.find((row) => row.labelText === 'Page not found')?.checked === true, detail);
    check('page menu: only one row carries the check', chooser.rows.filter((row) => row.checked).length === 1, detail);
    check(
      'page menu: a long title clips with an ellipsis',
      chooser.rows.some((row) => row.labelClips),
      detail,
    );
    check('page menu: the list keeps a stable scrollbar gutter', chooser.gutter === 'stable', detail);
    check('page menu: the template heading is shown', chooser.heading?.text === 'Posts Template', detail);
    check('page menu: the heading is not a pointer target', chooser.heading?.cursor !== 'pointer', detail);
    check('page menu: the heading is muted against the rows', chooser.heading?.color !== chooser.rowColor, detail);
    const plainDetail = JSON.stringify(plain);
    for (const row of plain.rows) {
      checkRow('plain menu', row);
      check(`plain menu "${row.labelText}": draws no icon`, row.icon === undefined, plainDetail);
      check(`plain menu "${row.labelText}": the label starts at the row's padding`, row.label.left - row.row.left <= 9, plainDetail);
    }
    const hinted = plain.rows.find((row) => row.hint !== undefined);
    check(
      'plain menu: the hint sits between the text and the check',
      hinted !== undefined && hinted.hint.left >= hinted.label.right && hinted.hint.right <= hinted.check.left,
      plainDetail,
    );
  }
  if (failures.length) {
    console.error(`link-page-chooser-layout: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`link-page-chooser-layout: ${checked} passed`);
})();
