// Goal: a double click that lands inside an edited element's box but on no glyph (the empty corner beside the short last line of a
// heading, the band below its words, the gap at the end of a line) puts the blinking caret where the line geometry says, in the
// browser Desktop ships. Rule: the line nearest the point's height (clamped above the first line and below the last), then
// past that line's right edge the caret is at the end of the line, before its left edge at its start. So the bottom-right corner
// is the end of the last word, the top-right corner the end of the first line, the bottom-left corner of a centred heading
// the start of its last line (the native rule for the column too: a click beside the words never lands on "another line's
// character" or at the start of everything). A press on a glyph keeps the caret at that character. Negative space: a plain
// single line, a trailing <br> that makes no line of its own, a glyph in the neighbouring strong, and typing after the corner
// click, which appends at the caret.
//
//   node test/renderer/preview/canvasTextCaretCornerChromium.test.js
//
// Method: run under the Electron binary in a hidden window (show:false): selection, contenteditable and real mouse input exist
// only in Chromium. Waits poll state (test/helpers/waitFor.js), never a fixed pause. The catalog is the real planner's, the
// page the markup a Heading renders (see canvasSlotTextFocusChromium.test.js, whose harness this follows), the frame's whole
// preload bundled into an iframe. Each variant's click point is computed in the frame from the heading's box and its text's
// own line boxes, so the test follows the real layout; the caret is read back as the number of characters of the heading's
// text before it (Range#toString), which is independent of how the editor numbers its runs.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { canvasTextPlans } = loadRenderer('src/features/preview/canvasTextSource.ts');

const FILE = 'src/pages/index.astro';
const CHECKSUM = 'a'.repeat(64);
const FRAME_OFFSET_PX = 20;

const HEADING = (inner, extraStyle) =>
  `<h2 class="heading" data-avb-p="Heading.astro|0 0" style="font:40px/1.2 sans-serif;margin:0;padding:0;width:700px;text-transform:uppercase;${extraStyle || ''}">${inner}</h2>`;
const OWNER = (extraStyle) => HEADING('Real relationships.<br data-avb-p="0.1"><strong data-avb-p="0.2">Real results.</strong>\n  ', extraStyle);
const OWNER_SOURCE = '<Heading>Real relationships.<br /><strong>Real results.</strong></Heading>';

// `click` names where in the frame the point is: an `edge` of the heading's box (right/left, top/bottom insets in px) or a
// glyph (`glyph`: the text to find and the character index in it). `expect` is the characters of the heading's text before the
// caret: 'end' (all of it, trailing whitespace excluded), a number, or { startOf: 'words' } (where those words begin).
const VARIANTS = [
  {
    name: 'bottom-right empty corner: caret at the end of the last word',
    source: OWNER_SOURCE,
    html: OWNER(),
    click: { x: 'right', y: 'bottom' },
    expect: 'end',
    type: true,
  },
  {
    name: 'below the last line, at the right: caret at the end of the last word',
    source: OWNER_SOURCE,
    html: OWNER('padding-bottom:40px'),
    click: { x: 'right', y: 'bottom' },
    expect: 'end',
    type: true,
  },
  {
    name: 'top-right empty corner: caret at the end of the first line',
    source: OWNER_SOURCE,
    html: OWNER(),
    click: { x: 'right', y: 'top' },
    expect: 'Real relationships.'.length,
    type: true,
  },
  {
    name: 'bottom-left empty area of a centred heading: caret at the start of the last line',
    source: OWNER_SOURCE,
    html: OWNER('text-align:center'),
    click: { x: 'left', y: 'bottom' },
    expect: { startOf: 'Real results.' },
  },
  {
    name: 'single line, empty right end: caret at the end',
    source: '<Heading>Real relationships.</Heading>',
    html: HEADING('Real relationships.'),
    click: { x: 'right', y: 'middle' },
    expect: 'end',
    type: true,
  },
  {
    name: 'text then a trailing br: caret at the end of the words',
    source: '<Heading>Real relationships.<br /></Heading>',
    html: HEADING('Real relationships.<br data-avb-p="0.1">'),
    click: { x: 'right', y: 'bottom' },
    expect: 'Real relationships.'.length,
  },
  {
    name: 'a glyph in the strong: caret at that character',
    source: OWNER_SOURCE,
    html: OWNER(),
    click: { glyph: 'Real results.', index: 5 },
    expect: 'Real relationships.Real '.length,
  },
  {
    name: 'a glyph in the plain words: caret at that character',
    source: OWNER_SOURCE,
    html: OWNER(),
    click: { glyph: 'Real relationships.', index: 8 },
    expect: 'Real rel'.length,
  },
];

function catalogFor(variant) {
  const parsed = parsePage(variant.source, { locs: true });
  const targets = canvasTextPlans(variant.source, parsed.model.nodes, (id) => id.replace(/^n/, '')).map((plan) => plan.target);
  return { type: 'avb:text-catalog', session: 'one', file: FILE, checksum: CHECKSUM, targets };
}

