// Goal: in the shared Menu every row's trailing content (a shortcut hint, a value with its chevron, a check, a
// switch) ends at one right edge, the row's right padding edge, so a hint is never pushed inward by a reserved
// check column. Multi-character chords (⌘⇧K) right-align with single letters, a long label is cut with an
// ellipsis before it can touch its hint, a row with nothing to show keeps only its label, and a descriptive first
// row (a toggle with a wrapped description) is laid out as before.
//
//   node test/renderer/ui/menuTrailingChromium.test.js
//
// Method: run under the Electron binary, because only Chromium lays out flex, ellipsis and wrapping. A harness
// bundles the real Menu and styles.css and opens one menu with every kind of row: the chat menu's hint-only rows
// (Pin P ... Delete D), a submenu with a value and chevron, check rows, a checked row that also has a key, a chord, a
// long label with a key, and a toggle with a description. The probe reads each row's box and padding, and the right
// edge of its last visible trailing element, and asserts they agree within 1px. The menu is captured as a
// screenshot in node_modules/.stacki-test/menu-trailing-chromium/. Waits are for a condition, bounded.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

// Sub-pixel layout rounds; trailing edges within this distance are the same edge.
const EDGE_TOLERANCE_PX = 1;

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import Menu from ${JSON.stringify(repoPath('src/ui/Menu.tsx'))};

