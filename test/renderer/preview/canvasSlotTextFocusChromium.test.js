// Goal: a double click on a component's plain slot text opens its editor and the editor KEEPS focus, in the browser Desktop
// ships. The words sit in the instance's own element beside a `<br>` and a `<strong>` the page wrote (a Heading whose slot is
// `Real relationships.<br /><strong>Real results.</strong>`). Every variant must leave the editor focused after the double
// click and for as long as nothing else happens, accept typing, and end on Escape with the words restored. Negative space:
// the `strong` words keep their own editor, and the editor never closes by itself.
//
//   node test/renderer/preview/canvasSlotTextFocusChromium.test.js
//
// Method: run under the Electron binary, because focus, native selection, contenteditable, real mouse input and the focus
// rules of an iframe exist only in Chromium. The catalog is the real planner's (canvasTextPlans over the variant's Astro
// source); the page is the markup a Heading renders for it (`<Fragment set:html={content} />` after `slotContent` stripped
// every comment, so the words have no recorded run), tagged with the paths the dev plugin writes. The page runs in an iframe
// of a host page, with the frame's whole preload (preload.ts) bundled into it as in a preview frame; the host answers the
// frame's selections the way the app does (it tracks and focuses what was clicked). The probe double clicks with real input
// events, then samples the focused element, the frame's `avb:text-*` posts, the typed words and the end of the edit.
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

// Heading's own element, tagged as the dev plugin tags it: its template path and the instance's path.
const HEADING = (inner, instance) =>
  `<h2 class="heading text-style-h1" data-avb-p="Heading.astro|0 ${instance}" style="font:40px/1.2 sans-serif;margin:0;padding:0;width:450px;text-wrap:balance;text-transform:uppercase">${inner}</h2>`;
// The page's children keep their path attributes; the bare words have none. The trailing newline is the whitespace the
// component's template leaves before its closing tag.
const WORDS_PLUS_STRONG = (instance) =>
  HEADING(`Real relationships.<br data-avb-p="${instance}.1"><strong data-avb-p="${instance}.2">Real results.</strong>\n  `, instance);
const SLOT_SOURCE = '<Heading>Real relationships.<br /><strong>Real results.</strong></Heading>';

