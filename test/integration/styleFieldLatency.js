// Goal: how long a Style panel value field takes to show a committed custom value and a cleared
// one, in the real app, stage by stage: Enter (or the Clear press) → the stylesheet write sent →
// the file on disk → the app's CSS-changed event → the canvas showing the colour → the canvas's
// stylesheet replaced by the dev server → the field showing the new value. The product rule is
// that the field changes in the frame of the key press; this measures whether it does and, when it
// does not, which stage it waits for.
//
// Method: test/helpers/e2e/soakLaunch.js starts the real desktop app (main from dist/electron,
// renderer from a private Vite server over the working tree, real Astro dev server, real canvas)
// on a scratch copy of the soak site. The scenario then adds a heading styled by
// `h2.heading.text-style-h3` and 3,000 more rules to the copy (fieldLatencyFixture.js) and waits for
// the canvas to show it. Marks come from three places, all on the epoch clock:
// - the renderer: Enter and Clear presses (capture listeners), the stylesheet write sent and
//   answered (the renderer's own `styleTransport` module, wrapped in place), `onCssChanged`, and
//   every painted frame of the Color field (a requestAnimationFrame loop plus a MutationObserver:
//   its text, the swatch fill and whether it is disabled);
// - the canvas frame: the heading's computed colour each frame, and any change to its <head>;
// - the main process: an fs.watch on the stylesheet.
// Each cycle commits `color-mix(in srgb, red N%, transparent var(--lat-mix))` through the Custom
// value box and Enter, then clears it from the label's menu. The report is the p50/p95 of every
// stage (stageLatency.js) plus the stale frames the field painted after the key press.
//
// Run: `npm run build:runtime` once, then
//   env -u ELECTRON_RUN_AS_NODE node test/integration/styleFieldLatency.js [--cycles 12] [--out <dir>]
// Outside the gate: it opens a window and measures timing.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CYCLES_DEFAULT = 12;
const CYCLES_MAX = 100;
const SHOW_WAIT_MS_MAX = 8000;
const POLL_MS = 25;
const REST_MS = 700;
const FIXTURE_WAIT_MS_MAX = 120000;
const FIELD_PROPERTY = 'color';

if (require.main === module) {
  orchestrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../helpers/e2e/soakLaunch.js');
  const reason = soakUnavailableReason();
  if (reason !== undefined) {
    console.log(`# skip: ${reason}`);
    return;
  }
  const cycles = Number(argument('--cycles', String(CYCLES_DEFAULT)));
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > CYCLES_MAX) {
    throw new Error(`--cycles takes 1..${CYCLES_MAX}`);
  }
  const outDirectory = path.resolve(argument('--out', path.join(os.tmpdir(), 'stacki-field-latency')));
  fs.mkdirSync(outDirectory, { recursive: true });
  const { code } = await runSoak({
    scenarioModule: __filename,
    options: { cycles, outDirectory, label: argument('--label', 'run'), cpuRate: Number(argument('--cpu', '1')) },
    keepDirectory: false,
  });
  process.exitCode = code;
}

// ─────────────────────────── In Electron ───────────────────────────

