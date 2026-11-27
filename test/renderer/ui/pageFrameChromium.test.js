// A page in a still frame, or a copy of it, is laid out at the frame's whole width on a computer with classic
// scrollbars.
//
//   node test/renderer/ui/pageFrameChromium.test.js
//
// Goal: Design mode's frames (DesignFrameDocument, the real component) and every still frame (STILL_PAGE_FRAME:
// insert pictures, component previews, audits) give the person's page the width on their label, whatever the page's
// CSS says about its own scrollbar, at first load and after the frame is resized, and read its height at that width.
// The page's own scroll areas keep their bars. shared/properties/canvasScrollbar.ts says which frame takes what.
//
// Method: a real Electron window (jsdom has no layout and draws no scrollbars), forced to classic scrollbars
// (test/helpers/classicScrollbars.js), renders the component, bundled by esbuild, into 400px frames over pages that
// each make Chromium draw or reserve a bar. Each page is also drawn in an untreated frame, which must lose width:
// without that a computer drawing overlay bars would pass everything. The width is read from a box fixed to both
// sides of the frame's viewport and from <body>: <html>'s clientWidth still reads the whole width beside a reserved
// gutter. Every wait is a bounded poll (test/helpers/waitFor.js).

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { classicScrollbarArguments } = require('../../helpers/classicScrollbars.js');

const WIDTH_PX = 400;
const NARROW_PX = 320;
const SCREEN_PX = 600;
const PROBE_MS_MAX = 120_000;

const BLOCK = '<div style="height:2000px"></div>';
const page = (css, body = BLOCK, html = '') => `<!doctype html><html${html}><head><style>body{margin:0}${css}</style></head><body>${body}</body></html>`;
// Taller than the 30,000px a Design mode frame is drawn: it scrolls inside its frame.
const PAST_CAP = '<div style="height:31000px"></div>';

// Each page makes Chromium take width from an untreated frame. `still` is whether STILL_PAGE_FRAME alone is enough:
// a reserved gutter and a scrolling <body> are the page's own boxes, which only a copy the app writes into loses.
const PAGES = {
  tallerThanTheCap: { html: page('', PAST_CAP), still: true, heightPx: 30_000 },
  // Always overflows by its padding, however tall the frame grows: no cap is needed to show a bar.
  overflowsAnyHeight: { html: page('html,body{height:100%}body{padding-top:10px}', 'x'), still: true },
  alwaysScrollbar: { html: page('html{overflow-y:scroll}', 'x'), still: true, heightPx: SCREEN_PX },
  styledScrollbar: { html: page('::-webkit-scrollbar{width:15px}', PAST_CAP), still: true, heightPx: 30_000 },
  higherSpecificity: { html: page('html#a:root{scrollbar-width:auto!important}', PAST_CAP, ' id="a"'), still: true, heightPx: 30_000 },
  cascadeLayer: { html: page('@layer reset{html{scrollbar-width:auto!important}}', PAST_CAP), still: true, heightPx: 30_000 },
  inlineImportant: { html: page('', PAST_CAP, ' style="scrollbar-width:auto!important"'), still: true, heightPx: 30_000 },
  stableGutter: { html: page('html{scrollbar-gutter:stable}'), still: false, heightPx: 2000 },
  layeredGutter: { html: page('@layer reset{html{scrollbar-width:auto!important;scrollbar-gutter:stable}}'), still: false, heightPx: 2000 },
  bodyScrolls: { html: page('html{height:100%;overflow:hidden}body{height:100%;overflow-y:scroll}'), still: false, heightPx: 2000 },
};
// The page's own scroll area, which keeps its bar in every frame.
const NESTED = page('', '<div id="nested" style="width:300px;height:100px;overflow-y:scroll"><div style="height:900px"></div></div>');

