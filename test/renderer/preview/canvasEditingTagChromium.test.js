// Goal: in the browser Desktop ships, typing in a text on the canvas hides the selection's name tag (the
// "Heading" chip above the outline) for every frame the editor is open, and only the purple source cue under a
// data-bound text remains. No frame shows the name tag and the cue together, and the name tag is back in the
// first frame after editing ends. The same holds for a component instance whose text is picked (the parent tag
// and the text mark's tag). Shared words keep their tag as the warning, with the name left out.
//
//   node test/renderer/preview/canvasEditingTagChromium.test.js
//
// Method: run under the Electron binary, because the tag is hidden by a `body:has(#stacki-canvas-text-editor)`
// rule and only Chromium's own selector matching and frame timing can show what is painted. A harness bundles
// the real PreviewOverlays, useCanvasText and CanvasTextSourceCue with the real styles.css; an iframe stands in
// for the canvas and posts avb:text-active and avb:text-inactive as the frame does. A requestAnimationFrame
// recorder samples, once per frame, whether the editor is open, whether a name tag is shown and whether the cue
// is shown. Three open and close cycles run for each scenario.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const CYCLES = 3;
const FRAMES_PER_PHASE = 8;

// The import paths are JSON-quoted: a Windows path's `\` inside a plain quoted string is an
// escape (`\s` is a syntax error in esbuild), so a quoted literal only works on POSIX.
const HARNESS = `
import ${JSON.stringify(repoPath('src/app/styles.css'))};
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewOverlays } from ${JSON.stringify(repoPath('src/features/preview/PreviewOverlays.tsx'))};
import { useCanvasText } from ${JSON.stringify(repoPath('src/features/preview/useCanvasText.ts'))};
import { CanvasTextSourceCue } from ${JSON.stringify(repoPath('src/app/shell/CanvasTextSourceCue.tsx'))};

const SCENARIOS = {
  element: { kind: 'element', label: 'Heading', textLabel: 'Heading', bound: true, picked: undefined },
  componentText: { kind: 'component', label: 'Card', textLabel: 'Heading', bound: true, picked: { x: 60, y: 260, w: 300, h: 40, label: 'Heading', kind: 'text' } },
  shared: { kind: 'element', label: 'Heading', textLabel: 'Shared CMS content', bound: false, picked: undefined },
};
const scenario = SCENARIOS[new URLSearchParams(location.search).get('scenario')];
const BOX = { x: 40, y: 200, w: 420, h: 160 };
const textBox = scenario.picked ?? BOX;
const posted = [];
const plan = {
  target: { kind: 'element', key: 'text:0', path: '0', parent: '0', value: 'Hello', label: scenario.textLabel, nested: false, tag: 'h2', siblings: [] },
  apply: async () => {},
  ...(scenario.bound ? { bound: { kind: 'source', expression: 'platformIntro.heading', file: 'src/lib/content.ts', uses: 1 } } : {}),
};
const page = {
  projectPath: '/fixture', file: '/fixture/src/pages/index.astro', source: '<h2>{platformIntro.heading}</h2>', nodes: [],
  pathFor: () => undefined, apply: async () => {}, report: (message) => posted.push({ type: 'report', message }), loadContent: async () => [plan],
};
const info = { label: scenario.label, kind: scenario.kind, tag: 'h2', astroAsset: false, dynamicTag: false, nodeKind: 'element', childCount: 0, isLayout: false, bound: false };
function Harness() {
  const frame = useRef(document.getElementById('canvas'));
  useCanvasText({ document: page, frame, url: location.href, post: (message) => posted.push(message), subscribeLoad: () => () => {} });
  return React.createElement(React.Fragment, undefined,
    React.createElement('div', { className: 'overlay-layer', style: { position: 'fixed', inset: 0 } },
      React.createElement(PreviewOverlays, {
        rects: { 0: [BOX] }, spacing: {}, scale: 1, selPath: '0', selOcc: 0, hoverPath: undefined, hoverOcc: undefined,
        focusPath: undefined, focusWhole: true, textMarks: { hover: undefined, picked: scenario.picked }, overlayInfo: () => info,
      })),
    React.createElement(CanvasTextSourceCue));
}
window.avb = { onCmsChanged: () => () => {} };
createRoot(document.getElementById('root')).render(React.createElement(Harness));
window.harness = { posted, textBox };
`;

const HOST =
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"><style>body{margin:0;background:#1e1e1e}' +
  '#canvas{position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0}</style></head>' +
  '<body><iframe id="canvas" src="/blank.html"></iframe><div id="root"></div><script src="/harness.js"></script></body></html>';

