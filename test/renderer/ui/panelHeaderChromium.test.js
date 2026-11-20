// Goal: every side panel's heading row has the same geometry, so a panel with a short header (Git, Settings) can
// never again sit a few pixels higher, further in or closer to its content than Navigator. At 260px and 340px
// wide, for every heading the app draws, the test asserts: one header height (the --panel-header-height token),
// one title centre y inside it, one title left edge, one right inset for the actions, the first content block
// starting exactly where the header ends, and a body of rows keeping --panel-content-offset above its first row.
// A detail view's back chevron and title (Settings' Secrets view, Collections' item view, a remote CMS with a logo)
// share one left edge between them, and the AI chat's own header follows the same row.
//
//   node test/renderer/ui/panelHeaderChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out the flex rows. A harness bundles the real
// styles.css and mounts, inside a `.panel.left` of the width under test: the real Git panel (HistoryPanel), the
// real Settings shell (its list and its Secrets view, entered by clicking the row), the real Audits panel, and the
// shared PanelHeader in every shape the other panels give it (title only, one, two and four actions, a pill in
// the title, the Assets source switcher, a back chevron, a chevron with a logo). The panels that need the app's
// IPC bridges to draw at all (Pages, Navigator, Components, Assets, Collections, Variables, Selectors, Apps,
// Code) are held by the second half of the test: each of their sources must draw its heading through
// PanelHeader, and no stylesheet but panelHeader.css may set the header's geometry. Desktop's themes share every
// measure here (they differ in colour only), so one theme is measured. A deliberate "old layout" case, the
// header as Git and Settings drew it before (padding only, no row height), must be measured as different, which
// proves the assertions can fail. Every wait is for a condition, polled once per animation frame, bounded.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const WIDTHS_PX = [260, 340];
const PANE_HEIGHT_PX = 700;
// Sub-pixel layout rounds; a difference below this is the same pixel.
const TOLERANCE_PX = 0.01;

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/features/assets/hostedMedia.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from ${JSON.stringify(repoPath('src/lib/i18n/LocaleProvider.tsx'))};
import { PanelHeader } from ${JSON.stringify(repoPath('src/ui/PanelHeader.tsx'))};
import HistoryPanel from ${JSON.stringify(repoPath('src/features/history/HistoryPanel.tsx'))};
import ProjectSettingsShell from ${JSON.stringify(repoPath('src/features/projectSettings/ProjectSettingsShell.tsx'))};
import AuditsPanel from ${JSON.stringify(repoPath('src/features/audits/AuditsPanel.tsx'))};
import { updateAuditState } from ${JSON.stringify(repoPath('src/features/audits/auditStore.ts'))};
import { EMPTY_AUDIT_IGNORES } from ${JSON.stringify(repoPath('shared/properties/auditIgnores.ts'))};

