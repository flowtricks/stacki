// Goal: the Roles card and its four detail views (Members, Sidebar apps, Components, Permissions) lay out whole at
// the Settings dialog's real widths: nothing is drawn past the page's right edge or scrolls sideways, the back
// button, title, role name and count share one row and one baseline, a long list scrolls inside its view (the header
// and the search stay put) with a stable scrollbar gutter and runs to the dialog's bottom edge with room after its last
// row (no empty band under it, in a tall window and a short one), the card's summary rows keep their label at the left and
// their count and chevron at one right edge, and a group switch reads mixed for a partly granted group.
//
//   node test/renderer/app/rolesDetailChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out flex, ellipsis, overflow and scrollbar
// gutters. A harness bundles the real RolesSettings and styles.css and mounts it inside the dialog's own markup
// (`.app-settings` > `.app-settings-scroll` > `.app-settings-content`) at the widths the dialog really takes (a wide
// window, a narrow one where the dialog shrinks, and a short one), over a fake metadata bridge and a generated project (never a
// real one): twenty-four members, seventy components, two installed apps. Each view is opened by clicking its card row, as a
// person does, measured, and captured as a screenshot in node_modules/.stacki-test/roles-detail-chromium/. Every wait
// is for a condition, polled once per animation frame and bounded.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

