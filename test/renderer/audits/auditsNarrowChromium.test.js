// Goal: the Audits panel stays whole at every width the left panel can take (260px to 600px) in every
// language: nothing is drawn past the panel's right edge, nothing scrolls sideways, the category
// menu, the Site / This page switch and the Ignored pill are all whole and as tall as before, a
// rule's count stays visible at the row's right, the secondary text is the first thing cut, and text
// that is cut carries its full wording as a tooltip. The same holds with the Find & replace card open (menu, then
// Find & replace): two single-line fields of one height and fill, three labelled option toggles inside the Find
// field that change fill when pressed, a whole close button, Find and Replace all at 24px, a status line, and Escape closing it.
//
//   node test/renderer/audits/auditsNarrowChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out flex-wrap, ellipsis and
// scrollWidth. A harness bundles the real AuditsPanel and styles.css into a `.panel.left` of the
// width under test, inside the real LocaleProvider, with the audit store filled by a fixture of
// findings written here: every kind of row (a rule with a raw-value breakdown, a rule with a long
// title, a file and an element group with long names, a fix that is ready, ignored entries). The
// fixture is drawn at 260, 340 and 600px in en, de, fr, es and pt-BR (de and fr have the longest
// strings), with every rule and group opened so the nested rows are measured too. The probe
// reads each element's box against the panel's, the list's and the panel's scroll widths, the
// toolbar controls' boxes and heights, and the cut text's titles. Every wait is for a condition
// (the document language the provider sets once a catalog arrives), polled once per animation
// frame and bounded. Screenshots of every case are written to node_modules/.stacki-test/audits-narrow-chromium/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const WIDTHS_PX = [260, 340, 600];
const LOCALES = ['en', 'de', 'fr', 'es', 'pt-BR'];
const PANE_HEIGHT_PX = 900;
// Sub-pixel layout rounds; an element this far past the edge is not overflowing.
const EDGE_TOLERANCE_PX = 0.5;
// The heights the controls had before the layout moved: a tap target is not allowed to shrink.
const HEIGHTS_PX = { pill: 24, tab: 24, apply: 24 };
const EXPANDS_MAX = 40;

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from ${JSON.stringify(repoPath('src/lib/i18n/LocaleProvider.tsx'))};
import AuditsPanel from ${JSON.stringify(repoPath('src/features/audits/AuditsPanel.tsx'))};
import { updateAuditState } from ${JSON.stringify(repoPath('src/features/audits/auditStore.ts'))};
import { EMPTY_AUDIT_IGNORES } from ${JSON.stringify(repoPath('shared/properties/auditIgnores.ts'))};