const noop = () => {};
const item = (id, label, extra) => ({ kind: 'item', id, label, onSelect: noop, ...extra });
const entries = [
  { kind: 'toggle', id: 'keep', label: 'Ask me to keep AI changes', description: 'Review each change before it is kept, so nothing lands in your files unseen.', on: true, onChange: noop },
  { kind: 'divider', id: 'd1' },
  item('pin', 'Pin', { shortcut: 'P' }),
  item('unread', 'Mark as unread', { shortcut: 'U' }),
  item('rename', 'Rename', { shortcut: 'R' }),
  item('fork', 'Fork', { shortcut: 'F' }),
  { kind: 'submenu', id: 'section', label: 'Move to section', value: 'No section', entries: [item('none', 'No section', { checked: true })] },
  item('archive', 'Archive', { shortcut: 'A' }),
  item('delete', 'Delete', { shortcut: 'D', danger: true }),
  { kind: 'divider', id: 'd2' },
  item('chord', 'Open settings', { shortcut: '⌘⇧K' }),
  item('long', 'A label that is far too long to fit beside its key without being cut short', { shortcut: 'L' }),
  item('on', 'Checked', { checked: true }),
  item('off', 'Unchecked', { checked: false }),
  item('both', 'Checked with a key', { checked: true, shortcut: 'G' }),
  item('plain', 'Nothing at the end'),
];
window.mount = () => {
  window.root?.unmount();
  document.getElementById('host').innerHTML = '<button id="anchor" style="position:absolute;left:20px;top:20px">Open</button><div id="root"></div>';
  window.root = createRoot(document.getElementById('root'));
  const anchor = document.getElementById('anchor');
  window.root.render(React.createElement(Menu, { open: true, anchor, entries, label: 'Chat actions', onClose: noop, widthPxMin: 280 }));
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
`;

const STEPS = `
window.steps = {
  async measure() {
    const drawn = await window.until(() => document.querySelectorAll('.menu-row').length >= 10);
    if (!drawn) { return { drawn: false }; }
    await window.until(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    const rows = [...document.querySelectorAll('.menu-row')].map((row) => {
      const box = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      const edge = box.right - parseFloat(style.paddingRight);
      const end = row.querySelector('.menu-end');
      const label = row.querySelector('.menu-label');
      const trailing = end === null ? [] : [...end.children].filter((child) => child.getBoundingClientRect().width > 0);
      const last = trailing.at(-1);
      const key = row.querySelector('.menu-key');
      const value = row.querySelector('.menu-value');
      const chevron = row.querySelector('.menu-end > svg');
      return {
        label: label.textContent,
        edgeGap: last === undefined ? undefined : Math.round((edge - last.getBoundingClientRect().right) * 10) / 10,
        trailing: trailing.map((child) => child.className.baseVal === undefined ? child.className : 'svg'),
        labelEndsBeforeEnd: end === null || label.getBoundingClientRect().right <= end.getBoundingClientRect().left + 0.5,
        labelCut: label.scrollWidth > label.clientWidth + 1,
        labelTitled: true,
        keyText: key === null ? undefined : key.textContent,
        keyRight: key === null ? undefined : Math.round(key.getBoundingClientRect().right * 10) / 10,
        valueChevronGap: value === null || chevron === null ? undefined : Math.round((chevron.getBoundingClientRect().left - value.getBoundingClientRect().right) * 10) / 10,
        hasCheck: row.querySelector('.menu-check') !== null,
        hasEnd: end !== null && trailing.length > 0,
        rowLeft: Math.round(box.left),
        labelLeft: Math.round(label.getBoundingClientRect().left),
      };
    });
    const surface = document.querySelector('.menu-surface').getBoundingClientRect();
    const first = document.querySelector('.menu-row');
    return {
      drawn: true,
      rows,
      surfaceRight: Math.round(surface.right),
      firstRowHeight: Math.round(first.getBoundingClientRect().height),
      descriptionWraps: document.querySelector('.menu-description').getBoundingClientRect().height > 18,
      sideways: document.querySelector('.menu-surface').scrollWidth > document.querySelector('.menu-surface').clientWidth + 1,
    };
  },
};
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#161616}</style></head>' +
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
  const win = new BrowserWindow({ show: false, width: 420, height: 700, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { measured: undefined, error: undefined };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await host('window.mount()');
    output.measured = await host('window.steps.measure()');
    await new Promise((resolve) => setTimeout(resolve, 400));
    fs.writeFileSync(path.join(DIRECTORY, 'menu.png'), (await win.webContents.capturePage()).toPNG());
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

function check(measured) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  expect('the menu drew', measured.drawn === true);
  if (measured.drawn !== true) {
    return failures;
  }
  const row = (label) => measured.rows.find((entry) => entry.label === label);
  const withEnd = measured.rows.filter((entry) => entry.hasEnd);
  expect('there are trailing elements to compare', withEnd.length >= 10, withEnd.length);
  for (const entry of withEnd) {
    expect(`"${entry.label}": its trailing content ends at the row's padding edge`, Math.abs(entry.edgeGap) <= EDGE_TOLERANCE_PX, entry);
    expect(`"${entry.label}": the label ends before its trailing content`, entry.labelEndsBeforeEnd === true, entry);
  }
  const gaps = withEnd.map((entry) => entry.edgeGap);
  expect('every trailing edge is the same edge', Math.max(...gaps) - Math.min(...gaps) <= EDGE_TOLERANCE_PX, gaps);
  for (const label of ['Pin', 'Mark as unread', 'Rename', 'Fork', 'Archive', 'Delete', 'Open settings']) {
    expect(
      `"${label}": a hint-only row ends its hint at the edge`,
      row(label) !== undefined && Math.abs(row(label).edgeGap) <= EDGE_TOLERANCE_PX && row(label).hasCheck === false,
      row(label),
    );
  }
  const keyRights = ['Pin', 'Mark as unread', 'Rename', 'Fork', 'Archive', 'Delete', 'Open settings'].map((label) => row(label).keyRight);
  expect('single letters and the chord right-align to one x', Math.max(...keyRights) - Math.min(...keyRights) <= EDGE_TOLERANCE_PX, keyRights);
  const section = row('Move to section');
  expect(
    'the value and its chevron end at the edge, together',
    section !== undefined && Math.abs(section.edgeGap) <= EDGE_TOLERANCE_PX && section.valueChevronGap >= 0 && section.valueChevronGap <= 10,
    section,
  );
  expect('the value row and the hint rows share one edge', Math.abs(section.edgeGap - row('Pin').edgeGap) <= EDGE_TOLERANCE_PX);
  expect(
    'a checked row ends with its check at the edge',
    row('Checked').hasCheck === true && Math.abs(row('Checked').edgeGap) <= EDGE_TOLERANCE_PX,
    row('Checked'),
  );
  expect('an unchecked row in a menu with checks draws no reserved column', row('Unchecked').hasEnd === false, row('Unchecked'));
  const both = row('Checked with a key');
  expect(
    'a checked row that also has a key ends with its check, the key beside it',
    both.hasCheck === true && Math.abs(both.edgeGap) <= EDGE_TOLERANCE_PX && both.keyText === 'G',
    both,
  );
  expect('a row with nothing to show has only its label', row('Nothing at the end').hasEnd === false, row('Nothing at the end'));
  const long = measured.rows.find((entry) => entry.label.startsWith('A label that is far too long'));
  expect(
    'a long label is cut with an ellipsis and never touches its hint',
    long.labelCut === true && long.labelEndsBeforeEnd === true && Math.abs(long.edgeGap) <= EDGE_TOLERANCE_PX,
    long,
  );
  const toggle = measured.rows[0];
  expect(
    'the descriptive first row keeps its toggle at the edge and its description wrapped',
    Math.abs(toggle.edgeGap) <= EDGE_TOLERANCE_PX && measured.descriptionWraps === true,
    toggle,
  );
  expect(
    'every label starts at one x',
    new Set(measured.rows.map((entry) => entry.labelLeft - entry.rowLeft)).size === 1,
    measured.rows.map((entry) => entry.labelLeft - entry.rowLeft),
  );
  expect('the menu does not scroll sideways', measured.sideways === false);
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
    console.log('menu-trailing-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/menu-trailing-chromium');
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
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment, maxBuffer: 64 * 1024 * 1024 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line.slice('RESULT '.length));
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    } else {
      failures.push(...check(output.measured));
    }
  }
  if (failures.length > 0) {
    console.error(`menu-trailing-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`menu-trailing-chromium: passed  [screenshot in ${directory}]`);
  }
})();