const VARIANTS = [
  {
    name: 'text beside a br and a strong (the owner case)',
    source: SLOT_SOURCE,
    html: WORDS_PLUS_STRONG('0'),
    words: 'Real relationships.',
    expectedEditor: 'H2',
  },
  {
    name: 'a resize just after opening is the open settling, a scroll later is the person leaving',
    source: SLOT_SOURCE,
    html: WORDS_PLUS_STRONG('0'),
    words: 'Real relationships.',
    expectedEditor: 'H2',
    movement: true,
  },
  {
    name: 'the owner case at the foot of a scrolled page',
    source: SLOT_SOURCE,
    html: '<div style="height:2000px"></div>' + WORDS_PLUS_STRONG('0'),
    words: 'Real relationships.',
    expectedEditor: 'H2',
    scrolled: true,
  },
  {
    name: 'plain text only',
    source: '<Heading>Real relationships.</Heading>',
    html: HEADING('Real relationships.', '0'),
    words: 'Real relationships.',
    expectedEditor: 'H2',
  },
  {
    name: 'text then a br',
    source: '<Heading>Real relationships.<br /></Heading>',
    html: HEADING('Real relationships.<br data-avb-p="0.1">', '0'),
    words: 'Real relationships.',
    expectedEditor: 'H2',
  },
  {
    name: 'strong only (worked before)',
    source: '<Heading><strong>Real results.</strong></Heading>',
    html: HEADING('<strong data-avb-p="0.0">Real results.</strong>', '0'),
    words: 'Real results.',
    expectedEditor: 'STRONG',
  },
  {
    name: 'strong beside plain text (worked before)',
    source: SLOT_SOURCE,
    html: WORDS_PLUS_STRONG('0'),
    words: 'Real results.',
    expectedEditor: 'STRONG',
  },
  {
    name: 'second copy of a loop-rendered instance',
    source: SLOT_SOURCE,
    html: WORDS_PLUS_STRONG('0') + WORDS_PLUS_STRONG('0'),
    words: 'Real relationships.',
    expectedEditor: 'H2',
    occurrence: 1,
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
<iframe id="frame" src="page${index}.html#avb-design" style="position:absolute;left:${FRAME_OFFSET_PX}px;top:${FRAME_OFFSET_PX}px;width:1000px;height:700px;border:0"></iframe>
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
// Waits are on state, never on a guessed duration: a poll of a page expression, one rendered frame apart, for at most
// POLL_COUNT_MAX polls (about three seconds). The result says whether the state was reached; a state that never arrives
// is reported by the samples below, not by a throw here, because several variants assert that something did NOT happen.
const POLL_COUNT_MAX = 200;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, x: 0, y: 0, width: 1100, height: 760, webPreferences: { contextIsolation: false, backgroundThrottling: false } });
  const host = (code) => win.webContents.executeJavaScript(code);
  const inFrame = (code) => host('document.getElementById("frame").contentWindow.eval(' + JSON.stringify(code) + ')');
  const frameTick = () => host('new Promise((resolve) => requestAnimationFrame(() => resolve(true)))');
  const pollFrame = async (code, pollCountMax) => {
    for (let poll = 0; poll < pollCountMax; poll += 1) {
      if (await inFrame(code)) { return true; }
      await frameTick();
    }
    return false;
  };
  // The product settles an open by the frame's own clock (OPEN_SETTLE_MS); the test reads that same clock instead of sleeping.
  const untilFrameClock = async (startMs, spanMs) => pollFrame('performance.now() - ' + startMs + ' >= ' + spanMs, POLL_COUNT_MAX);
  const frameClockMs = () => inFrame('performance.now()');
  const editorOpen = '(document.querySelector("[data-avb-text-editor]") !== null)';
  const editorClosed = '(document.querySelector("[data-avb-text-editor]") === null)';
  const click = async (x, y, count) => {
    for (let index = 1; index <= count; index += 1) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: index });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: index });
    }
    await pollFrame(editorOpen, POLL_COUNT_MAX);
  };
  const output = { variants: [], error: undefined };
  // The window takes the foreground a moment after it shows; the focus loop below waits until the page has it.
  try {
    for (const [index, variant] of VARIANTS.entries()) {
      await win.loadFile(path.join(DIRECTORY, 'host' + index + '.html'));
      for (let spin = 0; spin < 100 && (await host('document.getElementById("frame").contentDocument.readyState')) !== 'complete'; spin += 1) { await frameTick(); }
      for (let spin = 0; spin < 100 && !(await host('document.hasFocus()')); spin += 1) {
        win.focus();
        win.webContents.focus();
        await frameTick();
      }
      if (!(await host('document.hasFocus()'))) { throw new Error('the page never took focus'); }
      await inFrame('window.focusLog = []; for (const type of ["blur", "focus"]) { addEventListener(type, (event) => window.focusLog.push(type + ":" + (event.target === window ? "window" : event.target.nodeName))); } window.announce(); true');
      await host('window.focusLog = []; for (const type of ["blur", "focus"]) { addEventListener(type, (event) => window.focusLog.push(type + ":" + (event.target === window ? "window" : event.target.nodeName))); } true');
      // The announce is the frame's own message to the host; wait until the host has it.
      await host('new Promise((resolve) => { const check = () => (window.posted.length > 0 ? resolve(true) : requestAnimationFrame(check)); check(); })');
      await host('document.getElementById("frame").contentWindow.postMessage(' + JSON.stringify(variant.catalog) + ', "*"); true');
      // The frame handles the catalog message in a task of its own; two rendered frames have run it.
      await frameTick();
      await frameTick();
      if (variant.scrolled) {
        await inFrame('window.scrollTo(0, document.documentElement.scrollHeight); true');
        await pollFrame('document.documentElement.scrollTop > 0', POLL_COUNT_MAX);
      }
      const point = await inFrame('(() => {' +
        'const heading = document.querySelectorAll("h2")[' + (variant.occurrence || 0) + '];' +
        'const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);' +
        'for (let node = walker.nextNode(); node; node = walker.nextNode()) {' +
        '  if (node.data.trim() === ' + JSON.stringify(variant.words) + ') {' +
        '    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, node.length);' +
        '    const box = range.getBoundingClientRect();' +
        '    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };' +
        '  }' +
        '} return undefined; })()');
      const result = { name: variant.name, point };
      await click(point.x + OFFSET, point.y + OFFSET, 2);
      const openedAtMs = await frameClockMs();
      const sample = async () => {
        const inside = await inFrame('(() => {' +
          'const editor = document.querySelector("[data-avb-text-editor]");' +
          'const selection = getSelection();' +
          'return { editor: editor ? editor.tagName : undefined, focused: editor !== null && document.activeElement === editor,' +
          ' caretCollapsed: selection.isCollapsed, text: document.querySelectorAll("h2")[' + (variant.occurrence || 0) + '].textContent };' +
          '})()');
        result.frameFocusLog = await inFrame('window.focusLog');
        result.hostFocusLog = await host('window.focusLog');
        const types = await host('window.posted.map((message) => message.type + (message.reason ? ":" + message.reason : ""))');
        return { ...inside, types: types.filter((type) => type.startsWith('avb:text-') && type !== 'avb:text-marks' && type !== 'avb:text-selection' && type !== 'avb:text-catalog') };
      };
      if (variant.movement) {
        // A resize right after the open is inside the settle window: no clock wait, only the dispatch.
        await inFrame('window.dispatchEvent(new Event("resize")); true');
        result.opened = await sample();
        // A scroll once the window has passed is the person leaving; 100 ms of margin past OPEN_SETTLE_MS.
        await untilFrameClock(openedAtMs, 500);
        await inFrame('window.dispatchEvent(new Event("scroll")); true');
        await pollFrame(editorClosed, POLL_COUNT_MAX);
        result.moved = await sample();
        output.variants.push(result);
        continue;
      }
      result.opened = await sample();
      // Negative space: the editor never closes by itself, for longer than the settle window.
      await untilFrameClock(openedAtMs, 500);
      result.settled = await sample();
      win.webContents.sendInputEvent({ type: 'char', keyCode: 'X' });
      await pollFrame('(document.querySelector("[data-avb-text-editor]") !== null && document.querySelector("[data-avb-text-editor]").textContent.includes("X"))', POLL_COUNT_MAX);
      result.typed = await sample();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await pollFrame(editorClosed, POLL_COUNT_MAX);
      // The close is reported to the host by a message; wait until the host has it.
      await host('new Promise((resolve) => { let polls = 0; const check = () => (window.posted.some((message) => message.type === "avb:text-inactive") || polls >= ' + POLL_COUNT_MAX + ' ? resolve(true) : (polls += 1, requestAnimationFrame(check))); check(); })');
      result.closed = await sample();
      output.variants.push(result);
    }
  } catch (error) { output.error = String((error && error.stack) || error); }
  console.log(JSON.stringify(output));
  win.destroy(); app.quit();
});
`;

// The checks over one variant's samples, as failure lines.
function check(variant, result) {
  const failures = [];
  const label = variant.name;
  const posts = (sample) => sample.types.join(',');
  if (variant.movement) {
    if (!result.opened.focused || result.opened.types.includes('avb:text-inactive')) {
      failures.push(`${label}: a resize right after opening closed the editor (posts: ${posts(result.opened)})`);
    }
    if (result.moved.editor !== undefined || !result.moved.types.includes('avb:text-inactive')) {
      failures.push(`${label}: a scroll after the settle window did not end the edit`);
    }
    return failures;
  }
  if (result.opened.editor !== variant.expectedEditor) {
    failures.push(`${label}: editor is ${result.opened.editor}, expected ${variant.expectedEditor} (posts: ${posts(result.opened)})`);
  }
  if (!result.opened.focused) {
    failures.push(`${label}: the editor is not focused right after the double click (posts: ${posts(result.opened)})`);
  }
  if (!result.settled.focused) {
    failures.push(`${label}: the editor lost focus within 400 ms (posts: ${posts(result.settled)})`);
  }
  if (!result.settled.types.includes('avb:text-active') || result.settled.types.includes('avb:text-inactive')) {
    failures.push(`${label}: the editing session ended on its own (posts: ${posts(result.settled)})`);
  }
  if (!result.typed.text.includes('X')) {
    failures.push(`${label}: typing did not reach the words (${JSON.stringify(result.typed.text)})`);
  }
  if (result.closed.editor !== undefined || !result.closed.types.includes('avb:text-inactive')) {
    failures.push(`${label}: Escape did not end the edit`);
  }
  if (result.closed.text.includes('X')) {
    failures.push(`${label}: Escape did not restore the words (${JSON.stringify(result.closed.text)})`);
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
    console.log('canvas-slot-text-focus-chromium: skipped  [needs the Electron binary]');
    return;
  }
  const directory = repoPath('node_modules/.stacki-test/canvas-slot-text-focus-chromium');
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
    console.error(`canvas-slot-text-focus-chromium: ${failures.length} checks failed\n  ${failures.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('canvas-slot-text-focus-chromium: passed');
  }
})();