const h = React.createElement;
const ghost = (label) => h('button', { className: 'ghost', 'aria-label': label, title: label }, h('svg', { width: 14, height: 14, viewBox: '0 0 14 14' }, h('circle', { cx: 7, cy: 7, r: 5 })));
const row = h('div', { className: 'panel-body' }, h('button', { className: 'list-item', type: 'button' }, 'A row'));
const search = h('div', { style: { padding: '0 12px 8px' } }, h('input', { type: 'text', placeholder: 'Search' }));
const noop = () => {};
// The header as Git and Settings drew it before this change: padding and an h2, no row height, no tokens.
const oldLayout = h('div', { className: 'old-header', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 12px 8px', flexShrink: 0 } }, h('h2', { style: { fontSize: '11.5px', fontWeight: 600 } }, 'Git'));

const shape = (name, headerProps, below) => ({ name, node: () => h('div', { className: 'panel-section grow' }, h(PanelHeader, headerProps), below) });
const shapes = [
  shape('title only', { title: 'Navigator' }, search),
  shape('one action', { title: 'Navigator', actions: ghost('Collapse') }, search),
  shape('two actions', { title: 'Audits', actions: h(React.Fragment, null, ghost('Again'), ghost('Options')) }, row),
  shape('four actions', { title: 'Pages', actions: h(React.Fragment, null, h('button', { className: 'asset-select-link' }, 'Select'), ghost('Folder'), ghost('New')) }, search),
  shape('title with a pill', { title: h(React.Fragment, null, 'Audits', h('span', { className: 'audits-pill' }, '12')), titleClassName: 'audits-heading', actions: ghost('Again') }, row),
  shape('source switcher', { title: h('button', { className: 'dd-trigger asset-source-switch', type: 'button' }, h('span', { className: 'dd-icon' }, h('svg', { width: 13, height: 13 })), 'Assets'), titleClassName: 'asset-source-heading', actions: ghost('Upload') }, search),
  shape('back and title', { title: 'Team settings', back: { label: 'Back', onBack: noop }, actions: ghost('More') }, row),
  shape('back, logo and title', { title: 'Sanity', back: { label: 'Back', onBack: noop }, lead: h('span', { className: 'remote-cms-logo' }, h('svg', { width: 14, height: 14 })), actions: ghost('New') }, row),
];
const old = { name: 'old layout', node: () => h('div', { className: 'panel-section grow' }, oldLayout, search) };

const fix = { check: 'link-broken', file: 'src/pages/index.astro', fileKind: 'page', element: { path: [0], tag: 'a', line: 1 }, detail: '', source: 'static', fix: undefined, id: 'x:1' };
const auditProps = {
  project: { path: '/fixture', name: 'fixture' }, fixDeps: () => ({}), onReveal: noop, onHover: noop, onCreatePage: noop, routes: [], showToast: noop,
  measure: () => ({ projectPath: '/fixture', devUrl: undefined, current: undefined, pages: [] }), sources: () => ({ current: undefined, all: [] }), onConfigure: noop,
};
const real = [
  { name: 'Git (real HistoryPanel)', node: () => h(HistoryPanel, { project: { path: '/fixture' }, gitInfo: undefined, controls: undefined, previewRef: undefined, onPreviewCommit: noop, onExitPreview: noop, onRestoreFile: noop, onRestoreProject: noop }) },
  { name: 'Settings (real shell, list)', node: () => h(ProjectSettingsShell, { projectKey: '/fixture', views: ['secrets', 'mcp', 'instructions'], renderView: () => h('div', { className: 'props-empty' }, 'View'), refreshable: false }) },
  { name: 'Settings (real shell, Secrets view)', node: () => h(ProjectSettingsShell, { projectKey: '/fixture', views: ['secrets', 'mcp', 'instructions'], renderView: () => h('div', { className: 'props-empty' }, 'View'), refreshable: false }), enter: '.settings-link' },
  { name: 'Audits (real panel)', node: () => h(AuditsPanel, auditProps) },
];
const cases = [...real, ...shapes];
window.caseNames = cases.map((entry) => entry.name);
window.oldName = old.name;
window.mount = (name, widthPx) => {
  const entry = name === old.name ? old : cases.find((each) => each.name === name);
  updateAuditState(() => ({
    scope: 'site', report: { scope: 'site', findings: [fix], files: 1, unreadable: 0, skipped: 0, rendered: { state: 'off' }, checkedAt: 0, trees: new Map() }, running: false,
    ignores: { source: undefined, value: { ...EMPTY_AUDIT_IGNORES } }, problem: undefined, request: 0, performance: { running: false, results: [], findings: [], problem: undefined }, progress: undefined, projectPath: '/fixture',
  }));
  window.root?.unmount();
  document.documentElement.lang = '';
  const host = document.getElementById('host');
  host.innerHTML = '<div id="root" class="panel left" style="width:' + widthPx + 'px;height:${PANE_HEIGHT_PX}px"></div>';
  window.root = createRoot(document.getElementById('root'));
  window.root.render(h(LocaleProvider, { languageTags: ['en'] }, entry.node()));
  window.entry = entry;
};
window.until = (condition, framesMax = 600) => new Promise((resolve) => {
  let frames = 0;
  const tick = () => {
    let value;
    try { value = condition(); } catch { value = undefined; }
    if (value) { resolve(value); return; }
    frames += 1;
    if (frames > framesMax) { resolve(false); return; }
    requestAnimationFrame(tick);
  };
  tick();
});
`;

// Page-side measurement: every number is read from layout.
const STEPS = `
window.measure = async () => {
  const drawn = await window.until(() => document.documentElement.lang === 'en' && document.querySelector('.panel-header, .old-header, .settings-link'));
  if (!drawn) { return { drawn: false }; }
  if (window.entry.enter) {
    document.querySelector(window.entry.enter).click();
    await window.until(() => document.querySelector('.panel-header-back'));
  }
  await window.until(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
  const panel = document.getElementById('root');
  const header = panel.querySelector('.panel-header, .old-header');
  const title = header.querySelector('h2');
  const range = document.createRange();
  // The title's first drawn thing: its text, or the icon of a heading that is a control (the Assets source switcher,
  // whose padding is pulled back so the icon sits where a plain title's text does).
  const icon = title.querySelector('.dd-icon');
  range.selectNodeContents(title);
  const textBox = icon === null ? range.getBoundingClientRect() : icon.getBoundingClientRect();
  const box = (element) => element.getBoundingClientRect();
  const panelBox = box(panel);
  const headerBox = box(header);
  const buttons = [...header.querySelectorAll(':scope > .panel-header-actions button, :scope > .panel-header-actions > *')].filter((element) => box(element).width > 0);
  const actionsRight = buttons.length === 0 ? undefined : Math.max(...buttons.map((element) => box(element).right));
  const back = header.querySelector('.panel-header-back');
  let firstBlock = header.nextElementSibling;
  while (firstBlock !== null && firstBlock.className.toString().includes('tooltip')) { firstBlock = firstBlock.nextElementSibling; }
  const body = [...panel.querySelectorAll('.panel-body')].find((element) => element.querySelector('.list-item, .settings-link'));
  const firstRow = body && body.querySelector('.list-item, .settings-link');
  const root = getComputedStyle(document.documentElement);
  return {
    drawn: true,
    headerHeight: headerBox.height,
    titleCentreY: box(title).top + box(title).height / 2 - headerBox.top,
    titleLeft: textBox.left - panelBox.left,
    backLeft: back === null ? undefined : box(back).left - panelBox.left,
    actionsInset: actionsRight === undefined ? undefined : headerBox.right - actionsRight,
    contentGap: firstBlock === null ? undefined : box(firstBlock).top - headerBox.bottom,
    bodyOffset: firstRow === undefined ? undefined : box(firstRow).top - box(body).top,
    tokenHeight: parseFloat(root.getPropertyValue('--panel-header-height')),
    tokenOffset: parseFloat(root.getPropertyValue('--panel-content-offset')),
    hasBack: back !== null,
    titleFont: getComputedStyle(title).fontSize + '/' + getComputedStyle(title).fontWeight,
  };
};
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#111}</style></head>' +
  '<body><div id="host"></div><script src="/harness.js"></script><script src="/steps.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 700, height: ${PANE_HEIGHT_PX}, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { cases: [], error: undefined };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    const names = [...(await host('window.caseNames')), await host('window.oldName')];
    for (const width of ${JSON.stringify(WIDTHS_PX)}) {
      for (const name of names) {
        await host('window.mount(' + JSON.stringify(name) + ', ' + width + ')');
        output.cases.push({ name, width, measured: await host('window.measure()') });
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(DIRECTORY, 'header-' + width + '-' + name.replace(/[^a-z0-9]+/gi, '-') + '.png'), image.toPNG());
      }
    }
  } catch (error) {
    output.error = String(error && error.stack || error);
  }
  console.log('RESULT ' + JSON.stringify(output));
  server.close();
  app.exit(0);
});
`;

function sameWithin(values) {
  return values.length === 0 || Math.max(...values) - Math.min(...values) <= TOLERANCE_PX;
}

// What every header must share. `reference` is the set of headers that are measured, never the old layout.
function check(output) {
  const failures = [];
  const expect = (what, ok, detail) => {
    if (!ok) {
      failures.push(`${what}${detail === undefined ? '' : `\n    ${JSON.stringify(detail)}`}`);
    }
  };
  const oldName = output.cases.find((entry) => entry.measured.drawn && entry.name === 'old layout')?.name;
  for (const width of WIDTHS_PX) {
    const current = output.cases.filter((entry) => entry.width === width && entry.name !== 'old layout');
    const old = output.cases.find((entry) => entry.width === width && entry.name === 'old layout');
    const where = `at ${width}px`;
    for (const entry of current) {
      expect(`${where}: ${entry.name} is drawn`, entry.measured.drawn === true);
    }
    const drawn = current.filter((entry) => entry.measured.drawn);
    const measured = drawn.map((entry) => entry.measured);
    expect(
      `${where}: one header height, the token's`,
      sameWithin(measured.map((each) => each.headerHeight)) && measured.every((each) => Math.abs(each.headerHeight - each.tokenHeight) <= TOLERANCE_PX),
      drawn.map((entry) => [entry.name, entry.measured.headerHeight, entry.measured.tokenHeight]),
    );
    expect(
      `${where}: one title centre y inside the header`,
      sameWithin(measured.map((each) => each.titleCentreY)),
      drawn.map((entry) => [entry.name, entry.measured.titleCentreY]),
    );
    expect(
      `${where}: one title type size and weight`,
      new Set(measured.map((each) => each.titleFont)).size === 1,
      drawn.map((entry) => [entry.name, entry.measured.titleFont]),
    );
    const plain = drawn.filter((entry) => !entry.measured.hasBack);
    expect(
      `${where}: one title left edge on a panel's own list`,
      sameWithin(plain.map((entry) => entry.measured.titleLeft)),
      plain.map((entry) => [entry.name, entry.measured.titleLeft]),
    );
    const detail = drawn.filter((entry) => entry.measured.hasBack);
    expect(
      `${where}: one chevron left edge on a detail view`,
      sameWithin(detail.map((entry) => entry.measured.backLeft)),
      detail.map((entry) => [entry.name, entry.measured.backLeft]),
    );
    const textDetail = detail.filter((entry) => entry.name !== 'back, logo and title');
    expect(
      `${where}: one title left edge beside a detail view's chevron`,
      sameWithin(textDetail.map((entry) => entry.measured.titleLeft)),
      textDetail.map((entry) => [entry.name, entry.measured.titleLeft]),
    );
    const withActions = drawn.filter((entry) => entry.measured.actionsInset !== undefined);
    expect(
      `${where}: one right inset for the actions`,
      sameWithin(withActions.map((entry) => entry.measured.actionsInset)),
      withActions.map((entry) => [entry.name, entry.measured.actionsInset]),
    );
    expect(
      `${where}: the first content block starts where the header ends`,
      measured.every((each) => each.contentGap === 0),
      drawn.map((entry) => [entry.name, entry.measured.contentGap]),
    );
    const rows = drawn.filter((entry) => entry.measured.bodyOffset !== undefined);
    expect(
      `${where}: a body of rows keeps the content offset above its first row`,
      rows.every((entry) => Math.abs(entry.measured.bodyOffset - entry.measured.tokenOffset) <= TOLERANCE_PX),
      rows.map((entry) => [entry.name, entry.measured.bodyOffset, entry.measured.tokenOffset]),
    );
    // The assertions must be able to fail: the old Git and Settings layout is shorter and sits higher.
    expect(`${where}: the old layout is drawn`, old !== undefined && old.measured.drawn === true);
    if (old !== undefined && old.measured.drawn === true && drawn.length > 0) {
      expect(
        `${where}: the old layout differs in header height, so the height assertion can fail`,
        Math.abs(old.measured.headerHeight - drawn[0].measured.headerHeight) > 1,
        old.measured.headerHeight,
      );
      expect(
        `${where}: the old layout differs in title centre, so the centre assertion can fail`,
        Math.abs(old.measured.titleCentreY - drawn[0].measured.titleCentreY) > 1,
        old.measured.titleCentreY,
      );
    }
  }
  expect('the old layout was measured', oldName === 'old layout');
  return failures;
}

