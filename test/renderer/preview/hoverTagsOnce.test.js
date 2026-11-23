// Goal: hovering the text inside a Heading instance draws exactly ONE name tag for the text, the same "text" tag a click draws,
// never two tags printed over each other ("text" and "heading" garbled into one chip). The Heading's own green tag stays on the
// instance outline. Moving the pointer Heading root -> its text -> outside leaves no stale tag at any step.
//   node test/renderer/preview/hoverTagsOnce.test.js
// Method, two layers. (1) The real overlays are rendered to static markup (react-dom/server) for each pointer state, and the
// tags are counted with their labels. (2) Under the Electron binary the real PreviewOverlays and styles.css are bundled into a
// page, each state is rendered in Chromium, and every drawn tag's label and box is read: no two visible tags overlap, the
// hover state of the text has the same tags as its click state, and the outside state has none. The cause was a text mark's
// own tag drawn beside the text node outline's tag at the same corner; only the selection's tag had been kept clear of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/hover-tags-once.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const ENTRY = `export { PreviewOverlays } from './src/features/preview/PreviewOverlays';`;
buildSync({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { PreviewOverlays } = require(output);

// A Heading at the page's path 0.1 with its slot text at 0.1.0; the frame's hover mark for the same words carries the class label.
const RECTS = { 0.1: [{ x: 20, y: 100, w: 400, h: 60 }], '0.1.0': [{ x: 20, y: 100, w: 300, h: 60 }] };
const INFO = {
  0.1: { label: 'Heading', kind: 'component', nodeKind: 'component', tag: undefined },
  '0.1.0': { label: 'text', kind: 'element', nodeKind: 'text', tag: undefined },
};
const MARK = { x: 20, y: 100, w: 300, h: 60, label: 'heading', kind: 'text', scope: '0.1', owner: 'slot' };

function props(state) {
  return {
    rects: RECTS,
    spacing: {},
    scale: 1,
    selPath: state.selected,
    selOcc: 0,
    hoverPath: state.hovered,
    hoverOcc: state.hovered === undefined ? undefined : 0,
    focusPath: undefined,
    focusWhole: false,
    textMarks: { hover: state.mark, picked: state.picked },
    overlayInfo: (nodePath) => ({ astroAsset: false, dynamicTag: false, childCount: 0, isLayout: false, bound: false, ...INFO[nodePath] }),
  };
}

// The tags drawn, as their text.
function tags(state) {
  const markup = renderToStaticMarkup(React.createElement(PreviewOverlays, props(state)));
  return [...markup.matchAll(/<span class="node-outline-tag[^"]*">(.*?)<\/span>/g)].map((match) => match[1].replace(/<[^>]*>/g, ''));
}

const STATES = {
  rootHover: { hovered: '0.1' },
  textHover: { hovered: '0.1.0', mark: MARK },
  textHoverMarkOnly: { mark: MARK },
  textClick: { selected: '0.1.0', picked: MARK },
  outside: {},
};

test('hovering the Heading draws its own tag once', () => {
  assert.deepEqual(tags(STATES.rootHover), ['Heading']);
});

test('hovering its text draws one tag, "text", exactly as a click does', () => {
  assert.deepEqual(tags(STATES.textHover), ['text']);
  assert.deepEqual(tags(STATES.textClick), ['text']);
});

test("the pointer on text no node outline names still gets the mark's own tag, once", () => {
  assert.deepEqual(tags(STATES.textHoverMarkOnly), ['heading']);
});

test('the pointer outside everything leaves no tag', () => {
  assert.deepEqual(tags(STATES.outside), []);
});

// ---- Chromium ----
const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const out = { states: {}, error: undefined };
  try {
    await win.loadFile(path.join(${JSON.stringify(directory)}, 'host.html'));
    for (const name of ${JSON.stringify(Object.keys(STATES))}) {
      out.states[name] = await win.webContents.executeJavaScript('window.show(' + JSON.stringify(name) + ')');
    }
  } catch (error) { out.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(out));
  win.destroy(); app.quit();
});
`;

test('in Chromium no two tags overlap, hover equals click, and outside leaves none', (context) => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = undefined;
  }
  if (typeof electronPath !== 'string') {
    context.skip('needs the Electron binary');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/hover-tags-once');
  fs.mkdirSync(directory, { recursive: true });
  const harness = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PreviewOverlays } from ${JSON.stringify(repoPath('src/features/preview/PreviewOverlays.tsx'))};
const RECTS = ${JSON.stringify(RECTS)};
const INFO = ${JSON.stringify(INFO)};
const MARK = ${JSON.stringify(MARK)};
const STATES = ${JSON.stringify(STATES)};
const root = createRoot(document.getElementById('root'));
window.show = (name) => {
  const state = STATES[name];
  flushSync(() => root.render(React.createElement('div', { style: { position: 'relative', width: 800, height: 400 } },
    React.createElement(PreviewOverlays, {
      rects: RECTS, spacing: {}, scale: 1, selPath: state.selected, selOcc: 0, hoverPath: state.hovered, hoverOcc: state.hovered === undefined ? undefined : 0,
      focusPath: undefined, focusWhole: false, textMarks: { hover: state.mark, picked: state.picked },
      overlayInfo: (nodePath) => ({ astroAsset: false, dynamicTag: false, childCount: 0, isLayout: false, bound: false, ...INFO[nodePath] }),
    }))));
  return [...document.querySelectorAll('.node-outline-tag')].filter((tag) => getComputedStyle(tag).display !== 'none')
    .map((tag) => { const box = tag.getBoundingClientRect(); return { label: tag.textContent, x: box.left, y: box.top, w: box.width, h: box.height }; });
};
`;
  buildSync({
    stdin: { contents: harness, resolveDir: ROOT, loader: 'tsx', sourcefile: 'harness.tsx' },
    bundle: true,
    outfile: path.join(directory, 'harness.js'),
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  fs.writeFileSync(
    path.join(directory, 'host.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css"><style>body{margin:0;background:#1e1e1e}</style></head><body><div id="root"></div><script src="harness.js"></script></body></html>',
  );
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 90_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  assert.ok(line, `the probe ran: ${(run.stderr || run.stdout).slice(0, 800)}`);
  const result = JSON.parse(line.slice('RESULT '.length));
  assert.equal(result.error, undefined);
  const overlaps = (left, right) => left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h;
  for (const [name, drawn] of Object.entries(result.states)) {
    for (let first = 0; first < drawn.length; first += 1) {
      for (let second = first + 1; second < drawn.length; second += 1) {
        assert.equal(overlaps(drawn[first], drawn[second]), false, `${name}: tags "${drawn[first].label}" and "${drawn[second].label}" overlap`);
      }
    }
  }
  assert.deepEqual(
    result.states.textHover.map((tag) => tag.label),
    ['text'],
  );
  assert.deepEqual(
    result.states.textHover.map((tag) => tag.label),
    result.states.textClick.map((tag) => tag.label),
  );
  assert.deepEqual(result.states.outside, []);
});