/** Installed in the app page: marks and the Color field's painted frames. */
function rendererProbe(property) {
  return `(async () => {
    if (window.__lat) { return 'already'; }
    const marks = [];
    const frames = [];
    const now = () => performance.timeOrigin + performance.now();
    const mark = (name, detail) => { if (marks.length < 20000) { marks.push({ name, at: now(), frame: frameIndex, detail }); } };
    const environment = await import('/src/ipc/editorEnvironment.ts');
    const write = environment.styleTransport.writeStyleFile;
    environment.styleTransport.writeStyleFile = (input) => {
      mark('requestSent', input.filePath);
      return write(input).then((result) => { mark('requestReplied'); return result; }, (error) => { mark('requestFailed', String(error)); throw error; });
    };
    window.avb.onCssChanged(() => mark('cssChanged'));
    window.addEventListener('keydown', (event) => { if (event.key === 'Enter') { mark('enter'); } }, true);
    window.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('button, [role="menuitem"]') : null;
      if (target && /^clear/i.test(target.textContent.trim())) { mark('clearPress'); }
    }, true);
    const field = () => {
      const input = document.querySelector('input[data-prop=${JSON.stringify(property)}]');
      if (!input) { return { text: '<none>', swatch: '', disabled: false }; }
      const box = input.closest('.embed-editor_type-field') || input.parentElement;
      const rich = box.querySelector('.embed-editor_varconnect-editor');
      const text = (rich ? rich.textContent : input.value) || ('placeholder:' + input.placeholder);
      const fill = box.querySelector('.u-color-swatch-fill');
      return { text: text.trim(), swatch: fill ? fill.style.background : '', disabled: input.disabled };
    };
    let last = '';
    let frameIndex = 0;
    const sample = (cause) => {
      const state = field();
      const key = JSON.stringify(state);
      if (key !== last) {
        last = key;
        if (frames.length < 20000) { frames.push({ at: now(), frame: frameIndex, cause, ...state }); }
      }
    };
    const loop = () => { frameIndex += 1; sample('frame'); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    new MutationObserver(() => sample('mutation')).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__lat = {
      take() { const out = { marks: marks.splice(0), frames: frames.splice(0) }; return out; },
      field,
    };
    return 'installed';
  })()`;
}

/** Installed in the canvas frame: the heading's computed colour per frame and head changes. */
function canvasProbe(elementId) {
  return `(() => {
    if (window.__latCanvas) { return 'already'; }
    const marks = [];
    const now = () => performance.timeOrigin + performance.now();
    let last = '';
    const loop = () => {
      const element = document.getElementById(${JSON.stringify(elementId)});
      const colour = element ? getComputedStyle(element).color : '';
      if (colour !== last) { last = colour; if (marks.length < 20000) { marks.push({ name: 'canvasColour', at: now(), detail: colour }); } }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    new MutationObserver(() => { if (marks.length < 20000) { marks.push({ name: 'canvasHead', at: now() }); } })
      .observe(document.head, { subtree: true, childList: true, characterData: true });
    window.__latCanvas = { take() { return marks.splice(0); } };
    return 'installed';
  })()`;
}

