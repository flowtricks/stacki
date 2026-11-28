// Goal: in real Chromium layout the floating code window (the `<style>` CSS editor) stays open, on screen
// and untouched while the panels around it change: the Navigator and the right panel collapsing and
// expanding (by real mouse presses on their buttons), the window resizing, and another element being
// picked. Untouched means the same DOM node, still visible inside the viewport, with its text, its
// selection, its undo depth and its scroll position unchanged. Escape and the X still close it.
//
// Method: run under the Electron binary in a hidden window, because only Chromium lays out the window,
// its clipping to the viewport and the scroll position of the editor. A harness bundles the real
// CodeWindow, its stylesheet and a flex shell with two collapsible side panels and a list of elements.
// The probe types into the editor and scrolls it, then drives each change with real input events
// (sendInputEvent mouse presses at the button's centre, a resize of the window) and polls the page
// state after each one (test/helpers/waitFor.js, no fixed pauses) before reading the window back.
// The baseline is taken only once the editor has measured itself at full size: the window opens by
// scaling up, CodeMirror measures lines in screen pixels from an animation frame, and its next
// measure moves the scroll position to keep the same line in place. A baseline read before that
// frame (starved on a loaded runner) reported the correction as a change made by the first step.
//
// Run it with `node test/renderer/code/codeWindowStaysChromium.test.js`.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';
import CodeWindow from ${JSON.stringify(repoPath('src/features/code/CodeWindow.tsx'))};

