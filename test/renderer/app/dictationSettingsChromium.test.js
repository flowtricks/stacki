// Goal: the Dictation tab lays out whole at the narrowest and at a wide Settings dialog, in each of its states (not set up,
// downloading, ready): nothing is drawn past the page's edges and nothing scrolls sideways; the model folder is one line cut
// in its middle, never wrapping into the cards or the lists around it; the three quality cards share one size and sit in
// a row or a column without touching; the status card, the cards, the rows and the details start at the same left edge; the
// status card keeps its button and its progress bar inside it; and the details, opened, sit under the lists, not over them.
//
//   node test/renderer/app/dictationSettingsChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out grids, flex wrapping and ellipsis. A harness bundles
// the real Settings dialog (the project-bound tabs stubbed) with the real dictation store over a fake main process, and the
// app's real stylesheet, into a hidden window, and opens it on the Dictation tab with long words, snippets and a long
// application-data folder. For each width the window is resized, then every wait is for a condition (the width the dialog
// reports, the status the card shows), polled once per animation frame and bounded; there are no fixed pauses. Screenshots of
// each case are written to node_modules/.stacki-test/dictation-settings-chromium/.
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { runElectronProbe } = require('../../helpers/electronProbe.js');
const { repoPath } = require('../../helpers/sources.js');

const WIDTHS_PX = [320, 560, 1000];
const STATES = ['notInstalled', 'downloading', 'ready'];
const HEIGHT_PX = 900;
// Sub-pixel layout rounds; an element this far past an edge is not overflowing.
const EDGE_TOLERANCE_PX = 0.75;
// A line of 11 to 12px text; a path taller than this has wrapped.
const ONE_LINE_PX = 26;

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import Settings, { openAppSettings } from ${JSON.stringify(repoPath('src/app/settings/Settings.tsx'))};
import { ConfirmHost } from ${JSON.stringify(repoPath('src/ui/ConfirmDialog.tsx'))};
import { VoiceEnvironmentContext } from ${JSON.stringify(repoPath('src/features/ai/voice/voiceEnvironment.ts'))};
import { createDictationStore } from ${JSON.stringify(repoPath('src/features/ai/voice/dictationStore.ts'))};
import { WHISPER_MODELS, modelTotalBytes } from ${JSON.stringify(repoPath('shared/properties/voice/whisperModels.ts'))};