// Runs in the probe window: the real component, and plain frames to compare it with.
const ENTRY = `
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DesignFrameDocument } from './src/app/designMode/DesignFrameDocument';
import { STILL_PAGE_FRAME, hidePageRootScrollbar } from './shared/properties/canvasScrollbar';

let setWidth;
let latest;
let root;
let holder;
function Tile({ html }) {
  const [widthPx, set] = useState(${WIDTH_PX});
  const [measure, setMeasure] = useState(undefined);
  setWidth = set;
  latest = measure;
  return createElement(DesignFrameDocument, {
    html, title: 'frame', widthPx, heightPx: measure?.heightPx ?? ${SCREEN_PX}, floorPx: ${SCREEN_PX}, onMeasure: setMeasure,
  });
}

/** The width a page lays out in: a box fixed to both sides of its viewport, and its <body>. */
function widths(document) {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;right:0;top:0;height:1px;margin:0';
  document.documentElement.appendChild(probe);
  const fixed = probe.getBoundingClientRect().width;
  probe.remove();
  return { fixed, body: document.body.clientWidth, nested: document.getElementById('nested')?.clientWidth };
}

window.mountDesignFrame = (html) => {
  root?.unmount();
  holder?.remove();
  latest = undefined;
  holder = document.body.appendChild(document.createElement('div'));
  root = createRoot(holder);
  root.render(createElement(Tile, { html }));
};
window.resizeDesignFrame = (widthPx) => setWidth(widthPx);
window.readDesignFrame = () => {
  const frame = holder.querySelector('iframe');
  if (latest === undefined || frame.contentDocument !== latest.document) {
    return undefined;
  }
  return { ...widths(frame.contentDocument), heightPx: latest.heightPx, revision: latest.revision, frameWidthPx: frame.offsetWidth };
};
window.plainFrame = (html, treatment) =>
  new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.style.cssText = 'width:${WIDTH_PX}px;height:${SCREEN_PX}px;border:0';
    if (treatment !== 'none') {
      frame.setAttribute('scrolling', STILL_PAGE_FRAME.scrolling);
    }
    frame.addEventListener('load', () => {
      if (treatment === 'copy') {
        hidePageRootScrollbar(frame.contentDocument);
        hidePageRootScrollbar(frame.contentDocument);
      }
      const read = widths(frame.contentDocument);
      const added = frame.contentDocument.querySelectorAll('style').length - new DOMParser().parseFromString(html, 'text/html').querySelectorAll('style').length;
      frame.contentDocument.documentElement.scrollTop = 100;
      const scrolledPx = frame.contentDocument.documentElement.scrollTop;
      frame.remove();
      resolve({ ...read, added, scrolledPx });
    });
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
`;

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const { waitFor } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
const PAGES = ${JSON.stringify(PAGES)};
const NESTED = ${JSON.stringify(NESTED)};
app.setPath('userData', ${JSON.stringify(path.join(directory, 'user-data'))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await window.loadFile(${JSON.stringify(path.join(directory, 'host.html'))});
  const run = (code) => window.webContents.executeJavaScript(code);
  const designFrame = async (html) => {
    await run('mountDesignFrame(' + JSON.stringify(html) + ')');
    const first = await waitFor({ what: 'the frame measured', read: () => run('readDesignFrame()'), until: (read) => read !== undefined });
    await run('resizeDesignFrame(${NARROW_PX})');
    const narrow = await waitFor({
      what: 'the resized frame measured again',
      read: () => run('readDesignFrame()'),
      until: (read) => read !== undefined && read.frameWidthPx === ${NARROW_PX} && read.revision > first.revision,
    });
    return { first, narrow };
  };
  const plain = (html, treatment) => run('plainFrame(' + JSON.stringify(html) + ', ' + JSON.stringify(treatment) + ')');
  const results = {};
  for (const [name, { html }] of Object.entries(PAGES)) {
    results[name] = {
      untreated: await plain(html, 'none'),
      still: await plain(html, 'still'),
      copy: await plain(html, 'copy'),
      design: await designFrame(html),
    };
  }
  const nested = { untreated: await plain(NESTED, 'none'), copy: await plain(NESTED, 'copy'), design: await designFrame(NESTED) };
  process.stdout.write('RESULT ' + JSON.stringify({ results, nested }) + '\\n', () => app.exit(0));
}).catch((error) => {
  process.stderr.write(String(error && error.stack || error) + '\\n', () => app.exit(1));
});
`;

function runProbe(electron, directory) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const probe = path.join(directory, 'probe.js');
  return new Promise((resolve) => {
    const child = spawn(electron, [probe, '--use-mock-keychain', ...classicScrollbarArguments()], { env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    // Only a ceiling for a hung probe: the checks take as long as the machine needs.
    const timer = setTimeout(() => child.kill(), PROBE_MS_MAX);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

function wholeWidth(read, widthPx, what) {
  assert.equal(read.fixed, widthPx, `${what}: the viewport is the frame's whole width ${JSON.stringify(read)}`);
  assert.equal(read.body, widthPx, `${what}: the page lays out at the frame's whole width ${JSON.stringify(read)}`);
}