const LINES = Array.from({ length: 120 }, (unused, index) => '.rule-' + index + ' { color: red; }').join('\\n');
let controls;
function Shell() {
  const [navigatorOpen, setNavigatorOpen] = React.useState(true);
  const [rightOpen, setRightOpen] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState('div1');
  const [nodes, setNodes] = React.useState(['s1', 'div1', 'div2']);
  const [open, setOpen] = React.useState(true);
  const [text, setText] = React.useState(LINES);
  controls = { setNodes, setOpen, selectedId };
  const panel = { background: '#222', color: '#ddd', padding: 8 };
  return React.createElement('div', { style: { display: 'flex', height: '100vh' } },
    navigatorOpen && React.createElement('div', { id: 'navigator', style: { ...panel, width: 160 } },
      nodes.map((id) => React.createElement('button', { key: id, className: 'row', 'data-id': id, onClick: () => setSelectedId(id) }, id))),
    React.createElement('button', { id: 'toggle-navigator', onClick: () => setNavigatorOpen((current) => !current) }, 'navigator'),
    React.createElement('div', { id: 'canvas', style: { flex: 1, background: '#333', color: '#ddd' } }, 'selected ' + selectedId),
    React.createElement('button', { id: 'toggle-right', onClick: () => setRightOpen((current) => !current) }, 'right'),
    rightOpen && React.createElement('div', { id: 'right', style: { ...panel, width: 200 } }, 'properties'),
    open && nodes.includes('s1') && React.createElement(CodeWindow, { title: '<style>', language: 'css', indentation: 'block', value: text, editorKey: 's1', onChange: setText, onClose: () => setOpen(false) }));
}
window.mount = () => {
  window.root = createRoot(document.getElementById('root'));
  window.root.render(React.createElement(Shell));
};
window.controls = () => controls;
window.read = () => {
  const node = document.querySelector('.code-window');
  const editor = document.querySelector('.cm-editor');
  if (!node || !editor) { return { shown: false }; }
  window.__first = window.__first || node;
  window.__editorFirst = window.__editorFirst || editor;
  const view = EditorView.findFromDOM(editor);
  const box = node.getBoundingClientRect();
  return {
    shown: true,
    sameNode: window.__first === node && window.__editorFirst === editor && document.contains(node),
    phase: node.getAttribute('data-popup-phase'),
    visible: box.width > 100 && box.height > 100 && box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && getComputedStyle(node).visibility !== 'hidden',
    box: { left: box.left, top: box.top, width: box.width, height: box.height },
    viewport: { width: innerWidth, height: innerHeight },
    text: view.state.doc.toString(),
    selection: [view.state.selection.main.anchor, view.state.selection.main.head],
    undo: undoDepth(view.state),
    scrollTop: view.scrollDOM.scrollTop,
    selected: controls.selectedId,
    navigatorOpen: !!document.getElementById('navigator'),
    rightOpen: !!document.getElementById('right'),
  };
};
window.center = (selector) => {
  const box = document.querySelector(selector).getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
};
// Resolves after a CodeMirror measure cycle has run, so no measurement is still waiting for a frame.
window.measured = () => new Promise((resolve) => {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
  view.requestMeasure({ read: () => view.defaultLineHeight, write: () => resolve(true) });
});
// The editor's idea of a line's height, against the height of a line as drawn.
window.lineHeights = () => {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
  return { measured: view.defaultLineHeight, drawn: document.querySelector('.cm-line').getBoundingClientRect().height };
};
window.prepare = () => {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
  view.dispatch({ changes: { from: view.state.doc.length, insert: '\\n/* unsaved */' }, userEvent: 'input.type' });
  view.dispatch({ selection: { anchor: 10, head: 18 } });
  view.focus();
  view.scrollDOM.scrollTop = 300;
  return window.read();
};
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>html,body{margin:0;background:#161616}</style></head>' +
  '<body><div id="root"></div><script src="/harness.js"></script></body></html>';

// The editor's measured line height and a drawn line agree to within layout rounding; a line
// measured while the window was still scaling differs by more (0.15 px at a scale of 0.99).
const LINE_HEIGHT_TOLERANCE_PX = 0.05;

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { MOTION_SETTLED_EXPRESSION, waitFor, waitForSteady } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
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
  const win = new BrowserWindow({ show: false, width: 1100, height: 700, useContentSize: true, webPreferences: { contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { steps: [], error: undefined };
  const until = (what, expression, test) => waitFor({ what, read: () => host(expression), until: test });
  const press = async (selector) => {
    const point = await host('window.center(' + JSON.stringify(selector) + ')');
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
      win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
  };
  try {
    await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
    await host('window.mount()');
    await until('the code window to draw', 'window.read()', (state) => state.shown && state.phase === 'open');
    // The window opens by scaling up: nothing is typed or scrolled until that motion is over and
    // the editor has measured its lines at the size they are drawn.
    await until('the opening motion over', MOTION_SETTLED_EXPRESSION, (settled) => settled === true);
    await waitFor({
      what: 'the editor to measure its lines at full size',
      read: async () => { await host('window.measured()'); return host('window.lineHeights()'); },
      until: (heights) => Math.abs(heights.measured - heights.drawn) <= ${LINE_HEIGHT_TOLERANCE_PX},
    });
    await host('window.prepare()');
    // The scroll draws new lines, which the editor measures a frame later.
    await host('window.measured()');
    const start = await waitForSteady({ what: 'the window at rest', read: () => host('window.read()'), until: (state) => state.shown && state.phase === 'open' });
    output.start = start;
    const record = async (name, ready) => {
      const state = await waitForSteady({ what: name, read: () => host('window.read()'), until: ready });
      output.steps.push({ name, state });
    };
    await press('#toggle-navigator');
    await record('Navigator collapsed', (state) => state.navigatorOpen === false);
    await press('#toggle-navigator');
    await record('Navigator expanded', (state) => state.navigatorOpen === true);
    await press('#toggle-right');
    await record('right panel collapsed', (state) => state.rightOpen === false);
    await press('#toggle-right');
    await record('right panel expanded', (state) => state.rightOpen === true);
    await press('.row[data-id="div2"]');
    await record('another element selected', (state) => state.selected === 'div2');
    win.setContentSize(800, 520);
    await record('window made smaller', (state) => state.viewport.width === 800 && state.viewport.height === 520);
    win.setContentSize(1100, 700);
    await record('window made larger', (state) => state.viewport.width === 1100 && state.viewport.height === 700);
    // Negative space: Escape closes it, and so does the X.
    await host('document.querySelector(".cm-content").focus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await record('Escape pressed', (state) => state.shown === false);
    await host('window.controls().setOpen(true)');
    await until('the window drawn again', 'window.read()', (state) => state.shown && state.phase === 'open');
    await press('.code-window-header button');
    await record('the X pressed', (state) => state.shown === false);
    await host('window.controls().setOpen(true)');
    await until('the window drawn once more', 'window.read()', (state) => state.shown && state.phase === 'open');
    await host('window.controls().setNodes(["div1", "div2"])');
    await record('the edited node deleted', (state) => state.shown === false);
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log('RESULT ' + JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

// Sub-pixel layout rounds; a window that moved by less than this stayed where it was.
const POSITION_TOLERANCE_PX = 1;

function check(output) {
  const failures = [];
  const expect = (name, condition, detail) => {
    if (!condition) {
      failures.push(detail === undefined ? name : `${name} (${JSON.stringify(detail)})`);
    }
  };
  if (output.error !== undefined) {
    failures.push(output.error);
    return failures;
  }
  const { start } = output;
  expect('the editor holds the typed text', start.text.includes('unsaved'));
  expect('the editor scrolled before the changes', start.scrollTop > 0, start.scrollTop);
  const stayed = [
    'Navigator collapsed',
    'Navigator expanded',
    'right panel collapsed',
    'right panel expanded',
    'another element selected',
    'window made smaller',
    'window made larger',
  ];
  for (const name of stayed) {
    const step = output.steps.find((entry) => entry.name === name);
    expect(`${name}: the step ran`, step !== undefined);
    if (step === undefined) {
      continue;
    }
    const { state } = step;
    expect(`${name}: the window is still open`, state.shown === true && state.phase === 'open', state);
    expect(`${name}: it is the same DOM node`, state.sameNode === true);
    expect(`${name}: it is visible and inside the window`, state.visible === true, state);
    expect(`${name}: its text is unchanged`, state.text === start.text);
    expect(`${name}: its selection is unchanged`, JSON.stringify(state.selection) === JSON.stringify(start.selection), state.selection);
    expect(`${name}: its undo history is unchanged`, state.undo === start.undo, state.undo);
    expect(`${name}: its scroll position is unchanged`, state.scrollTop === start.scrollTop, state.scrollTop);
  }
  const moved = (name) => {
    const step = output.steps.find((entry) => entry.name === name);
    return step === undefined ? undefined : Math.abs(step.state.box.left - start.box.left) + Math.abs(step.state.box.top - start.box.top);
  };
  expect('collapsing the Navigator does not move the window', moved('Navigator collapsed') <= POSITION_TOLERANCE_PX, moved('Navigator collapsed'));
  expect('expanding the right panel does not move the window', moved('right panel expanded') <= POSITION_TOLERANCE_PX, moved('right panel expanded'));
  for (const name of ['Escape pressed', 'the X pressed', 'the edited node deleted']) {
    expect(
      `${name}: the window closes`,
      output.steps.some((entry) => entry.name === name && entry.state.shown === false),
    );
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
    console.log('code-window-stays-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/code-window-stays-chromium');
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
  fs.writeFileSync(path.join(directory, 'host.html'), HOST);
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment, maxBuffer: 64 * 1024 * 1024 });
  const line = (run.stdout || '').split('\n').find((text) => text.startsWith('RESULT '));
  const failures =
    line === undefined ? [`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`] : check(JSON.parse(line.slice('RESULT '.length)));
  if (failures.length > 0) {
    console.error(`code-window-stays-chromium: ${failures.length} failure(s)`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log('code-window-stays-chromium: all checks passed');
})();
