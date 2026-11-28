// Goal: in the browser Desktop ships, the phone preview's globe sits inside the title bar's address bar, left
// of "Open in browser", no bigger than the bar's other icons, and never on top of the address: at every
// width the address text ends before the globe (it truncates with an ellipsis instead). While on, the globe
// has the pressed fill. Its popover opens under the globe, inside the window, at its
// fixed width (16.25rem, or the window less its margins) with nothing scrolling sideways; it has a header with a
// switch and no divider; a typical network address fits on one line; Copy's check swaps the icon without
// changing the button's size; the restarting card (skeletons) is the size of the real one, so nothing jumps.
// Every fitted tooltip, the popover's help tip included, is capped at 20rem and wraps inside the window
// (the tip once measured about 1900px on one line).
//
//   node test/renderer/preview/phoneUrlBarChromium.test.js
//
// Method: run under the Electron binary, because only Chromium's own layout of the real styles.css and
// phonePreview.css shows overlap and size. A harness bundles the real PhonePreviewMenu (a fake preview in the
// state the page's query names) inside the address bar's markup as AppShell's UrlGroup draws it (reload,
// input, the host's trailing control, open), plus one FittedTooltip with a long text; the clipboard is a stub
// that accepts. A probe loads it at a narrow, a middle and a wide window, opens the popover, focuses the help
// mark, presses Copy and reads the boxes; then it loads the restarting state and compares the card. Every
// wait polls the page with a bound; none is a fixed pause. The jsdom suite (phonePreview.test.js) holds the
// behaviour and that AppShell hands the globe to UrlGroup.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const WIDTHS = [480, 900, 1600];
const TIP_PX_MAX = 320; // 20rem at the app's 16px root.
const POPOVER_PX = 260; // 16.25rem: the code (236px) plus 12px of popover padding on each side; there is no card inside the popover.

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PhonePreviewMenu } from ${JSON.stringify(repoPath('src/features/preview/phone/PhonePreviewMenu.tsx'))};
import FittedTooltip from ${JSON.stringify(repoPath('src/ui/FittedTooltip.tsx'))};

Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => undefined } });
const states = {
  on: { kind: 'on', port: 48781, addresses: [{ address: '192.168.100.135', interfaceName: 'en0' }], access: { kind: 'open' } },
  changing: { kind: 'changing', toward: 'network' },
};
const preview = { state: states[new URLSearchParams(location.search).get('state')], toggle() {}, chooseAccess() {} };
const LONG = 'A tooltip with a long explanation. '.repeat(12);
function Harness() {
  return React.createElement(React.Fragment, null,
    React.createElement('div', { className: 'titlebar', style: { display: 'flex', alignItems: 'center', padding: '0 12px', height: 44 } },
      React.createElement('span', { className: 'spacer' }),
      React.createElement('div', { className: 'url-group' },
        React.createElement('div', { className: 'url-bar' },
          React.createElement('button', { className: 'titlebar-btn url-reload', 'aria-label': 'Reload' }, 'R'),
          React.createElement('input', { className: 'url', readOnly: true, value: 'http://127.0.0.1:48781/blog/a-very-long-page-address/that/keeps/going/and/going' }),
          React.createElement(PhonePreviewMenu, { preview, route: '/blog/post', onCopyFailed() {} }),
          React.createElement('button', { className: 'titlebar-btn url-open', 'aria-label': 'Open in browser' }, 'O'))),
      React.createElement('span', { className: 'spacer' })),
    React.createElement(FittedTooltip, { anchor: { left: 40, width: 20, top: 500, bottom: 520 }, className: 'probe-tip' }, LONG));
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css">' +
  '<style>html,body{margin:0;background:#1e1e1e}</style></head><body><div id="root"></div><script src="/harness.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
app.on('window-all-closed', () => {});
const { pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
const BOX = 'const box = (element) => { if (!element) { return null; } const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };';
const READ_BAR = \`(() => { \${BOX}
  const input = document.querySelector('.url-bar .url');
  const style = getComputedStyle(input);
  const globe = document.querySelector('.url-bar .url-phone');
  const globeStyle = getComputedStyle(globe);
  return {
    input: box(input), paddingEnd: parseFloat(style.paddingRight), textOverflow: style.textOverflow, overflowing: input.scrollWidth > input.clientWidth,
    globe: box(globe), open: box(document.querySelector('.url-bar .url-open')),
    globeColor: globeStyle.color, globeBackground: globeStyle.backgroundColor, insideBar: globe.parentElement.classList.contains('url-bar'),
    probeTip: box(document.querySelector('.probe-tip')), viewport: { width: innerWidth, height: innerHeight },
  };
})()\`;
const READ_POPOVER = \`(() => { \${BOX}
  const popover = document.querySelector('.phone-preview');
  const url = document.querySelector('.phone-preview-url');
  const tip = document.querySelector('.rail-tooltip:not(.probe-tip)');
  return {
    popover: box(popover), sideways: popover.scrollWidth > popover.clientWidth,
    header: box(document.querySelector('.phone-preview-header')), switchBox: box(document.querySelector('.phone-preview-header [role="switch"]')),
    dividers: document.querySelectorAll('.phone-preview [role="separator"], .phone-preview .menu-divider, .phone-preview hr').length,
    card: box(document.querySelector('.phone-preview-card')),
    urlText: url && url.textContent, urlClipped: url ? url.scrollWidth > url.clientWidth : true, urlBox: box(url),
    copy: box(document.querySelector('.phone-preview-address button')), copyLabel: document.querySelector('.phone-preview-address button')?.getAttribute('aria-label'),
    tip: box(tip),
  };
})()\`;
const READ_COPY = \`(() => { \${BOX} const button = document.querySelector('.phone-preview-address button'); return { copy: box(button), label: button.getAttribute('aria-label'), url: box(document.querySelector('.phone-preview-url')) }; })()\`;
const READ_CARD = \`(() => { \${BOX} return { card: box(document.querySelector('.phone-preview-card')), skeletons: document.querySelectorAll('.phone-preview-card .ui-skeleton').length }; })()\`;
async function until(win, expression, limit) {
  const outcome = await pollUntil({ what: expression, read: () => win.webContents.executeJavaScript(expression), until: Boolean, pollCountMax: limit });
  return outcome.kind === 'reached';
}
// Motion (the popover's entrance, a button's transition) is finished: boxes read mid-animation are scaled.
const SETTLED = "document.getAnimations().every((animation) => animation.playState !== 'running')";
async function settle(win, what) {
  if (!(await until(win, SETTLED, 250))) { throw new Error('motion never settled for ' + what); }
}
async function openPopover(win, width) {
  await win.webContents.executeJavaScript("document.querySelector('.url-bar .url-phone').click()");
  if (!(await until(win, "document.querySelector('.phone-preview')?.dataset.popupPhase === 'open'", 250))) { throw new Error('the popover never opened at ' + width); }
}
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = (state) => 'http://127.0.0.1:' + server.address().port + '/?state=' + state;
  const output = { widths: {}, changing: undefined, error: undefined };
  try {
    for (const width of ${JSON.stringify(WIDTHS)}) {
      const win = new BrowserWindow({ show: false, width, height: 760, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
      await win.loadURL(page('on'));
      if (!(await until(win, "document.querySelector('.url-bar .url-phone') !== null", 250))) { throw new Error('the globe never rendered at ' + width); }
      await settle(win, 'the bar');
      const bar = await win.webContents.executeJavaScript(READ_BAR);
      await openPopover(win, width);
      // A hidden window holds no focus, so the focus React hears (focusin) is dispatched as the browser would.
      await win.webContents.executeJavaScript("document.querySelector('.phone-preview [aria-label=\\\\'Connection help\\\\']').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))");
      if (!(await until(win, "document.querySelector('.rail-tooltip:not(.probe-tip)') !== null", 250))) { throw new Error('the help tip never showed at ' + width); }
      await settle(win, 'the popover');
      const popover = await win.webContents.executeJavaScript(READ_POPOVER);
      fs.writeFileSync(path.join(DIRECTORY, 'popover-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.phone-preview-address button').click()");
      if (!(await until(win, "document.querySelector('.phone-preview-address button').getAttribute('aria-label') === 'Address copied'", 250))) { throw new Error('Copy never showed its check at ' + width); }
      await settle(win, 'Copy');
      const copied = await win.webContents.executeJavaScript(READ_COPY);
      output.widths[width] = { ...bar, ...popover, copied };
      if (width === ${JSON.stringify(WIDTHS[WIDTHS.length - 1])}) {
        await win.loadURL(page('changing'));
        if (!(await until(win, "document.querySelector('.url-bar .url-phone') !== null", 250))) { throw new Error('the globe never rendered while restarting'); }
        await openPopover(win, width);
        await until(win, "document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.target?.classList?.contains('ui-skeleton') || animation.effect?.pseudoElement === '::after')", 250);
        output.changing = await win.webContents.executeJavaScript(READ_CARD);
        fs.writeFileSync(path.join(DIRECTORY, 'popover-restarting.png'), (await win.webContents.capturePage()).toPNG());
      }
      win.destroy();
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log(JSON.stringify(output));
  server.close(); app.quit();
});
`;

function inside(box, viewport) {
  return box.left >= -0.5 && box.top >= -0.5 && box.right <= viewport.width + 0.5 && box.bottom <= viewport.height + 0.5;
}

// The checks over what the probe read, as failure lines.
function check(output) {
  const failures = [];
  for (const width of WIDTHS) {
    const read = output.widths[width];
    if (read === undefined) {
      failures.push(`${width}px was read`);
      continue;
    }
    const at = `at ${width}px:`;
    // The globe in the bar.
    if (!read.insideBar) {
      failures.push(`${at} the globe is a child of the address bar`);
    }
    if (read.globe.right > read.open.left + 0.5) {
      failures.push(`${at} the globe (right ${read.globe.right}) sits left of Open in browser (left ${read.open.left})`);
    }
    // Its pressed fill sits inside the bar with room above and below (phonePreview.css), centred on Open's row.
    if (read.globe.height > read.open.height + 0.5 || read.globe.width > read.open.width + 0.5) {
      failures.push(`${at} the globe (${read.globe.width}×${read.globe.height}) is no bigger than Open in browser (${read.open.width}×${read.open.height})`);
    }
    if (Math.abs(read.globe.top + read.globe.height / 2 - (read.open.top + read.open.height / 2)) > 0.5) {
      failures.push(`${at} the globe and Open in browser share a row`);
    }
    if (read.input.right - read.paddingEnd > read.globe.left + 0.5) {
      failures.push(`${at} the address text ends at ${read.input.right - read.paddingEnd}, past the globe at ${read.globe.left}`);
    }
    if (read.textOverflow !== 'ellipsis' || !read.overflowing) {
      failures.push(`${at} the long address truncates with an ellipsis (${read.textOverflow}, overflowing ${read.overflowing})`);
    }
    if (read.globeBackground === 'rgba(0, 0, 0, 0)') {
      failures.push(`${at} the globe has the pressed fill while on`);
    }
    // The popover.
    const expectedWidth = Math.min(POPOVER_PX, read.viewport.width - 16);
    if (Math.abs(read.popover.width - expectedWidth) > 0.5) {
      failures.push(`${at} the popover is ${read.popover.width}px wide, expected ${expectedWidth}`);
    }
    if (read.popover.top < read.globe.bottom) {
      failures.push(`${at} the popover (top ${read.popover.top}) opens under the globe (bottom ${read.globe.bottom})`);
    }
    if (!inside(read.popover, read.viewport)) {
      failures.push(`${at} the popover ${JSON.stringify(read.popover)} stays inside the window`);
    }
    if (read.sideways) {
      failures.push(`${at} nothing in the popover scrolls sideways`);
    }
    if (read.header === null || read.switchBox === null) {
      failures.push(`${at} a header with a switch`);
    } else if (read.switchBox.right > read.header.right + 0.5) {
      failures.push(`${at} the switch ends the header row`);
    }
    if (read.dividers !== 0) {
      failures.push(`${at} no divider (${read.dividers} found)`);
    }
    if (read.card === null) {
      failures.push(`${at} the card is there while on`);
    }
    if (read.urlText !== '192.168.100.135:48781/…') {
      failures.push(`${at} the address reads ${read.urlText}`);
    }
    if (width >= 900 && read.urlClipped) {
      failures.push(`${at} a typical network address fits on one line at the popover's width`);
    }
    if (read.urlBox !== null && read.urlBox.height > 24) {
      failures.push(`${at} the address stays on one line (height ${read.urlBox.height})`);
    }
    if (read.copied.label !== 'Address copied') {
      failures.push(`${at} Copy shows its check`);
    }
    for (const property of ['width', 'height', 'left', 'top']) {
      if (Math.abs(read.copied.copy[property] - read.copy[property]) > 0.5) {
        failures.push(`${at} Copy's ${property} changed from ${read.copy[property]} to ${read.copied.copy[property]} with its check`);
      }
      if (Math.abs(read.copied.url[property] - read.urlBox[property]) > 0.5) {
        failures.push(`${at} the address moved (${property}) when Copy showed its check`);
      }
    }
    // Tooltips.
    for (const [name, tip] of [
      ['the help tip', read.tip],
      ['a long fitted tip', read.probeTip],
    ]) {
      if (tip === null || tip === undefined) {
        failures.push(`${at} ${name} was read`);
        continue;
      }
      if (tip.width > TIP_PX_MAX + 0.5) {
        failures.push(`${at} ${name} is ${tip.width}px wide, past 20rem`);
      }
      if (tip.width > read.viewport.width - 16 + 0.5) {
        failures.push(`${at} ${name} keeps a margin from the window`);
      }
      if (!inside(tip, read.viewport)) {
        failures.push(`${at} ${name} ${JSON.stringify(tip)} stays inside the window`);
      }
    }
    if (read.probeTip && read.probeTip.height < 60) {
      failures.push(`${at} a long tip wraps onto several lines (height ${read.probeTip.height})`);
    }
  }
  const wide = output.widths[WIDTHS[WIDTHS.length - 1]];
  if (output.changing === undefined || output.changing.card === null) {
    failures.push('the restarting card was read');
  } else {
    if (output.changing.skeletons < 2) {
      failures.push(`the restarting card shows the tile and the address as skeletons (${output.changing.skeletons})`);
    }
    if (wide !== undefined && wide.card !== null && Math.abs(output.changing.card.height - wide.card.height) > 1) {
      failures.push(`the restarting card is ${output.changing.card.height}px tall, the real one ${wide.card.height}px: the popover would jump`);
    }
  }
  return failures;
}

(() => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    console.log('phone-url-bar-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/phone-url-bar-chromium');
  fs.mkdirSync(directory, { recursive: true });
  buildSync({
    stdin: { contents: HARNESS, resolveDir: repoPath('.'), loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    outfile: path.join(directory, 'harness.js'),
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{"widths"'));
  if (line === undefined) {
    console.error(`phone-url-bar-chromium: the probe printed no result\n${run.stdout}\n${run.stderr}`);
    process.exit(1);
  }
  const output = JSON.parse(line);
  if (output.error !== undefined) {
    console.error(`phone-url-bar-chromium: ${output.error}`);
    process.exit(1);
  }
  const failures = check(output);
  if (failures.length > 0) {
    console.error(`phone-url-bar-chromium: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`phone-url-bar-chromium: passed at ${WIDTHS.join('px, ')}px  [screenshots in ${directory}]`);
})();