async function runInElectron({ window, project, options }) {
  const { createDriver, sleep } = require('../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../helpers/e2e/panelRecorder.js');
  const { TARGET, writeLatencyFixture } = require('../helpers/e2e/fieldLatencyFixture.js');
  const { stageTable, markdownTable } = require('../helpers/e2e/stageLatency.js');
  const driver = createDriver(window, project);
  await driver.waitForApp();
  const written = writeLatencyFixture(project);
  await waitFor(
    async () => (await driver.canvasEvaluate(`!!document.getElementById(${JSON.stringify(TARGET.elementId)})`)) === true,
    FIXTURE_WAIT_MS_MAX,
    'the canvas shows the latency heading',
  );
  await sleep(3000);
  await installRecorder(window.webContents);
  await driver.evaluate(rendererProbe(FIELD_PROPERTY));
  const fileMarks = [];
  // The folder, not the file: an atomic write replaces the file, and a watch on it stops at the first.
  const stylesheetName = path.basename(written.stylesheet);
  const watcher = fs.watch(path.dirname(written.stylesheet), (_event, name) => {
    if (String(name) === stylesheetName) {
      fileMarks.push({ name: 'fileWritten', at: Date.now() });
    }
  });
  try {
    await driver.pointerPress(await driver.canvasPoint(`#${TARGET.elementId}`), { label: 'select heading' });
    await driver.settle();
    await sleep(1500);
    await driver.screenshot(path.join(options.outDirectory, `${options.label}-selected.png`));
    const header = await driver.evaluate(`(document.querySelector('.embed-editor_root') || document.body).innerText.slice(0, 600)`);
    console.log(`# panel after select:\n${header}`);
    await driver.canvasEvaluate(canvasProbe(TARGET.elementId));
    if (options.cpuRate > 1) {
      await driver.setCpuThrottling(options.cpuRate);
    }
    const commits = [];
    const clears = [];
    for (let cycle = 0; cycle < options.cycles; cycle += 1) {
      const value = `color-mix(in srgb, red ${10 + cycle}%, transparent var(--lat-mix))`;
      await take(driver, fileMarks);
      const committed = await commitCustom(driver, value);
      if (!committed) {
        console.log(`# cycle ${cycle}: could not reach the Custom value box`);
        break;
      }
      await waitFor(async () => fieldShows(await driver.evaluate('window.__lat.field()'), value), SHOW_WAIT_MS_MAX, `the field shows ${value}`).catch(
        () => undefined,
      );
      await sleep(REST_MS);
      if (cycle === 0) {
        const colour = await driver.canvasEvaluate(`getComputedStyle(document.getElementById(${JSON.stringify(TARGET.elementId)})).color`);
        console.log(`# canvas colour after the first commit: ${colour}`);
        await driver.screenshot(path.join(options.outDirectory, `${options.label}-committed.png`));
      }
      commits.push(analyse(await take(driver, fileMarks), { start: 'enter', expect: (state) => fieldShows(state, value) }));
      const cleared = await clearByLabel(driver);
      if (!cleared) {
        console.log(`# cycle ${cycle}: could not reach the label's Clear`);
        break;
      }
      await waitFor(async () => !fieldShows(await driver.evaluate('window.__lat.field()'), value), SHOW_WAIT_MS_MAX, 'the field drops the value').catch(
        () => undefined,
      );
      await sleep(REST_MS);
      if (cycle === 0) {
        await driver.screenshot(path.join(options.outDirectory, `${options.label}-cleared.png`));
      }
      clears.push(
        analyse(await take(driver, fileMarks), { start: 'clearPress', expect: (state) => !fieldShows(state, value) && !state.text.startsWith('<none>') }),
      );
    }
    const stages = (start) => [
      { name: 'write sent', from: start, to: 'requestSent' },
      { name: 'file written', from: start, to: 'fileWritten' },
      { name: 'write answered', from: start, to: 'requestReplied' },
      { name: 'CSS-changed event', from: start, to: 'cssChanged' },
      { name: 'canvas colour', from: start, to: 'canvasColour' },
      { name: 'canvas stylesheet replaced', from: start, to: 'canvasHead' },
      { name: 'field shows it', from: start, to: 'fieldShown' },
      { name: 'field settled', from: start, to: 'fieldSettled' },
    ];
    const report = {
      label: options.label,
      commit: {
        table: stageTable(
          commits.map((run) => run.marks),
          stages('enter'),
        ),
        staleFrames: commits.map((run) => run.staleFrames),
        runs: commits,
      },
      clear: {
        table: stageTable(
          clears.map((run) => run.marks),
          stages('clearPress'),
        ),
        staleFrames: clears.map((run) => run.staleFrames),
        runs: clears,
      },
    };
    fs.writeFileSync(path.join(options.outDirectory, `${options.label}-report.json`), JSON.stringify(report, undefined, 2));
    console.log(`\n## ${options.label}: commit (Enter in the Custom value box)\n${markdownTable(report.commit.table)}`);
    console.log(`stale frames after Enter: ${report.commit.staleFrames.join(', ')}`);
    console.log(`\n## ${options.label}: clear (label menu Clear)\n${markdownTable(report.clear.table)}`);
    console.log(`stale frames after Clear: ${report.clear.staleFrames.join(', ')}`);
    return 0;
  } finally {
    watcher.close();
  }
}

function fieldShows(state, value) {
  if (state === undefined || state === null) {
    return false;
  }
  // The rich field shows a variable as a chip named by the variable, so compare the start.
  return state.text.replace(/\s+/g, ' ').startsWith(value.slice(0, 24));
}

async function take(driver, fileMarks) {
  const renderer = await driver.evaluate('window.__lat.take()');
  const canvas = (await driver.canvasEvaluate('window.__latCanvas ? window.__latCanvas.take() : []').catch(() => [])) ?? [];
  return { marks: [...renderer.marks, ...canvas, ...fileMarks.splice(0)], frames: renderer.frames };
}