// The frame's whole preload, as a preview iframe runs it; `#avb-design` in its address makes it a canvas that selects.
const FRAME_BUNDLE = `
import ${JSON.stringify(repoPath('electron/preload/preload.ts'))};
import { announceMapped } from ${JSON.stringify(repoPath('electron/preload/frameRegions.ts'))};
window.announce = announceMapped;
`;

// The host's side of a selection, as far as the frame can tell: it tracks the clicked node and focuses its text.
const HOST = (index) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<iframe id="frame" src="page${index}.html#avb-design" style="position:absolute;left:${FRAME_OFFSET_PX}px;top:${FRAME_OFFSET_PX}px;width:840px;height:560px;border:0"></iframe>
<script>
window.posted = [];
const frame = document.getElementById('frame');
addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== frame.contentWindow || !data || typeof data.type !== 'string' || !data.type.startsWith('avb:')) { return; }
  window.posted.push(data);
  if (data.type === 'avb:click-node' && typeof data.path === 'string') {
    frame.contentWindow.postMessage({ type: 'avb:track', paths: [data.path], scope: '', focus: data.path, focusOcc: data.occurrence }, '*');
    frame.contentWindow.postMessage({ type: 'avb:text-focus', paths: [data.path] }, '*');
  }
});
</script></body></html>`;

const PROBE = (directory, variants) => `
const { app, BrowserWindow } = require('electron');
const path = require('path');
const DIRECTORY = ${JSON.stringify(directory)};
const OFFSET = ${FRAME_OFFSET_PX};
const VARIANTS = ${JSON.stringify(variants)};
app.on('window-all-closed', () => {});
const { pollUntil } = require(${JSON.stringify(repoPath('test/helpers/waitFor.js'))});
const POLL_COUNT_MAX = 200;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, x: 0, y: 0, width: 900, height: 620, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const inFrame = (code) => host('document.getElementById("frame").contentWindow.eval(' + JSON.stringify(code) + ')');
  const pollRead = async (what, read, pollCountMax) => (await pollUntil({ what, read, until: Boolean, pollCountMax })).kind === 'reached';
  const pollFrame = (code, pollCountMax) => pollRead(code, () => inFrame(code), pollCountMax);
  const pollHost = (code, pollCountMax) => pollRead(code, () => host(code), pollCountMax);
  const nextTask = () => host('new Promise((resolve) => setTimeout(resolve, 0))');
  const editorOpen = '(document.querySelector("[data-avb-text-editor]") !== null)';
  // The caret as characters of the heading's text before it, and whether the selection is collapsed.
  const READ_CARET = '(() => { const heading = document.querySelector("h2"); const selection = getSelection(); if (selection.rangeCount === 0) { return { collapsed: selection.isCollapsed, before: -1 }; }' +
    ' const range = document.createRange(); range.setStart(heading, 0); range.setEnd(selection.anchorNode, selection.anchorOffset);' +
    ' return { collapsed: selection.isCollapsed, before: range.toString().length, editor: document.querySelector("[data-avb-text-editor]") ? document.querySelector("[data-avb-text-editor]").tagName : undefined, text: heading.textContent }; })()';
  const output = { variants: [], error: undefined };
  try {
    for (const [index, variant] of VARIANTS.entries()) {
      await win.loadFile(path.join(DIRECTORY, 'host' + index + '.html'));
      await pollHost('document.getElementById("frame").contentDocument.readyState === "complete"', POLL_COUNT_MAX);
      await pollRead('the page has focus', async () => { win.focus(); win.webContents.focus(); return host('document.hasFocus()'); }, POLL_COUNT_MAX);
      await inFrame('window.announce(); true');
      await pollHost('window.posted.length > 0', POLL_COUNT_MAX);
      await host('document.getElementById("frame").contentWindow.postMessage(' + JSON.stringify(variant.catalog) + ', "*"); true');
      await nextTask();
      await nextTask();
      const point = await inFrame('(() => {' +
        'const heading = document.querySelector("h2"); const box = heading.getBoundingClientRect(); const click = ' + JSON.stringify(variant.click) + ';' +
        'if (click.glyph) { const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);' +
        '  for (let node = walker.nextNode(); node; node = walker.nextNode()) { if (node.data.trim() === click.glyph) {' +
        '    const range = document.createRange(); range.setStart(node, click.index); range.setEnd(node, click.index + 1); const glyph = range.getBoundingClientRect();' +
        '    return { x: Math.round(glyph.left + glyph.width * 0.25), y: Math.round(glyph.top + glyph.height / 2), box: [box.left, box.top, box.right, box.bottom] }; } }' +
        '  return undefined; }' +
        'const x = click.x === "right" ? box.right - 5 : box.left + 2; const y = click.y === "top" ? box.top + 3 : click.y === "bottom" ? box.bottom - 3 : (box.top + box.bottom) / 2;' +
        'return { x: Math.round(x), y: Math.round(y), box: [box.left, box.top, box.right, box.bottom] }; })()');
      await pollFrame('document.elementFromPoint(' + point.x + ', ' + point.y + ') !== null && document.querySelector("h2").contains(document.elementFromPoint(' + point.x + ', ' + point.y + '))', POLL_COUNT_MAX);
      const result = { name: variant.name, point };
      result.fullText = await inFrame('document.querySelector("h2").textContent');
      for (let count = 1; count <= 2; count += 1) {
        win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x + OFFSET, y: point.y + OFFSET, button: 'left', clickCount: count });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + OFFSET, y: point.y + OFFSET, button: 'left', clickCount: count });
      }
      await pollFrame(editorOpen, POLL_COUNT_MAX);
      result.opened = await inFrame(READ_CARET);
      if (variant.type) {
        win.webContents.sendInputEvent({ type: 'char', keyCode: 'X' });
        await pollFrame('document.querySelector("h2").textContent.includes("X")', POLL_COUNT_MAX);
        result.typed = await inFrame('document.querySelector("h2").textContent');
      }
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await pollFrame('document.querySelector("[data-avb-text-editor]") === null', POLL_COUNT_MAX);
      output.variants.push(result);
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log(JSON.stringify(output));
  win.destroy(); app.quit();
});
`;

function expectedBefore(variant, fullText) {
  const trimmed = fullText.trimEnd();
  if (variant.expect === 'end') {
    return trimmed.length;
  }
  if (typeof variant.expect === 'number') {
    return variant.expect;
  }
  return trimmed.indexOf(variant.expect.startOf);
}

function check(variant, result) {
  const failures = [];
  const label = variant.name;
  const want = expectedBefore(variant, result.fullText);
  if (!result.opened.collapsed) {
    failures.push(`${label}: the selection is not a collapsed caret (click ${JSON.stringify(result.point)})`);
  }
  if (result.opened.before !== want) {
    failures.push(
      `${label}: caret after ${result.opened.before} characters, expected ${want} (editor ${result.opened.editor}; click ${JSON.stringify(result.point)})`,
    );
  }
  if (variant.type) {
    const trimmed = result.fullText.trimEnd();
    const expectedText = trimmed.slice(0, want) + 'X' + trimmed.slice(want);
    if (result.typed === undefined || !result.typed.trimEnd().startsWith(expectedText)) {
      failures.push(`${label}: typing did not insert at the caret (${JSON.stringify(result.typed)}, expected ${JSON.stringify(expectedText)})`);
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
    console.log('canvas-text-caret-corner-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/canvas-text-caret-corner-chromium');
  fs.mkdirSync(directory, { recursive: true });
  await build({
    stdin: { contents: FRAME_BUNDLE, resolveDir: repoPath('.'), loader: 'ts', sourcefile: 'frame.ts' },
    bundle: true,
    outfile: path.join(directory, 'frame.js'),
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
    define: { 'process.isMainFrame': 'false' },
    // The bridge half imports electron; a preview frame never runs it.
    plugins: [
      {
        name: 'no-electron',
        setup: (builder) => {
          builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const contextBridge={},ipcRenderer={},webUtils={};', loader: 'js' }));
        },
      },
    ],
  });
  const variants = VARIANTS.map((variant) => ({ ...variant, catalog: catalogFor(variant) }));
  variants.forEach((variant, index) => {
    const stamp = `<!--avb-d:${CHECKSUM}:${FILE}-->`;
    fs.writeFileSync(
      path.join(directory, `page${index}.html`),
      `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${variant.html}${stamp}<script src="frame.js"></script></body></html>`,
    );
    fs.writeFileSync(path.join(directory, `host${index}.html`), HOST(index));
  });
  const probe = path.join(directory, 'probe.js');
  fs.writeFileSync(probe, PROBE(directory, variants));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electronPath, [probe], { encoding: 'utf8', timeout: 120_000, env: environment });
  const line = (run.stdout || '').split('\n').find((text) => text.trim().startsWith('{"variants"'));
  const failures = [];
  if (line === undefined) {
    failures.push(`the browser probe ran\n    ${(run.stderr || run.stdout || '').slice(0, 1500)}`);
  } else {
    const output = JSON.parse(line);
    if (output.error !== undefined) {
      failures.push(`the probe ran to the end\n    ${output.error}`);
    }
    for (const [index, result] of output.variants.entries()) {
      failures.push(...check(VARIANTS[index], result));
    }
    if (process.env.STACKI_PROBE_DEBUG) {
      console.log(JSON.stringify(output, null, 1));
    }
  }
  if (failures.length > 0) {
    console.error(`canvas-text-caret-corner-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('canvas-text-caret-corner-chromium: passed');
  }
})();