const fix = { label: 'Add alt', before: '<img>', after: '<img alt="">', file: 'src/pages/index.astro', edits: [] };
let counter = 0;
const finding = (check, file, extra) => {
  counter += 1;
  return {
    id: check + ':' + counter,
    check,
    file,
    fileKind: file.startsWith('src/pages/') ? 'page' : 'component',
    element: { path: [0, counter], tag: 'div', line: counter },
    detail: '',
    source: 'static',
    fix: undefined,
    ...extra,
  };
};
const css = (group, property, value) => ({ selector: '.a-very-long-selector-name-for-a-hero-section', property, value, token: value, line: 3, group });
const longPage = 'src/pages/a-landing-page-with-an-extremely-long-file-name.astro';
const findings = [
  finding('link-broken', 'src/pages/example-components.astro', { detail: 'href="/about"' }),
  finding('placeholder-text', longPage, { detail: '"Lorem ipsum dolor sit amet, consectetur adipiscing elit"' }),
  finding('placeholder-text', 'src/components/Card.astro', { detail: '"Your headline here"' }),
  finding('img-alt', longPage, { detail: 'src="/images/hero.png"', fix }),
  finding('h1-count', 'src/pages/index.astro', { detail: 'No h1' }),
  finding('duplicate-id', 'src/pages/index.astro', { detail: 'id="hero"' }),
  finding('token-color', 'src/components/Card.astro', { css: css('colour', 'color', '#ff6b6b') }),
  finding('token-color', 'src/components/Card.astro', { css: css('colour', 'background', '#123456') }),
  ...['spacing', 'spacing', 'size', 'size', 'type', 'radius', 'colour', 'unit'].map((group, index) =>
    finding('token-value', 'src/components/Card.astro', {
      element: { path: [1], tag: 'style', line: 1 },
      css: css(group, 'padding', index + 'px'),
    }),
  ),
  finding('style-global', 'src/components/Hero.astro', { detail: 'A style block that is not global' }),
  // Nine more fixes, so ten are ready: the (i) list shows eight and says "+ 2 more".
  ...Array.from({ length: 9 }, (_, index) =>
    finding('img-alt', 'src/pages/index.astro', { detail: 'src="/more-' + index + '.png"', fix: { ...fix, before: '<img src="/more-' + index + '.png">', after: '<img src="/more-' + index + '.png" alt="">' } }),
  ),
  finding('perf-image-size', longPage, { detail: 'src="/images/hero.png"', measure: '1.2 MB' }),
];
const ignores = { ...EMPTY_AUDIT_IGNORES, ignored: [{ id: 'gone:1', reason: 'Kept on purpose' }, { id: 'gone:2', reason: 'Kept on purpose' }] };
window.revealed = [];
window.mount = (locale, widthPx) => {
  updateAuditState(() => ({
    scope: 'site',
    report: { scope: 'site', findings, files: 7, unreadable: 0, skipped: 0, rendered: { state: 'off' }, checkedAt: 0, trees: new Map() },
    running: false,
    ignores: { source: undefined, value: ignores },
    problem: undefined,
    request: 0,
    performance: { running: false, results: [], findings: [], problem: undefined },
    progress: undefined,
    projectPath: '/fixture',
  }));
  window.root?.unmount();
  document.documentElement.lang = '';
  const host = document.getElementById('host');
  host.style.width = widthPx + 'px';
  host.innerHTML = '<div id="root" class="panel left" style="width:' + widthPx + 'px;height:${PANE_HEIGHT_PX}px"></div>';
  window.root = createRoot(document.getElementById('root'));
  window.root.render(
    React.createElement(
      LocaleProvider,
      { languageTags: [locale] },
      React.createElement(AuditsPanel, {
        project: { path: '/fixture', name: 'fixture' },
        fixDeps: () => ({}),
        onReveal: (file) => window.revealed.push(file),
        onHover: () => {},
        onCreatePage: () => {},
        routes: [],
        showToast: () => {},
        measure: () => ({ projectPath: '/fixture', devUrl: undefined, current: undefined, pages: [] }),
        sources: () => ({ current: undefined, all: [] }),
        onConfigure: () => {},
      }),
    ),
  );
};
window.until = (condition, framesMax = 600) =>
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
`;

// Page-side checks. Everything is read from layout; nothing is clicked except the disclosure rows.
const STEPS = `
window.steps = (() => {
  const box = (element) => element.getBoundingClientRect();
  const cut = (element) => element.scrollWidth > element.clientWidth + 1;
  return {
    async ready(locale) {
      const drawn = await window.until(() => document.documentElement.lang === locale && document.querySelector('.audits-rule') !== null);
      if (!drawn) { return { drawn: false }; }
      // Open every rule, file and element group so nested rows are measured (bounded).
      for (let pass = 0; pass < ${EXPANDS_MAX}; pass += 1) {
        const closed = document.querySelector('.audits-row[aria-expanded="false"]');
        if (closed === null) { break; }
        closed.click();
        await window.until(() => closed.getAttribute('aria-expanded') === 'true', 60);
      }
      await window.until(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
      return { drawn: true };
    },
    // Opens Find & replace from the panel's menu, types a query, searches and presses the three option toggles.
    async openFind() {
      document.querySelector('.panel-header-actions > :last-child button, .panel-header-actions > button:last-child').click();
      const items = await window.until(() => { const found = document.querySelectorAll('[role="menuitem"]'); return found.length > 1 && found; });
      if (!items) { return { opened: false }; }
      items[1].click();
      const card = await window.until(() => document.querySelector('.audits-find'));
      if (!card) { return { opened: false }; }
      const input = card.querySelector('.audits-find-field input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'the');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await window.until(() => card.querySelector('.audits-secondary').disabled === false);
      card.querySelector('.audits-secondary').click();
      await window.until(() => card.querySelector('.audits-find-status').textContent.length > 0);
      const toggles = [...card.querySelectorAll('.audits-toggle')];
      const before = toggles.map((toggle) => getComputedStyle(toggle).backgroundColor);
      toggles.forEach((toggle) => toggle.click());
      await window.until(() => toggles.every((toggle) => toggle.getAttribute('aria-pressed') === 'true'));
      const after = toggles.map((toggle) => getComputedStyle(toggle).backgroundColor);
      return { opened: true, focused: document.activeElement === input || card.contains(document.activeElement), pressedChangesFill: before.every((fill, index) => fill !== after[index]), toggleCount: toggles.length };
    },
    measureFind() {
      const card = document.querySelector('.audits-find');
      const panel = document.querySelector('.audits-panel');
      const fields = [...card.querySelectorAll('.audits-find-field')];
      const toggles = [...card.querySelectorAll('.audits-toggle')];
      const find = fields[0];
      const close = card.querySelector('.audits-find-header button');
      const primary = card.querySelector('.audits-apply');
      const secondary = card.querySelector('.audits-secondary');
      const inside = (element, within) => box(element).width > 0 && box(element).right <= box(within).right + ${EDGE_TOLERANCE_PX} && box(element).left >= box(within).left - ${EDGE_TOLERANCE_PX};
      return {
        fieldCount: fields.length,
        fieldHeights: fields.map((field) => Math.round(box(field).height)),
        fieldFills: new Set(fields.map((field) => getComputedStyle(field).backgroundColor)).size,
        inputsSingleLine: fields.every((field) => field.querySelector('input') !== null && field.querySelector('textarea') === null),
        togglesInsideFind: toggles.length === 3 && toggles.every((toggle) => inside(toggle, find)),
        toggleLabelled: toggles.every((toggle) => (toggle.getAttribute('title') || '').length > 0 && toggle.getAttribute('aria-label') === toggle.getAttribute('title')),
        closeShown: inside(close, card) && close.getAttribute('aria-label').length > 0,
        buttonsInside: inside(primary, card) && inside(secondary, card),
        primaryHeight: Math.round(box(primary).height),
        secondaryHeight: Math.round(box(secondary).height),
        cardInsidePanel: inside(card, panel),
        status: card.querySelector('.audits-find-status').textContent,
        scopeEqual: card.querySelector('.ui-tabs').classList.contains('is-equal'),
        queryInputWidth: Math.round(box(find.querySelector('input')).width),
      };
    },
    // The (i) beside the fixes-ready line. Hover waits, then opens; leaving closes a hover list; a click pins it.
    async fixesOpen() {
      const info = document.querySelector('.audits-ready .audits-info');
      if (info === null) { return { present: false }; }
      const open = () => document.querySelector('.audits-fixes');
      const gone = () => window.until(() => open() === null, 120);
      info.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const openedAtOnce = open() !== null;
      const startedAt = performance.now();
      const hoverShown = Boolean(await window.until(open, 200));
      const hoverDelayMs = performance.now() - startedAt;
      info.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      const hoverCloses = await gone();
      info.click();
      const pinned = Boolean(await window.until(open, 120));
      await window.until(() => open() && open().getAttribute('data-popup-phase') === 'open', 120);
      info.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
      await window.until(() => false, 30);
      const stillPinned = open() !== null;
      const popup = open();
      const rectangle = popup.getBoundingClientRect();
      const items = [...popup.querySelectorAll('.audits-fix-item')];
      const cutTexts = [...popup.querySelectorAll('.audits-fix-name, .audits-fix-change, .audits-fix-where')].filter(cut);
      return {
        present: true,
        openedAtOnce, hoverShown, hoverDelayMs, hoverCloses, pinned, stillPinned,
        expanded: info.getAttribute('aria-expanded'),
        itemCount: items.length,
        more: popup.querySelector('.audits-fix-more') === null ? '' : popup.querySelector('.audits-fix-more').textContent,
        title: popup.querySelector('.audits-fixes-title').textContent,
        insideWindow: rectangle.left >= 0 && rectangle.right <= window.innerWidth && rectangle.top >= 0 && rectangle.bottom <= window.innerHeight,
        sidewaysScroll: popup.scrollWidth > popup.clientWidth + 1,
        untitledCut: cutTexts.filter((element) => !(element.getAttribute('title') || '').trim()).length,
        itemsHaveThreeLines: items.every((item) => item.querySelectorAll('.audits-fix-name, .audits-fix-change, .audits-fix-where').length === 3),
        changeHasArrow: items.every((item) => item.querySelector('.audits-fix-change').textContent.includes('→')),
        infoInsideReady: box(info).right <= box(document.querySelector('.audits-ready')).right + ${EDGE_TOLERANCE_PX} && box(info).width > 0,
        infoBesideText: box(info).left >= box(document.querySelector('.audits-ready-text')).right - 1,
        infoSize: [Math.round(box(info).width), Math.round(box(info).height)],
      };
    },
    // Escape closes the pinned list; a row goes to its element and closes it; "+ N more" goes to the first hidden fix.
    async fixesClose() {
      const open = () => document.querySelector('.audits-fixes');
      const info = document.querySelector('.audits-ready .audits-info');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const escapeCloses = await window.until(() => open() === null, 120);
      window.revealed.length = 0;
      info.click();
      await window.until(() => open() && open().getAttribute('data-popup-phase') === 'open', 120);
      open().querySelector('.audits-fix-item').click();
      const rowCloses = await window.until(() => open() === null, 120);
      const rowRevealed = window.revealed.length === 1;
      info.click();
      await window.until(() => open() && open().getAttribute('data-popup-phase') === 'open', 120);
      open().querySelector('.audits-fix-more').click();
      const moreCloses = await window.until(() => open() === null, 120);
      return { escapeCloses, rowCloses, rowRevealed, moreRevealed: window.revealed.length === 2, moreCloses };
    },
    // Escape in a field closes the card.
    async escape() {
      const input = document.querySelector('.audits-find-field input');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return window.until(() => document.querySelector('.audits-find') === null, 120);
    },
    measure() {
      const panel = document.querySelector('.audits-panel');
      const edge = box(panel).right;
      const list = document.querySelector('.audits-list');
      const past = [...panel.querySelectorAll('*')]
        .filter((element) => {
          const rectangle = box(element);
          return rectangle.width > 0 && rectangle.height > 0 && (rectangle.right > edge + ${EDGE_TOLERANCE_PX} || rectangle.left < box(panel).left - ${EDGE_TOLERANCE_PX});
        })
        .map((element) => element.className + ' right ' + Math.round(box(element).right - edge))
        .slice(0, 8);
      const rows = [...panel.querySelectorAll('.audits-rule > .audits-row')].map((row) => {
        const count = row.querySelector(':scope > .audits-count');
        return { title: row.querySelector('.audits-title').textContent, countShown: count !== null && box(count).width > 0 && box(count).right <= box(row).right + ${EDGE_TOLERANCE_PX}, countAtEdge: count !== null && box(row).right - box(count).right <= 12 };
      });
      const cutText = [...panel.querySelectorAll('.audits-title, .audits-breakdown, .audits-note-line, .audits-ready-text, .audits-find-title, .audits-find-status')].filter(cut);
      const trigger = document.querySelector('.audits-category');
      const scope = document.querySelector('.audits-scope');
      const pill = document.querySelector('.audits-pill-toggle');
      const apply = document.querySelector('.audits-ready .audits-apply');
      const toolbar = document.querySelector('.audits-toolbar');
      const label = trigger.querySelector('.dd-label');
      return {
        past,
        panelScroll: [panel.scrollWidth, panel.clientWidth],
        listScroll: [list.scrollWidth, list.clientWidth],
        toolbarScroll: [toolbar.scrollWidth, toolbar.clientWidth],
        rows,
        untitledCut: cutText.filter((element) => !(element.getAttribute('title') || '').trim()).map((element) => element.className + ': ' + element.textContent),
        categoryLabelCut: cut(label),
        categoryLabel: label.textContent,
        controlsInside: [trigger, scope, pill].every((control) => box(control).right <= box(toolbar).right + ${EDGE_TOLERANCE_PX} && box(control).width > 0),
        scopeTabsWhole: [...scope.querySelectorAll('.ui-tab')].every((tab) => !cut(tab)),
        pillWhole: !cut(pill),
        applyWhole: !cut(apply) && box(apply).right <= edge + ${EDGE_TOLERANCE_PX},
        heights: { pill: box(pill).height, tab: box(scope.querySelector('.ui-tab')).height, apply: box(apply).height },
        toolbarRows: new Set([trigger, scope, pill].map((control) => Math.round(box(control).top))).size,
        reviewShown: [...panel.querySelectorAll('.audits-review-button')].every((button) => box(button).width > 0 && box(button).right <= edge + ${EDGE_TOLERANCE_PX}),
      };
    },
  };
})();
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#111}' +
  '#host{position:relative}</style></head>' +
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
    for (const locale of ${JSON.stringify(LOCALES)}) {
      for (const width of ${JSON.stringify(WIDTHS_PX)}) {
        await host('window.mount(' + JSON.stringify(locale) + ', ' + width + ')');
        const ready = await host('window.steps.ready(' + JSON.stringify(locale) + ')');
        const measured = ready.drawn ? await host('window.steps.measure()') : undefined;
        const image = await win.webContents.capturePage({ x: 0, y: 0, width, height: ${PANE_HEIGHT_PX} });
        fs.writeFileSync(path.join(DIRECTORY, 'audits-' + locale + '-' + width + '.png'), image.toPNG());
        const fixes = ready.drawn ? await host('window.steps.fixesOpen()') : undefined;
        if (fixes && fixes.present) {
          const image = await win.webContents.capturePage({ x: 0, y: 0, width: width + 320, height: ${PANE_HEIGHT_PX} });
          fs.writeFileSync(path.join(DIRECTORY, 'audits-fixes-' + locale + '-' + width + '.png'), image.toPNG());
        }
        const fixesClosed = fixes && fixes.present ? await host('window.steps.fixesClose()') : undefined;
        const found = ready.drawn ? await host('window.steps.openFind()') : undefined;
        const measuredFind = found && found.opened ? await host('window.steps.measure()') : undefined;
        const findCard = found && found.opened ? await host('window.steps.measureFind()') : undefined;
        if (found && found.opened) {
          const image = await win.webContents.capturePage({ x: 0, y: 0, width, height: ${PANE_HEIGHT_PX} });
          fs.writeFileSync(path.join(DIRECTORY, 'audits-find-' + locale + '-' + width + '.png'), image.toPNG());
        }
        const escaped = found && found.opened ? await host('window.steps.escape()') : undefined;
        output.cases.push({ locale, width, ready, measured, fixes, fixesClosed, found, measuredFind, findCard, escaped });
      }
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

// The checks every drawing of the panel must pass, with Find & replace closed or open.
function checkMeasured(expect, where, width, measured) {
  expect(`${where}: no element is drawn past the panel's edges`, measured.past.length === 0, measured.past);
  expect(`${where}: the panel does not scroll sideways`, measured.panelScroll[0] <= measured.panelScroll[1], measured.panelScroll);
  expect(`${where}: the list does not scroll sideways`, measured.listScroll[0] <= measured.listScroll[1], measured.listScroll);
  expect(`${where}: the toolbar does not scroll sideways`, measured.toolbarScroll[0] <= measured.toolbarScroll[1], measured.toolbarScroll);
  expect(`${where}: the menu, the switch and Ignored are inside the toolbar`, measured.controlsInside === true);
  expect(`${where}: the category label is whole`, measured.categoryLabelCut === false, measured.categoryLabel);
  expect(`${where}: both scope tabs are whole`, measured.scopeTabsWhole === true);
  expect(`${where}: Ignored is whole`, measured.pillWhole === true);
  expect(`${where}: Apply is whole and inside the panel`, measured.applyWhole === true);
  expect(`${where}: Review buttons are whole and inside the panel`, measured.reviewShown === true);
  expect(`${where}: tap targets keep their height`, JSON.stringify(measured.heights) === JSON.stringify(HEIGHTS_PX), measured.heights);
  expect(
    `${where}: every rule's count is visible at the row's right`,
    measured.rows.every((row) => row.countShown && row.countAtEdge),
    measured.rows,
  );
  expect(`${where}: every cut text has its full wording as a tooltip`, measured.untitledCut.length === 0, measured.untitledCut);
  if (width === 260) {
    expect(`${where}: the narrowest panel reflows the toolbar to at least two rows`, measured.toolbarRows >= 2, measured.toolbarRows);
  }
}

function check(output) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  expect('every locale and width was drawn', output.cases.length === LOCALES.length * WIDTHS_PX.length, output.cases.length);
  for (const { locale, width, ready, measured, fixes, fixesClosed, found, measuredFind, findCard, escaped } of output.cases) {
    const where = `${locale} at ${width}px`;
    expect(`${where}: the panel drew its rules`, ready.drawn === true);
    if (measured !== undefined) {
      checkMeasured(expect, where, width, measured);
    }
    expect(`${where}: the fixes-ready line has an (i)`, fixes !== undefined && fixes.present === true, fixes);
    if (fixes !== undefined && fixes.present) {
      expect(`${where}: hover opens the list only after a wait`, fixes.openedAtOnce === false && fixes.hoverShown === true && fixes.hoverDelayMs >= 300, fixes);
      expect(`${where}: leaving closes a hover list`, fixes.hoverCloses === true);
      expect(
        `${where}: a click pins the list, and leaving does not close it`,
        fixes.pinned === true && fixes.stillPinned === true && fixes.expanded === 'true',
        fixes,
      );
      expect(`${where}: the list shows the cap and says how many more`, fixes.itemCount === 8 && /2/.test(fixes.more), [fixes.itemCount, fixes.more]);
      expect(`${where}: the list has a title with the count`, /10/.test(fixes.title), fixes.title);
      expect(`${where}: the list stays inside the window`, fixes.insideWindow === true);
      expect(`${where}: the list does not scroll sideways`, fixes.sidewaysScroll === false);
      expect(`${where}: every row has a name, a change and a place`, fixes.itemsHaveThreeLines === true && fixes.changeHasArrow === true);
      expect(`${where}: cut list text has a tooltip`, fixes.untitledCut === 0, fixes.untitledCut);
      expect(`${where}: the (i) sits beside the text inside the row`, fixes.infoInsideReady === true && fixes.infoBesideText === true, fixes);
      expect(`${where}: Escape closes the pinned list`, fixesClosed !== undefined && fixesClosed.escapeCloses === true, fixesClosed);
      expect(
        `${where}: a row goes to its element and closes the list`,
        fixesClosed !== undefined && fixesClosed.rowCloses === true && fixesClosed.rowRevealed === true,
        fixesClosed,
      );
      expect(
        `${where}: "+ N more" goes to the first hidden fix and closes the list`,
        fixesClosed !== undefined && fixesClosed.moreCloses === true && fixesClosed.moreRevealed === true,
        fixesClosed,
      );
    }
    expect(`${where}: Find & replace opens from the menu`, found !== undefined && found.opened === true, found);
    if (measuredFind === undefined || findCard === undefined) {
      continue;
    }
    checkMeasured(expect, `${where} with Find & replace open`, width, measuredFind);
    expect(`${where}: the card has a Find and a Replace field`, findCard.fieldCount === 2, findCard.fieldCount);
    expect(
      `${where}: both fields are single lines of one height`,
      findCard.inputsSingleLine && findCard.fieldHeights.every((height) => height === 28),
      findCard.fieldHeights,
    );
    expect(`${where}: both fields share one fill`, findCard.fieldFills === 1, findCard.fieldFills);
    expect(`${where}: the three option toggles sit inside the Find field`, findCard.togglesInsideFind === true);
    expect(`${where}: each toggle has a tooltip and a name`, findCard.toggleLabelled === true);
    expect(`${where}: a pressed toggle changes its fill`, found.pressedChangesFill === true && found.toggleCount === 3, found);
    expect(`${where}: the Find field keeps room to type`, findCard.queryInputWidth >= 60, findCard.queryInputWidth);
    expect(`${where}: the close button is whole and named`, findCard.closeShown === true);
    expect(`${where}: Find and Replace all are whole and inside the card`, findCard.buttonsInside === true);
    expect(
      `${where}: the card's buttons are 24px tall`,
      findCard.primaryHeight === HEIGHTS_PX.apply && findCard.secondaryHeight === HEIGHTS_PX.apply,
      findCard,
    );
    expect(`${where}: the card is inside the panel`, findCard.cardInsidePanel === true);
    expect(`${where}: the scope switch fills the card`, findCard.scopeEqual === true);
    expect(`${where}: a search with no hits says so`, findCard.status.length > 0, findCard.status);
    expect(`${where}: Escape closes the card`, escaped === true);
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
    console.log('audits-narrow-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/audits-narrow-chromium');
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
    console.error(`audits-narrow-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`audits-narrow-chromium: passed  [screenshots in ${directory}]`);
  }
})();