// The dialog is min(880px, 100vw - 48px) wide and min(640px, 100vh - 48px) tall: these viewports give 880px and 712px
// wide dialogs at full height, and one in a short window.
const VIEWPORTS_PX = [
  { width: 1000, height: 760 },
  { width: 760, height: 760 },
  { width: 1000, height: 520 },
];
// The room the content ends with, inside the scrolled area: comfortable, never flush with the edge, never a band.
const END_ROOM_PX = { min: 16, max: 40 };
const SECTIONS = [
  ['members', 'Members'],
  ['pins', 'Sidebar apps'],
  ['components', 'Components'],
  ['permissions', 'Permissions'],
];
// Sub-pixel layout rounds; an element this far past an edge is not overflowing.
const EDGE_TOLERANCE_PX = 1;

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import ${JSON.stringify(repoPath('src/app/settings/settings.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RolesSettings } from ${JSON.stringify(repoPath('src/app/settings/RolesSettings.tsx'))};
import { setActualRole } from ${JSON.stringify(repoPath('src/lib/currentRole.ts'))};
import { ADMIN_VIEW } from ${JSON.stringify(repoPath('shared/properties/projectRoles.ts'))};

const members = Array.from({ length: 24 }, (_, index) => 'person-with-a-long-login-' + index);
const files = [];
for (let folder = 0; folder < 8; folder += 1) {
  for (let item = 0; item < 5; item += 1) {
    files.push('src/components/group' + folder + '/Component' + folder + item + '.astro');
  }
}
for (let item = 0; item < 30; item += 1) {
  files.push('src/components/Card' + item + '.astro');
}
const app = (id, name) => ({
  manifest: {
    manifestVersion: 1, id, name, version: '1.0.0', description: 'An app.', icon: undefined, entry: 'index.html', capabilities: [],
    window: { mode: 'panel', widthPx: undefined, heightPx: undefined }, source: undefined, authorGitHub: undefined,
    permissions: [{ id: 'export', label: 'Export reports', description: undefined, default: false }, { id: 'delete', label: 'Delete entries', description: undefined, default: false }],
  },
  lock: { id, version: '1.0.0', sha256: 'a'.repeat(64), installedAt: '2026-11-01T00:00:00.000Z', source: { kind: 'file', fileName: id + '.zip' }, granted: [], pending: undefined },
});
let stored = JSON.stringify({
  version: 1,
  roles: [
    { id: 'admin', members: ['owner'] },
    { id: 'client', name: 'Timothy', members, access: ['panel:pages', 'panel:cms', 'page:create', 'panel:apps', 'app:seo'], pinnedApps: ['seo', 'crm'], componentRules: [{ kind: 'folder', path: 'src/components/group1', effect: 'hide' }] },
  ],
});
window.avb = {
  projectMetadata: async () => ({ ok: true, value: { source: stored } }),
  writeProjectMetadata: async (input) => { stored = input.write.source; return { ok: true, value: { source: stored } }; },
  rolesIdentity: async () => ({ login: 'owner' }),
  listApps: async () => ({ ok: true, value: [app('seo', 'SEO checker'), app('crm', 'CRM')] }),
};
window.until = (condition, framesMax = 300) =>
  new Promise((resolve) => {
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
window.mount = () => {
  setActualRole(ADMIN_VIEW);
  window.root?.unmount();
  document.getElementById('host').innerHTML =
    '<div class="app-settings" open style="position:relative"><div class="app-settings-layout"><nav class="app-settings-sidebar"></nav><div class="app-settings-main"><header class="app-settings-header"><h3>Roles</h3></header><div class="app-settings-scroll"><div class="app-settings-content"><div class="app-settings-panel" id="roles-panel"></div></div></div></div></div></div>';
  window.root = createRoot(document.getElementById('roles-panel'));
  window.root.render(React.createElement(RolesSettings, { projectPath: '/fixture', componentFiles: files }));
};
`;

const STEPS = `
window.steps = (() => {
  const box = (element) => element.getBoundingClientRect();
  const page = () => document.querySelector('.app-settings-content');
  const past = () => {
    const edge = box(page()).right;
    return [...page().querySelectorAll('*')]
      .filter((element) => { const rectangle = box(element); return rectangle.width > 0 && rectangle.height > 0 && rectangle.right > edge + ${EDGE_TOLERANCE_PX}; })
      .map((element) => element.className + ' +' + Math.round(box(element).right - edge))
      .slice(0, 6);
  };
  // A line that truncates with an ellipsis is wider than its box by design (Linux's wider fonts
  // truncated a role name here, Check on 010980b8): it clips, it does not scroll, so it is left out.
  const sideways = () => [...page().querySelectorAll('*')].filter((element) => !element.className.toString().includes('info-hint') && getComputedStyle(element).overflowX !== 'visible' && getComputedStyle(element).textOverflow !== 'ellipsis' && element.scrollWidth > element.clientWidth + 1).map((element) => element.className).slice(0, 6);
  const scrolls = (element) => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY);
  return {
    async ready() {
      return Boolean(await window.until(() => document.querySelector('section[aria-label="Timothy role"]')));
    },
    cards() {
      const rows = [...document.querySelectorAll('section[aria-label="Timothy role"] .app-role-row')];
      const rights = rows.map((row) => Math.round(box(row.querySelector('svg:last-child')).right));
      const summaries = rows.map((row) => Math.round(box(row.querySelector('.app-role-row-summary')).right));
      const labels = rows.map((row) => Math.round(box(row.querySelector('.app-role-row-label')).left));
      const card = document.querySelector('section[aria-label="Timothy role"]');
      return {
        rows: rows.length,
        chevronsShareAnEdge: new Set(rights).size === 1,
        summariesShareAnEdge: new Set(summaries).size === 1,
        labelsShareAnEdge: new Set(labels).size === 1,
        rowHeights: rows.map((row) => Math.round(box(row).height)),
        rowsInsideCard: rows.every((row) => box(row).right <= box(card).right && box(row).left >= box(card).left),
        past: past(),
        sideways: sideways(),
        switches: card.querySelectorAll('[role="switch"]').length,
        boxes: card.querySelectorAll('.app-role-people, .app-role-section').length,
      };
    },
    async open(label, name) {
      const row = document.querySelector('button[aria-label="Open ' + label + ' for Timothy"]');
      row.click();
      return Boolean(await window.until(() => document.querySelector('section.app-role-detail')));
    },
    async detail(section) {
      await window.until(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
      const view = document.querySelector('section.app-role-detail');
      const head = view.querySelector('.app-role-detail-head');
      const back = view.querySelector('.app-role-back');
      const title = view.querySelector('h3');
      const role = view.querySelector('.app-role-detail-role');
      const count = view.querySelector('.app-role-detail-count');
      const centre = (element) => (box(element).top + box(element).bottom) / 2;
      const search = view.querySelector('.app-role-search');
      const list = view.querySelector('.app-role-detail-list, .app-role-components-tree, .app-role-pin-list');
      const gutter = list === null ? undefined : getComputedStyle(list).scrollbarGutter;
      const startTop = list === null ? 0 : list.scrollTop;
      const dialog = document.querySelector('.app-settings');
      // From the list's bottom edge to the dialog's: the empty band a clipped list would leave.
      const bandPx = list === null ? -1 : Math.round(box(dialog).bottom - box(list).bottom);
      // Scrolled to the end, from the last row's bottom to the list's: the room the content ends with.
      const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      let endRoomPx = -1;
      let windowFilled = true;
      if (list !== null) {
        list.scrollTop = list.scrollHeight;
        await frames();
        list.scrollTop = list.scrollHeight;
        await frames();
        const rows = [...list.querySelectorAll('.app-role-chip, .app-role-toggle, .app-role-components-row, .app-role-pin')].map(box);
        endRoomPx = Math.round(box(list).bottom - Math.max(...rows.map((row) => row.bottom)));
        // A windowed tree draws rows all the way down its visible height.
        if (section === 'components') {
          windowFilled = Math.min(...rows.map((row) => row.top)) <= box(list).top + 32;
        }
        list.scrollTop = 0;
        await frames();
      }
      if (list !== null) { list.scrollTop = 40; }
      const scrolled = list === null ? 0 : list.scrollTop;
      const headBefore = Math.round(box(head).top);
      const searchBefore = Math.round(box(search).top);
      return {
        section,
        past: past(),
        sideways: sideways(),
        headAligned: [back, title, role, count].every((element) => Math.abs(centre(element) - centre(back)) <= 1.5),
        countAtHeadEnd: box(head).right - box(count).right <= 1.5 || head.querySelector('.app-role-detail-actions') !== null,
        backWhole: box(back).width >= 24 && box(back).height >= 24,
        searchBelowHead: box(search).top >= box(head).bottom,
        searchWidthFills: Math.abs(box(search).right - box(page()).right) <= 8,
        listScrolls: list !== null && scrolls(list),
        listOverflows: list !== null && list.scrollHeight > list.clientHeight + 1,
        bandPx,
        endRoomPx,
        windowFilled,
        gutter,
        scrolled,
        startTop,
        headStays: headBefore === Math.round(box(head).top) && searchBefore === Math.round(box(search).top),
        viewFitsWindow: box(view).bottom <= window.innerHeight + ${EDGE_TOLERANCE_PX} || (list !== null && scrolls(list)),
        mixedGroup: section === 'permissions' ? view.querySelector('[role="switch"][aria-checked="mixed"]') !== null : undefined,
        title: title.textContent,
      };
    },
    async back() {
      document.querySelector('.app-role-back').click();
      return Boolean(await window.until(() => document.querySelector('section[aria-label="Timothy role"]')));
    },
  };
})();
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
  const win = new BrowserWindow({ show: false, width: ${VIEWPORTS_PX[0].width}, height: ${VIEWPORTS_PX[0].height}, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(DIRECTORY, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const output = { cases: [], error: undefined };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    for (const { width, height } of ${JSON.stringify(VIEWPORTS_PX)}) {
      win.setContentSize(width, height);
      await host('window.mount()');
      const ready = await host('window.steps.ready()');
      const item = { width, height, ready, cards: undefined, details: [], backWorks: [] };
      if (ready) {
        item.cards = await host('window.steps.cards()');
        await shot('card-' + width + 'x' + height);
        for (const [section, label] of ${JSON.stringify(SECTIONS)}) {
          const opened = await host('window.steps.open(' + JSON.stringify(label) + ')');
          const measured = opened ? await host('window.steps.detail(' + JSON.stringify(section) + ')') : { section, opened: false };
          await shot(section + '-' + width + 'x' + height);
          item.details.push({ opened, ...measured });
          item.backWorks.push(await host('window.steps.back()'));
        }
      }
      output.cases.push(item);
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

function check(output) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  expect('every window size was drawn', output.cases.length === VIEWPORTS_PX.length, output.cases.length);
  for (const { width, height, ready, cards, details, backWorks } of output.cases) {
    const where = `${width}x${height}`;
    expect(`${where}: the roles screen drew`, ready === true);
    if (cards === undefined) {
      continue;
    }
    expect(`${where}: the card lists four summary rows`, cards.rows === 4, cards.rows);
    expect(
      `${where}: the rows' chevrons, counts and labels each share one edge`,
      cards.chevronsShareAnEdge && cards.summariesShareAnEdge && cards.labelsShareAnEdge,
      cards,
    );
    expect(
      `${where}: every row is 32px tall`,
      cards.rowHeights.every((height) => height === 32),
      cards.rowHeights,
    );
    expect(`${where}: the rows sit inside the card`, cards.rowsInsideCard === true);
    expect(`${where}: nothing is drawn past the page, and nothing scrolls sideways (cards)`, cards.past.length === 0 && cards.sideways.length === 0, cards);
    expect(`${where}: the card holds no switches and no inset boxes`, cards.switches === 0 && cards.boxes === 0, cards);
    for (const detail of details) {
      const here = `${where} ${detail.section}`;
      expect(`${here}: the row opened its view`, detail.opened === true);
      if (detail.opened !== true) {
        continue;
      }
      expect(`${here}: nothing is drawn past the page, and nothing scrolls sideways`, detail.past.length === 0 && detail.sideways.length === 0, detail);
      expect(`${here}: the back button, title, role and count share one row`, detail.headAligned === true, detail);
      expect(`${here}: the count sits at the header's end`, detail.countAtHeadEnd === true);
      expect(`${here}: the back button is a whole tap target`, detail.backWhole === true);
      expect(`${here}: the search is under the header and fills the width`, detail.searchBelowHead === true && detail.searchWidthFills === true, detail);
      if (detail.section !== 'pins' || detail.listOverflows) {
        expect(`${here}: the list scrolls inside the view`, detail.listScrolls === true, detail);
      }
      if (detail.section === 'members' || detail.section === 'components' || detail.section === 'permissions') {
        expect(`${here}: a long list overflows its box and scrolls`, detail.listOverflows === true && detail.scrolled > detail.startTop, detail);
        expect(`${here}: the scrollbar gutter is stable`, detail.gutter === 'stable', detail.gutter);
      }
      expect(`${here}: the header and search stay put while the list scrolls`, detail.headStays === true);
      expect(`${here}: the view fits the window`, detail.viewFitsWindow === true);
      expect(`${here}: the list runs to the dialog's bottom edge`, Math.abs(detail.bandPx) <= EDGE_TOLERANCE_PX, detail.bandPx);
      if (detail.listOverflows) {
        const room = detail.endRoomPx >= END_ROOM_PX.min && detail.endRoomPx <= END_ROOM_PX.max;
        expect(`${here}: the content ends with comfortable room`, room, detail.endRoomPx);
        expect(`${here}: the windowed tree is drawn down its whole height`, detail.windowFilled === true);
      }
      if (detail.section === 'permissions') {
        expect(`${here}: a partly granted group reads mixed`, detail.mixedGroup === true);
      }
    }
    expect(`${where}: Back returns to the cards from every view`, backWorks.length === 4 && backWorks.every(Boolean), backWorks);
  }
  return failures;
}

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('roles-detail-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/roles-detail-chromium');
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
  const failures = [];
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
  if (failures.length > 0) {
    console.error(`roles-detail-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`roles-detail-chromium: passed  [screenshots in ${directory}]`);
  }
})();