// The panels that cannot be mounted without the app's bridges still have to use the one component, and no
// stylesheet but panelHeader.css may give the header a geometry of its own.
function checkSources() {
  const failures = [];
  const roots = ['src', 'studio/src'];
  const files = [];
  // An explicit stack with a stated bound: no recursion, and a runaway tree fails loudly.
  const pending = [...roots];
  for (let visited = 0; pending.length > 0; visited += 1) {
    if (visited > 5000) {
      throw new Error('panelHeaderChromium: the source walk visited more than 5000 directories');
    }
    const directory = pending.pop();
    for (const entry of fs.readdirSync(repoPath(directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(relative);
      } else if (/\.(tsx|css)$/.test(entry.name)) {
        files.push(relative);
      }
    }
  }
  const GEOMETRY = /\b(padding|height|min-height|margin|gap|justify-content|align-items|flex-direction)\s*:/;
  for (const file of files) {
    if (file === 'src/ui/PanelHeader.tsx' || file === 'src/ui/panelHeader.css') {
      continue;
    }
    const text = fs.readFileSync(repoPath(file), 'utf8');
    if (file.endsWith('.tsx') && /className=["'{`][^"'}`]*\bpanel-header\b/.test(text) && /className=["']panel-header["']/.test(text)) {
      failures.push(`${file} draws its own className="panel-header"; use PanelHeader (src/ui/PanelHeader.tsx)`);
    }
    if (file.endsWith('.css')) {
      for (const block of text.matchAll(/([^{}]*\.panel-header(?:-lead|-actions)?\b[^{}]*)\{([^}]*)\}/g)) {
        const selector = block[1].trim();
        const hasGeometry = GEOMETRY.test(block[2]);
        // A rule that only restyles a control inside the header (colour, font) is fine; geometry on the row is not.
        const targetsRow = /(^|,)\s*[^,]*\.panel-header(-lead|-actions)?\s*(,|$)/.test(selector) || /\.panel-header\s*$/.test(selector);
        if (hasGeometry && targetsRow) {
          failures.push(`${file}: "${selector.split('\n').pop().trim()}" sets the panel header's geometry; change panelHeader.css instead`);
        }
      }
    }
  }
  const required = [
    'src/features/pages/PagesPanel.tsx',
    'src/features/structure/StructurePanel.tsx',
    'src/features/palette/PalettePanel.tsx',
    'src/features/assets/AssetsPanel.tsx',
    'src/features/cms/CmsPanel.tsx',
    'src/features/variables/VariablesPanel.tsx',
    'src/features/selectors/SelectorsPanel.tsx',
    'src/features/apps/AppsPanel.tsx',
    'src/features/code/CodePanel.tsx',
    'src/features/history/HistoryPanel.tsx',
    'src/features/projectSettings/ProjectSettingsShell.tsx',
    'src/features/audits/AuditsPanel.tsx',
    'studio/src/features/history/GitPanel.tsx',
    'studio/src/features/settings/LockedSettings.tsx',
    'studio/src/features/pages/PagesPanel.tsx',
    'studio/src/features/code/CodePanel.tsx',
  ];
  for (const file of required) {
    if (!/<PanelHeader\b/.test(fs.readFileSync(repoPath(file), 'utf8'))) {
      failures.push(`${file} does not draw its heading with PanelHeader`);
    }
  }
  return failures;
}

(async () => {
  const failures = checkSources();
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('panel-header-chromium: layout skipped  [needs the Electron binary]');
  } else {
    const directory = repoPath('node_modules/.stacki-test/panel-header-chromium');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    buildSync({
      stdin: { contents: HARNESS, resolveDir: repoPath('.'), loader: 'tsx', sourcefile: 'harness.tsx' },
      bundle: true,
      outfile: path.join(directory, 'harness.js'),
      platform: 'browser',
      format: 'iife',
      logLevel: 'silent',
      loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    fs.writeFileSync(path.join(directory, 'steps.js'), STEPS);
    fs.writeFileSync(path.join(directory, 'host.html'), HOST);
    const probe = path.join(directory, 'probe.js');
    fs.writeFileSync(probe, PROBE(directory));
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 240_000, env: environment, maxBuffer: 64 * 1024 * 1024 });
    const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
    if (line === undefined) {
      failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
    } else {
      const output = JSON.parse(line.slice('RESULT '.length));
      if (output.error !== undefined) {
        failures.push(`the probe ran to the end\n    ${output.error}`);
      } else {
        failures.push(...check(output));
      }
    }
  }
  if (failures.length > 0) {
    console.error(`panel-header-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('panel-header-chromium: passed');
  }
})();