// First time of each mark after the start mark, the first frame that shows what was asked, the
// frame after which the field no longer changes, and how many frames painted a stale state between.
function analyse({ marks, frames }, { start, expect }) {
  const startMark = marks.find((entry) => entry.name === start);
  const firstAt = {};
  if (startMark !== undefined) {
    firstAt[start] = startMark.at;
    for (const entry of marks) {
      if (entry.at >= startMark.at && firstAt[entry.name] === undefined) {
        firstAt[entry.name] = entry.at;
      }
    }
  }
  const after = startMark === undefined ? [] : frames.filter((frame) => frame.at >= startMark.at);
  const shown = after.find((frame) => expect(frame));
  if (shown !== undefined) {
    firstAt.fieldShown = shown.at;
  }
  const lastFrame = after[after.length - 1];
  if (lastFrame !== undefined && expect(lastFrame)) {
    firstAt.fieldSettled = lastFrame.at;
  }
  // Frames that began after the press and before the field showed the value: each was painted stale.
  const staleFrames = startMark === undefined ? undefined : (shown?.frame ?? after[after.length - 1]?.frame ?? startMark.frame) - startMark.frame;
  return { marks: firstAt, staleFrames, frames: after.slice(0, 40) };
}

async function waitFor(check, limitMs, what) {
  for (let waitedMs = 0; waitedMs < limitMs; waitedMs += POLL_MS) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`styleFieldLatency: timed out waiting for ${what}`);
}

// Press the Color field, open the Custom value box with `=`, replace its text and press Enter.
async function commitCustom(driver, value) {
  const finder = `(() => { const input = document.querySelector('input[data-prop=${JSON.stringify(FIELD_PROPERTY)}]'); const box = input && input.closest('.embed-editor_varconnect'); return (box && (box.querySelector('[contenteditable="true"]') || box.querySelector('[data-chip]'))) || input || undefined; })()`;
  const point = await driver.panelPoint(finder);
  if (point === undefined) {
    return false;
  }
  await driver.pointerPress(point, { label: 'press color field' });
  await driver.sleep(150);
  await driver.key('=', { label: 'open custom value' });
  await driver.sleep(300);
  const open = await driver.evaluate(`!!document.querySelector('.var-custom')`);
  if (!open) {
    return false;
  }
  await driver.menu('selectAll', 'select all');
  await driver.typeText(value);
  await driver.sleep(150);
  // Typing `var(--` opens the variable chooser, which takes the first Enter as a pick: a person closes
  // it with Escape (the topmost popover only) before pressing Enter to save.
  if (await driver.evaluate(`[...document.querySelectorAll('.embed-editor_varpicker')].some((e) => e.getClientRects().length > 0)`)) {
    await driver.key('Escape', { label: 'close variable chooser' });
    await driver.sleep(200);
  }
  await driver.evaluate('window.__lat.take(); 0');
  // Return with its character, as a keyboard sends it: a bare key code reaches no key handler.
  await driver.note({ kind: 'action', action: 'commit custom value' });
  driver.contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  driver.contents.sendInputEvent({ type: 'char', keyCode: '\r' });
  driver.contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  return true;
}

async function clearByLabel(driver) {
  const label = `(() => { const input = document.querySelector('input[data-prop=${JSON.stringify(FIELD_PROPERTY)}]'); const labels = [...document.querySelectorAll('.embed-editor_size-label, .u-field-label')].filter((e) => e.textContent.trim() === 'Color' && e.getClientRects().length > 0); if (!input) return labels[0]; const a = input.getBoundingClientRect(); return labels.sort((l, r) => Math.abs(l.getBoundingClientRect().top - a.top) - Math.abs(r.getBoundingClientRect().top - a.top))[0]; })()`;
  const point = await driver.panelPoint(label);
  if (point === undefined) {
    return false;
  }
  await driver.pointerPress(point, { label: 'press color label' });
  await driver.sleep(200);
  const item = await driver.panelPoint(
    `[...document.querySelectorAll('.embed-editor_varpicker, [role="menu"], [role="listbox"], [role="dialog"]')].filter((e) => e.getClientRects().length > 0).flatMap((p) => [...p.querySelectorAll('button, [role="menuitem"]')]).find((e) => /^clear/i.test(e.textContent.trim())) || undefined`,
    { scroll: false },
  );
  if (item === undefined) {
    return false;
  }
  await driver.pointerPress(item, { label: 'pick Clear' });
  return true;
}

module.exports = { runInElectron, analyse, fieldShows };