const PROBE = (directory) => `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0] === '/' ? 'host.html' : request.url.split('?')[0].slice(1);
    const file = path.join(DIRECTORY, name);
    if (!file.startsWith(DIRECTORY) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const output = { scenarios: {}, error: undefined };
  try {
    for (const scenario of ['element', 'componentText', 'shared']) {
      await win.loadURL('http://127.0.0.1:' + server.address().port + '/?scenario=' + scenario);
      // The catalog names the session and the text's key (a CMS text's key carries the catalog revision).
      let catalog;
      for (let spin = 0; spin < 200 && catalog === undefined; spin += 1) {
        catalog = await host('harness.posted.filter((message) => message.type === "avb:text-catalog" && message.targets.length > 0).pop()');
        if (catalog === undefined) { await sleep(20); }
      }
      if (catalog === undefined) { throw new Error(scenario + ': no catalog'); }
      const session = catalog.session;
      const key = catalog.targets[0].key;
      await host(\`
        window.frames_ = [];
        const shown = (element) => element !== null && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
        const record = () => {
          const tags = [...document.querySelectorAll('.node-outline.sel .node-outline-tag')].filter(shown);
          const cue = document.querySelector('.canvas-source-cue');
          window.frames_.push({
            editing: document.getElementById('stacki-canvas-text-editor') !== null,
            name: tags.some((tag) => getComputedStyle(tag).fontSize !== '0px'),
            warning: tags.some((tag) => getComputedStyle(tag, '::after').content.includes('Shared')),
            cue: cue !== null && cue.style.visibility === 'visible',
          });
          requestAnimationFrame(record);
        };
        requestAnimationFrame(record);
        window.fromFrame = (data) => document.getElementById('canvas').contentWindow.eval('parent.postMessage(' + JSON.stringify(data) + ', "*")');
        window.frameCount = () => window.frames_.length;
        true\`);
      const waitFrames = async (count) => { const start = await host('frameCount()'); for (let spin = 0; spin < 400 && (await host('frameCount()')) < start + count; spin += 1) { await sleep(5); } };
      await waitFrames(${FRAMES_PER_PHASE});
      for (let cycle = 0; cycle < ${CYCLES}; cycle += 1) {
        await host('fromFrame({ type: "avb:text-active", session: ' + JSON.stringify(session) + ', key: ' + JSON.stringify(key) + ', rect: harness.textBox }); true');
        await waitFrames(${FRAMES_PER_PHASE});
        await host('fromFrame({ type: "avb:text-inactive", session: ' + JSON.stringify(session) + ' }); true');
        await waitFrames(${FRAMES_PER_PHASE});
      }
      output.scenarios[scenario] = await host('window.frames_');
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log(JSON.stringify(output));
  win.destroy(); server.close(); app.quit();
});
`;

// The checks over one scenario's frames, as failure lines.
function checkFrames(name, frames, expect) {
  const failures = [];
  const editing = frames.filter((frame) => frame.editing);
  if (editing.length < CYCLES) {
    failures.push(`${name}: the editor was open in ${editing.length} frames`);
  }
  if (!frames.some((frame) => !frame.editing && frame.name)) {
    failures.push(`${name}: the selection never showed its name tag`);
  }
  editing.forEach((frame, index) => {
    if (frame.name) {
      failures.push(`${name}: editing frame ${index} shows the name tag`);
    }
    if (frame.cue !== expect.cue) {
      failures.push(`${name}: editing frame ${index} cue ${frame.cue}, expected ${expect.cue}`);
    }
    if (frame.warning !== expect.warning) {
      failures.push(`${name}: editing frame ${index} shared warning ${frame.warning}, expected ${expect.warning}`);
    }
  });
  frames.forEach((frame, index) => {
    if (frame.name && frame.cue) {
      failures.push(`${name}: frame ${index} shows the name tag and the cue together`);
    }
    const previous = frames[index - 1];
    if (previous !== undefined && previous.editing && !frame.editing) {
      if (!frame.name) {
        failures.push(`${name}: the first frame after editing (${index}) has no name tag`);
      }
      if (frame.cue) {
        failures.push(`${name}: the first frame after editing (${index}) still shows the cue`);
      }
    }
  });
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
    console.log('canvas-editing-tag-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/canvas-editing-tag-chromium');
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
  fs.writeFileSync(path.join(directory, 'blank.html'), '<!doctype html><body></body>');
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{"scenarios"'));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line);
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    }
    const expectations = {
      element: { cue: true, warning: false },
      componentText: { cue: true, warning: false },
      shared: { cue: false, warning: true },
    };
    for (const [name, expect] of Object.entries(expectations)) {
      const frames = output.scenarios[name];
      if (frames === undefined) {
        failures.push(`${name}: no frames recorded`);
      } else {
        failures.push(...checkFrames(name, frames, expect));
      }
    }
  }
  if (failures.length > 0) {
    console.error(`canvas-editing-tag-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('canvas-editing-tag-chromium: passed');
  }
})();
