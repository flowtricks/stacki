// Goal: every shipped language draws in the real interface: the Language switcher lists every locale by its own name, its
// check mark ends the row (on the left in Arabic and Hebrew, where the row's end is), the long list scrolls inside the menu
// instead of growing down the window, and a dense settings column in each language neither runs past its panel nor shows a
// missing-glyph box. Chinese, Japanese, Korean, Cyrillic, Devanagari, Arabic and Hebrew come from the system's fallback fonts
// (docs/i18n.md, "Fonts"); this is where that is checked.
//
//   node test/renderer/lib/i18n/localeScreensChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out text, chooses fallback fonts and joins Arabic. A harness
// bundles the real LanguageSetting, Dropdown and styles.css inside the real LocaleProvider, plus a 300px column of real settings
// rows (labels and their long explanations). For each locale the probe stores the choice, waits for the document language the
// provider sets once the catalog arrives (polled per frame, bounded), opens the switcher, and measures: the option labels, the
// check mark's box against its label's, the menu's scroll and client heights, the column's scroll width against its width, and
// the root's `dir`. Missing glyphs are read from Chromium itself through the DevTools protocol (`CSS.getPlatformFontsForNode`):
// macOS draws a glyph no font has with its "LastResort" font, so that name on any text node is a box on screen. Fallback fonts
// are a property of the machine, so the glyph check runs where the fonts are known (macOS); elsewhere it is reported, not
// failed. The window is never shown (`show: false`, and the gate's hidden-window preload); screenshots of the closed switcher,
// the open menu and the column per locale are written to node_modules/.stacki-test/locale-screens-chromium/.
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { runElectronProbesTogether } = require('../../../helpers/electronProbe.js');
const { repoPath } = require('../../../helpers/sources.js');

const COLUMN_WIDTH_PX = 300;
const EDGE_TOLERANCE_PX = 0.5;
const LOCALES_MIN = 18;
const PROBES_MAX = 3;

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from ${JSON.stringify(repoPath('src/lib/i18n/LocaleProvider.tsx'))};
import { LanguageSetting } from ${JSON.stringify(repoPath('src/app/settings/LanguageSetting.tsx'))};
import { SettingsRow } from ${JSON.stringify(repoPath('src/app/settings/SettingsLayout.tsx'))};
import { useTranslate } from ${JSON.stringify(repoPath('src/lib/i18n/useTranslate.ts'))};
import { writeLocalePreference } from ${JSON.stringify(repoPath('src/lib/i18n/localeStore.ts'))};
import { LOCALES, LOCALE_INFO } from ${JSON.stringify(repoPath('shared/core/i18n/locales.ts'))};
import { messages as english } from ${JSON.stringify(repoPath('shared/properties/i18n/messages/en/index.ts'))};

// Rows with long explanations: the densest real text the settings dialog draws.
const DENSE_KEYS = Object.keys(english).filter((key) => key.startsWith('settings.') && key.endsWith('.info') && typeof english[key] === 'string').slice(0, 10);

function Column() {
  const translate = useTranslate();
  return React.createElement('div', { id: 'column', className: 'panel', style: { width: ${COLUMN_WIDTH_PX} + 'px', overflow: 'hidden', padding: '8px' } },
    React.createElement(LanguageSetting),
    ...DENSE_KEYS.map((key) => React.createElement(SettingsRow, { key, label: translate(key.replace(/\\.info$/, '.label') in english ? key.replace(/\\.info$/, '.label') : key), info: translate(key) },
      React.createElement('span', { className: 'dense-text' }, translate(key)))));
}