const DIRECTORY = '/Users/a-designer-with-a-long-name/Library/Application Support/Stacki Desktop/models/whisper';
const WORDS = {
  vocabulary: [
    { word: 'Stacki' },
    { word: 'Extraordinarily-long-product-name-that-never-breaks', misheard: 'a very long misheard phrase that goes on and on for a while' },
    { word: 'Lumos', misheard: 'lumas' },
  ],
  snippets: [
    { trigger: 'my linkedin', expansion: 'https://www.linkedin.com/in/a-profile-with-an-extremely-long-address-that-has-no-break-points-at-all' },
    { trigger: 'sign off', expansion: 'Thanks so much,\\nA Designer\\nSenior Product Designer at a company with a long name' },
  ],
};
window.avb = {
  onMenu: () => () => {},
  settings: async () => ({ sound: false, usageCountsEnabled: true }),
  setPreference: async (input) => ({ sound: input.enabled, usageCountsEnabled: true, saved: true }),
  microphoneStatus: async () => ({ status: 'denied', appName: 'Stacki', settingsAvailable: true }),
  dictationReveal: async () => ({ ok: true }),
};
window.openAppSettings = openAppSettings;
window.mount = (state) => {
  localStorage.setItem('stacki.dictation.words', JSON.stringify(WORDS));
  const total = modelTotalBytes(WHISPER_MODELS.turbo);
  const install =
    state === 'ready' ? { kind: 'installed', sizeBytes: total } : state === 'downloading' ? { kind: 'partial', receivedBytes: Math.floor(total / 3), totalBytes: total } : { kind: 'notInstalled' };
  const listeners = new Set();
  const store = createDictationStore({
    status: async () => ({ directory: DIRECTORY, models: [{ id: 'turbo', install }, { id: 'small', install: { kind: 'installed', sizeBytes: modelTotalBytes(WHISPER_MODELS.small) } }, { id: 'base', install: { kind: 'notInstalled' } }] }),
    download: () => new Promise(() => {}),
    cancel: async () => {},
    remove: async () => {},
    onProgress: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  window.root?.unmount();
  document.getElementById('host').innerHTML = '<div id="root"></div>';
  window.root = createRoot(document.getElementById('root'));
  window.root.render(
    React.createElement(VoiceEnvironmentContext.Provider, { value: { whisper: { store } } },
      React.createElement(Settings, { projectPath: undefined, previewURL: undefined }),
      React.createElement(ConfirmHost)),
  );
  window.progress = () => listeners.forEach((listener) => listener({ id: 'turbo', receivedBytes: Math.floor(total / 3), totalBytes: total }));
  window.start = () => store.download();
  window.store = store;
};
window.until = (condition) =>
  new Promise((resolve) => {
    const deadlineMs = performance.now() + 15000;
    const frame = () => {
      let value;
      try { value = condition(); } catch { value = undefined; }
      if (value) { resolve(value); return; }
      if (performance.now() > deadlineMs) { resolve(false); return; }
      requestAnimationFrame(frame);
    };
    frame();
  });
`;

const STEPS = `
window.steps = {
  async open(state, width) {
    window.mount(state);
    // The dialog registers its opener once it has committed, so ask until it has (a request with no opener does nothing).
    await window.until(() => {
      window.openAppSettings('dictation');
      return document.querySelector('.app-settings');
    });
    const sized = await window.until(() => document.querySelector('.app-settings') && Math.abs(document.querySelector('.app-settings').getBoundingClientRect().width - Math.min(880, window.innerWidth - 48)) < 1);
    if (state === 'downloading') {
      await window.until(() => document.querySelector('.dictation-status[data-state="partial"]'));
      window.start();
      window.progress();
    }
    const settled = await window.until(() => {
      const status = document.querySelector('.dictation-status');
      if (!status) { return false; }
      const mark = status.getAttribute('data-state');
      return state === 'notInstalled' ? mark === 'notInstalled' : state === 'downloading' ? mark === 'downloading' : mark === 'ready';
    });
    // The microphone row and the quality badges arrive with their own replies.
    const answered = await window.until(() => document.querySelector('.dictation-mic-state') && document.querySelectorAll('.dictation-quality-state').length >= 1);
    const toggle = [...document.querySelectorAll('.dictation-details-toggle')][0];
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') { toggle.click(); }
    const opened = await window.until(() => document.querySelector('.dictation-details-list'));
    return { sized: Boolean(sized), settled: Boolean(settled), answered: Boolean(answered), opened: Boolean(opened), width: window.innerWidth };
  },
  measure(tolerance, oneLine) {
    const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const page = document.querySelector('.dictation-page');
    const pageBox = box(page);
    const scroll = document.querySelector('.app-settings-scroll');
    // Clipped on purpose: the text inside is cut with an ellipsis, so its own box may run past; the clipping box is measured instead.
    const clipped = (element) => element.closest('.dictation-details-path, .dictation-row-title, .dictation-row-detail, .ui-skeleton') !== null && element.closest('.dictation-details-path, .dictation-row-title, .dictation-row-detail, .ui-skeleton') !== element;
    const past = [];
    for (const element of page.querySelectorAll('*')) {
      const b = box(element);
      if (b.width === 0 || clipped(element)) { continue; }
      if (b.right > pageBox.right + tolerance || b.left < pageBox.left - tolerance) { past.push(element.className.toString() + ' ' + Math.round(b.left) + '-' + Math.round(b.right) + ' of ' + Math.round(pageBox.left) + '-' + Math.round(pageBox.right)); }
    }
    const cards = [...document.querySelectorAll('.dictation-quality-card')].map(box);
    const intersects = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const touching = [];
    for (let i = 0; i < cards.length; i += 1) { for (let j = i + 1; j < cards.length; j += 1) { if (intersects(cards[i], cards[j])) { touching.push([i, j]); } } }
    const lefts = [...page.querySelectorAll('.dictation-status, .app-settings-section, .dictation-group, .dictation-details-toggle')].map((element) => Math.round(box(element).left * 10) / 10);
    const rowLefts = [...page.querySelectorAll('.dictation-row')].map((element) => Math.round(box(element).left * 10) / 10);
    const path = document.querySelector('.dictation-details-path');
    const detailsList = document.querySelector('.dictation-details-list');
    const lastSection = [...document.querySelectorAll('.dictation-page > .app-settings-section')].at(-1);
    const status = document.querySelector('.dictation-status');
    const inside = (child, parent) => child.left >= parent.left - tolerance && child.right <= parent.right + tolerance && child.top >= parent.top - tolerance && child.bottom <= parent.bottom + tolerance;
    const statusBox = box(status);
    const statusChildren = [...status.querySelectorAll('button, [role="progressbar"], .dictation-status-text')].map(box);
    return {
      scrollSideways: [scroll.scrollWidth, scroll.clientWidth],
      documentSideways: [document.documentElement.scrollWidth, window.innerWidth],
      past,
      cardCount: cards.length,
      cardWidths: cards.map((c) => Math.round(c.width * 10) / 10),
      cardHeights: cards.map((c) => Math.round(c.height * 10) / 10),
      cardTops: cards.map((c) => Math.round(c.top)),
      cardLefts: cards.map((c) => Math.round(c.left)),
      touching,
      lefts,
      rowLefts,
      pageLeft: Math.round(pageBox.left * 10) / 10,
      pathHeight: path ? box(path).height : undefined,
      pathText: path ? path.textContent : undefined,
      pathInsideDetails: path && detailsList ? inside(box(path), box(detailsList)) : false,
      detailsBelowLists: detailsList && lastSection ? box(detailsList).top >= box(lastSection).bottom - tolerance : false,
      cardsAboveLanguage: cards.length === 3 ? cards.every((c) => c.bottom <= box(document.querySelector('.dictation-group')).top + tolerance) : false,
      statusInside: statusChildren.every((child) => inside(child, statusBox)),
      statusButton: Boolean(status.querySelector('button')),
      oneLine,
    };
  },
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
app.setPath('userData', path.join(DIRECTORY, 'profile'));
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 1000, height: ${HEIGHT_PX}, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const output = { cases: [], error: undefined, console: [] };
  win.webContents.on('console-message', (event) => { if (output.console.length < 12) { output.console.push(String(event.message ?? '').slice(0, 300)); } });
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    for (const state of ${JSON.stringify(STATES)}) {
      for (const width of ${JSON.stringify(WIDTHS_PX)}) {
        win.setContentSize(width, ${HEIGHT_PX});
        const ready = await win.webContents.executeJavaScript('window.steps.open(' + JSON.stringify(state) + ', ' + width + ')');
        const measured = await win.webContents.executeJavaScript('window.steps.measure(${EDGE_TOLERANCE_PX}, ${ONE_LINE_PX})');
        const image = await win.webContents.capturePage({ x: 0, y: 0, width, height: ${HEIGHT_PX} });
        fs.writeFileSync(path.join(DIRECTORY, 'dictation-' + state + '-' + width + '.png'), image.toPNG());
        output.cases.push({ state, width, ready, measured });
      }
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

function check(expect, where, measured) {
  const sameWithin = (values, delta) => values.length > 0 && Math.max(...values) - Math.min(...values) <= delta;
  expect(`${where}: the page does not scroll sideways`, measured.scrollSideways[0] <= measured.scrollSideways[1] + 1, measured.scrollSideways);
  expect(`${where}: the window does not scroll sideways`, measured.documentSideways[0] <= measured.documentSideways[1] + 1, measured.documentSideways);
  expect(`${where}: no element is drawn past the page's edges`, measured.past.length === 0, measured.past.slice(0, 6));
  expect(`${where}: the three quality cards are there`, measured.cardCount === 3);
  expect(`${where}: the cards share one width`, sameWithin(measured.cardWidths, 1), measured.cardWidths);
  const inRow = sameWithin(measured.cardTops, 1);
  const inColumn = sameWithin(measured.cardLefts, 1);
  expect(`${where}: the cards sit in one row or one column`, inRow || inColumn, { tops: measured.cardTops, lefts: measured.cardLefts });
  if (inRow) {
    expect(`${where}: cards in a row share one height`, sameWithin(measured.cardHeights, 1), measured.cardHeights);
  }
  expect(`${where}: no two cards touch`, measured.touching.length === 0, measured.touching);
  expect(`${where}: the cards are above the language row`, measured.cardsAboveLanguage === true);
  expect(`${where}: status, sections, rows and details start at the same left edge`, sameWithin([...measured.lefts, measured.pageLeft], 0.6), measured.lefts);
  expect(`${where}: list rows start there too`, measured.rowLefts.length >= 4 && sameWithin([...measured.rowLefts, measured.pageLeft], 0.6), measured.rowLefts);
  expect(`${where}: the status card keeps its words, bar and button inside`, measured.statusInside === true && measured.statusButton === true);
  expect(`${where}: the folder is one line`, typeof measured.pathHeight === 'number' && measured.pathHeight <= measured.oneLine, measured.pathHeight);
  expect(
    `${where}: the folder is cut to fit, not wrapped`,
    typeof measured.pathText === 'string' && measured.pathText.length <= 44 && measured.pathText.includes('…'),
    measured.pathText,
  );
  expect(`${where}: the folder stays inside the details`, measured.pathInsideDetails === true);
  expect(`${where}: the details sit under the lists`, measured.detailsBelowLists === true);
}

(async () => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('dictation-settings-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/dictation-settings-chromium');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const stubs = {
    name: 'dictation-chromium-stubs',
    setup(build) {
      build.onResolve(
        {
          filter:
            /cmsConnections\/CmsConnections$|studioSetup\/StudioSetup$|\/FolderSettings$|\/RolesSettings$|\/InstructionsSettings$|\/AuditsSettings$|\/BreakpointsSettings$|\/StyleTagSettings$/,
        },
        (args) => ({
          path: args.path,
          namespace: 'stub',
        }),
      );
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        loader: 'jsx',
        contents: args.path.includes('StyleTagSettings')
          ? 'export function StyleTagSettingsPage() { return null; }'
          : args.path.includes('StudioSetup')
            ? 'export default function StudioSetup() { return null; }'
            : `export function ${args.path.split('/').pop()}() { return null; }`,
      }));
    },
  };
  await build({
    stdin: { contents: HARNESS, resolveDir: repoPath('.'), loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    outfile: path.join(directory, 'harness.js'),
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
    plugins: [stubs],
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(path.join(directory, 'steps.js'), STEPS);
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const run = runElectronProbe(electronPath, [probe], { env: environment });
  const failures = [];
  let checked = 0;
  const expect = (what, condition, detail) => {
    checked += 1;
    if (!condition) {
      failures.push(`  ${what}${detail === undefined ? '' : `\n    ${JSON.stringify(detail)}`}`);
    }
  };
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  if (line === undefined) {
    expect('the browser probe ran', false, (run.stderr || run.stdout || '').slice(0, 800));
  } else {
    const result = JSON.parse(line.slice('RESULT '.length));
    expect('the probe finished without an error', result.error === undefined, { error: result.error, console: result.console });
    expect('every state at every width was drawn', result.cases.length === STATES.length * WIDTHS_PX.length, result.cases.length);
    for (const item of result.cases) {
      const where = `${item.state} at ${item.width}px`;
      expect(
        `${where}: the page settled, answered and opened its details`,
        item.ready.sized && item.ready.settled && item.ready.answered && item.ready.opened,
        item.ready,
      );
      if (item.ready.settled && item.ready.opened) {
        check(expect, where, item.measured);
      }
    }
  }
  if (failures.length > 0) {
    console.error(`dictation-settings-chromium: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`dictation-settings-chromium: ${checked} checks passed`);
})();