function checkResults({ results, nested }) {
  let checked = 0;
  for (const [name, { still, heightPx }] of Object.entries(PAGES)) {
    const read = results[name];
    assert.ok(read.untreated.body < WIDTH_PX, `${name}: classic scrollbars are on, an untreated frame loses width ${JSON.stringify(read.untreated)}`);
    if (still) {
      wholeWidth(read.still, WIDTH_PX, `${name} in a still frame`);
    }
    wholeWidth(read.copy, WIDTH_PX, `${name} in a copy`);
    assert.equal(read.copy.added, 1, `${name}: written once however often`);
    assert.equal(read.copy.scrolledPx, read.untreated.scrolledPx, `${name}: the app can still scroll the page`);
    wholeWidth(read.design.first, WIDTH_PX, `${name} in a Design mode frame`);
    wholeWidth(read.design.narrow, NARROW_PX, `${name} in a resized Design mode frame`);
    if (heightPx !== undefined) {
      assert.equal(read.design.first.heightPx, heightPx, `${name}: the height is read at the whole width`);
    }
    checked += 1;
  }
  const bar = 300 - nested.untreated.nested;
  assert.ok(bar > 0, `the page's own scroll area draws a bar ${JSON.stringify(nested)}`);
  assert.equal(nested.copy.nested, 300 - bar, 'a copy leaves the page’s own scroll area its bar');
  assert.equal(nested.design.first.nested, 300 - bar, 'a Design mode frame leaves the page’s own scroll area its bar');
  return checked;
}

(async () => {
  let electron;
  try {
    electron = require('electron');
  } catch {
    electron = undefined;
  }
  if (typeof electron !== 'string') {
    console.log('page-frame-chromium: skipped  [needs a Chromium — see test/renderer/style/computedColor.test.js]');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-frame-'));
  try {
    buildSync({
      stdin: { contents: ENTRY, resolveDir: repoPath('.'), loader: 'ts' },
      outfile: path.join(directory, 'entry.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    fs.writeFileSync(
      path.join(directory, 'host.html'),
      '<!doctype html><meta charset="utf-8"><style>iframe{border:0}</style><body><script src="entry.js"></script></body>',
    );
    fs.writeFileSync(path.join(directory, 'probe.js'), PROBE(directory));
    const run = await runProbe(electron, directory);
    const line = run.stdout.split('\n').find((text) => text.startsWith('RESULT '));
    assert.ok(line !== undefined, `the browser probe ran: ${(run.stderr || run.stdout).slice(0, 3000)}`);
    const checked = checkResults(JSON.parse(line.slice('RESULT '.length)));
    console.log(`page-frame-chromium: ${checked} pages kept their frame's whole width, their own scroll areas kept their bars`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