let root;
window.locales = { list: LOCALES, info: LOCALE_INFO, denseCount: DENSE_KEYS.length };
window.mount = (locale) => {
  writeLocalePreference(locale);
  if (root === undefined) {
    root = createRoot(document.getElementById('host'));
    root.render(React.createElement(LocaleProvider, { languageTags: ['en'] }, React.createElement(Column)));
  }
};
`;

const STEPS = `
window.steps = {
  async ready(locale) {
    for (let frame = 0; frame < 600; frame += 1) {
      if (document.documentElement.lang === locale && document.querySelector('.dd-trigger')) { return true; }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return false;
  },
  async open() {
    document.querySelector('.dd-trigger').click();
    for (let frame = 0; frame < 120; frame += 1) {
      // Open once the menu has faded in, so the measured and captured menu is the one a person sees.
      const popup = document.querySelector('.dd-popup');
      if (popup && popup.querySelector('.dd-option') && getComputedStyle(popup).opacity === '1') { return true; }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return false;
  },
  measure() {
    const popup = document.querySelector('.dd-popup');
    const scroller = [popup, ...popup.querySelectorAll('*')].find((element) => element.scrollHeight > element.clientHeight + 1 && getComputedStyle(element).overflowY !== 'visible');
    const rows = [...popup.querySelectorAll('.dd-option')].map((row) => {
      const label = row.querySelector('.dd-option-label').getBoundingClientRect();
      const check = row.querySelector('.dd-check').getBoundingClientRect();
      return { text: row.querySelector('.dd-option-label').textContent, labelLeft: label.left, labelRight: label.right, checkLeft: check.left, checkRight: check.right, checkLast: row.lastElementChild.classList.contains('dd-check'), selected: row.querySelector('.dd-check svg') !== null };
    });
    const column = document.getElementById('column');
    const box = column.getBoundingClientRect();
    const popupBox = popup.getBoundingClientRect();
    return {
      dir: document.documentElement.dir,
      rows,
      scrolls: scroller !== undefined,
      gutter: scroller === undefined ? '' : getComputedStyle(scroller).scrollbarGutter,
      menuHeight: popupBox.height,
      popupLeft: popupBox.left,
      popupRight: popupBox.right,
      triggerLeft: document.querySelector('.dd-trigger').getBoundingClientRect().left,
      triggerRight: document.querySelector('.dd-trigger').getBoundingClientRect().right,
      columnOverflow: column.scrollWidth - column.clientWidth,
      denseCount: window.locales.denseCount,
      escaped: [...column.querySelectorAll('*')].filter((element) => { const r = element.getBoundingClientRect(); return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).length,
    };
  },
  async close() {
    for (let attempt = 0; attempt < 3 && document.querySelector('.dd-popup'); attempt += 1) {
      document.querySelector('.dd-trigger').click();
      for (let frame = 0; frame < 60 && document.querySelector('.dd-popup'); frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    return document.querySelector('.dd-popup') === null;
  },
};
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#111}</style></head>' +
  '<body><div id="host"></div><script src="/harness.js"></script><script src="/steps.js"></script></body></html>';

const PROBE = (directory, locales, tag) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
app.on('window-all-closed', () => {});
app.setPath('userData', path.join(DIRECTORY, 'profile-' + ${JSON.stringify(tag)}));
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 760, height: 900, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { cases: [], error: undefined };
  // The page's own errors, so a failed step says what broke instead of only that a script threw.
  const consoleLines = [];
  win.webContents.on('console-message', (...parts) => { const event = parts[0]; consoleLines.push(String(event && event.message !== undefined ? event.message : parts[2])); consoleLines.splice(0, Math.max(0, consoleLines.length - 20)); });
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    win.webContents.debugger.attach('1.3');
    const send = (method, params) => win.webContents.debugger.sendCommand(method, params);
    await send('DOM.enable');
    await send('CSS.enable');
    for (const locale of ${JSON.stringify(locales)}) {
      await host('window.mount(' + JSON.stringify(locale) + ')');
      if (!(await host('window.steps.ready(' + JSON.stringify(locale) + ')'))) { throw new Error(locale + ': the catalog never arrived'); }
      await host('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const closed = await win.webContents.capturePage({ x: 0, y: 0, width: 360, height: 900 });
      fs.writeFileSync(path.join(DIRECTORY, locale + '-column.png'), closed.toPNG());
      // Fonts per text node of the column and of the open menu: a glyph no font has is drawn with LastResort.
      const fontsOf = async (selector) => {
        const { root } = await send('DOM.getDocument', { depth: -1 });
        const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
        const names = new Set();
        for (const nodeId of nodeIds.slice(0, 400)) {
          const { fonts } = await send('CSS.getPlatformFontsForNode', { nodeId });
          for (const font of fonts) { names.add(font.familyName); }
        }
        return [...names];
      };
      const columnFonts = await fontsOf('#column *');
      if (!(await host('window.steps.open()'))) { throw new Error(locale + ': the switcher did not open'); }
      const measured = await host('window.steps.measure()');
      // Two drawn frames, so the capture holds the open menu and not the frame before it.
      await host('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const open = await win.webContents.capturePage({ x: 0, y: 0, width: 760, height: 900 });
      fs.writeFileSync(path.join(DIRECTORY, locale + '-switcher.png'), open.toPNG());
      const menuFonts = await fontsOf('.dd-popup *');
      output.cases.push({ locale, ...measured, fonts: [...new Set([...columnFonts, ...menuFonts])] });
      if (!(await host('window.steps.close()'))) { throw new Error(locale + ': the switcher did not close'); }
    }
  } catch (failure) {
    output.error = String(failure && failure.stack || failure) + ' | page: ' + consoleLines.slice(-6).join(' | ');
  }
  console.log('RESULT ' + JSON.stringify(output));
  app.exit(0);
});
`;

function check(output, info, locales) {
  const failures = [];
  const expect = (label, condition, detail) => {
    if (!condition) {
      failures.push(`${label}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
    }
  };
  expect('every locale was drawn', output.cases.length === locales.length, output.cases.length);
  const names = locales.map((locale) => info[locale].nativeName);
  for (const drawn of output.cases) {
    const rtl = info[drawn.locale].direction === 'rtl';
    expect(`${drawn.locale}: the root says ${rtl ? 'rtl' : 'ltr'}`, drawn.dir === (rtl ? 'rtl' : 'ltr'), drawn.dir);
    expect(`${drawn.locale}: the switcher lists System default and every locale`, drawn.rows.length === locales.length + 1, drawn.rows.length);
    expect(
      `${drawn.locale}: every language is listed by its own name, in order`,
      JSON.stringify(drawn.rows.slice(1).map((row) => row.text)) === JSON.stringify(names),
      drawn.rows.slice(1).map((row) => row.text),
    );
    const selected = drawn.rows.filter((row) => row.selected);
    expect(`${drawn.locale}: one row carries the check`, selected.length === 1, selected.length);
    expect(`${drawn.locale}: the checked row is this language`, selected[0] !== undefined && selected[0].text === info[drawn.locale].nativeName, selected[0]);
    for (const row of drawn.rows) {
      expect(`${drawn.locale}: the check is the row's last element`, row.checkLast, row.text);
    }
    // Only the chosen row draws its check; the others keep an empty slot, which has no box to compare.
    for (const row of selected) {
      const atEnd = rtl ? row.checkRight <= row.labelLeft + EDGE_TOLERANCE_PX : row.checkLeft >= row.labelRight - EDGE_TOLERANCE_PX;
      expect(`${drawn.locale}: the check ends the row (${rtl ? 'left' : 'right'} of "${row.text}")`, atEnd, row);
    }
    // The menu hangs from its trigger's start edge: the left in English, the right in Arabic and Hebrew.
    const aligned = rtl ? Math.abs(drawn.popupRight - drawn.triggerRight) <= 1 : Math.abs(drawn.popupLeft - drawn.triggerLeft) <= 1;
    expect(`${drawn.locale}: the menu lines up with the switcher's ${rtl ? 'right' : 'left'} edge`, aligned, drawn);
    expect(`${drawn.locale}: the long list scrolls inside the menu`, drawn.scrolls, drawn.menuHeight);
    expect(`${drawn.locale}: the menu's scroller keeps a stable gutter`, drawn.gutter.includes('stable'), drawn.gutter);
    expect(`${drawn.locale}: the dense column has its rows`, drawn.denseCount >= 5, drawn.denseCount);
    expect(`${drawn.locale}: nothing in the column scrolls sideways`, drawn.columnOverflow <= 0, drawn.columnOverflow);
    expect(`${drawn.locale}: nothing is drawn outside the column`, drawn.escaped === 0, drawn.escaped);
    if (process.platform === 'darwin') {
      expect(`${drawn.locale}: no glyph falls back to a missing-glyph box`, !drawn.fonts.includes('LastResort'), drawn.fonts);
    }
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
    console.log('locale-screens-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/locale-screens-chromium');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  // The locale list is read from the source of truth, bundled once for node, so a new language is drawn the moment it is listed.
  const listFile = path.join(directory, 'locales.cjs');
  buildSync({ entryPoints: [repoPath('shared/core/i18n/locales.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: listFile, logLevel: 'silent' });
  const { LOCALES, LOCALE_INFO } = require(listFile);
  if (LOCALES.length < LOCALES_MIN) {
    throw new Error(`Assertion failed: at least ${LOCALES_MIN} locales ship (${LOCALES.length})`);
  }
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
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  // A few processes side by side, each drawing a share of the languages: one process for all of them waits on every frame in turn.
  const shares = Array.from({ length: PROBES_MAX }, (_, index) => LOCALES.filter((_, position) => position % PROBES_MAX === index));
  const probes = shares.map((share, index) => {
    const probe = path.join(directory, `probe-${index}.js`);
    fs.writeFileSync(probe, PROBE(directory, share, String(index)));
    return [probe];
  });
  const runs = await runElectronProbesTogether(electronPath, probes, { env: environment });
  const failures = [];
  const output = { cases: [] };
  for (const [index, run] of runs.entries()) {
    const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
    if (line === undefined) {
      failures.push(
        `probe ${index} ran (${run.error ? String(run.error.message) : 'exit ' + String(run.status)})\n    ${(run.stderr || run.stdout || '').slice(0, 800)}`,
      );
    } else {
      const result = JSON.parse(line.slice('RESULT '.length));
      if (result.error !== undefined) {
        failures.push(`probe ${index} ran to the end\n    ${result.error}`);
      }
      output.cases.push(...result.cases);
    }
  }
  if (failures.length === 0) {
    failures.push(...check(output, LOCALE_INFO, LOCALES));
  }
  if (process.platform !== 'darwin') {
    const boxed = output.cases.filter((drawn) => drawn.fonts.includes('LastResort')).map((drawn) => drawn.locale);
    console.log(`locale-screens-chromium: glyph check reported only on ${process.platform}; missing-glyph fonts in: ${boxed.join(', ') || 'none'}`);
  }
  if (failures.length > 0) {
    console.error(`locale-screens-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`locale-screens-chromium: ok  [${output.cases.length} languages; screenshots in ${directory}]`);
  }
})().catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
