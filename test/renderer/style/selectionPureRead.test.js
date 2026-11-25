// Goal: looking never writes. Selecting an element (on the canvas, in the navigator, with the
// arrow keys), hovering one, and opening or closing the Style panel's sections are reads: the
// project folder stays byte-identical, no file's mtime moves, no save file is renamed over a
// page, and the main process's document actors receive no intent at all, so nothing joins the
// history. The real app once rewrote pages/index.astro about 300 ms after a selection moved
// between two elements whose class is an expression: the Settings panel's code field heard the
// new element's value arriving as typing and sent it back as a set-attribute (src/ui/ExprInput.tsx),
// and the canvas then re-rendered twice for a change that did not exist.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) starts the real desktop app on a copy
// of the soak fixture, whose page has every class shape a site uses: `class={call()}`, class:list,
// a template literal, a ternary, a class handed to a component, beside plain, inline-styled and
// component elements. Inside Electron's main process this file records, for the whole run:
//   - every `stacki.document` telemetry line (one per intent outcome, applied or unchanged),
//   - every fs.renameSync and fs.writeFileSync that targets the project's src/ folder,
//   - every fs.watch event under src/ (per directory, so it works where recursive watching does not).
// It snapshots every .astro and .css file's bytes and mtime before acting, acts through
// webContents.sendInputEvent at real coordinates (soakDriver.js), and after each round waits for
// the panel to settle and then for a quiet window longer than the save debounce, bounded. Each
// recorded event is attributed to the action before it, so a failure names what wrote.
// The suite skips (and says why) where the fixture's Astro install or the built main process is
// missing. It needs a display (CI on Linux runs it under xvfb).

const fs = require('node:fs');
const path = require('node:path');

// Every element shape whose selection the test walks, by the soak page's ids. Consecutive
// expression elements come first: a field kept mounted between two of them was the trigger.
const TARGETS = Object.freeze([
  ['call one', '#soak-expr-one'],
  ['call two', '#soak-expr-two'],
  ['class:list', '#soak-list'],
  ['template literal', '#soak-template'],
  ['ternary', '#soak-ternary'],
  ['component class', '#soak-classed'],
  ['plain', '#soak-plain'],
  ['inline style', '#soak-inline'],
  ['heading component', '#soak-heading-one'],
  ['nested span', '#soak-nested-span'],
  ['scoped component', '#soak-card-title'],
]);
// Longer than the editor's save debounce, so a write an action queued has gone out by the end.
const QUIET_MS = 1500;
const WATCH_DIRECTORIES_MAX = 200;
const SECTION_TOGGLES_MAX = 24;

// --- Node side: start the app and read its verdict -----------------------------------------

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../../helpers/e2e/soakLaunch.js');
  const unavailable = soakUnavailableReason();
  if (unavailable !== undefined) {
    console.log(`# skip selectionPureRead: ${unavailable}`);
    return;
  }
  const { repoPath } = require('../../helpers/sources.js');
  const outDirectory = repoPath('node_modules/.stacki-test/selection-pure-read');
  fs.rmSync(outDirectory, { recursive: true, force: true });
  fs.mkdirSync(outDirectory, { recursive: true });
  const { code, directory, leftovers } = await runSoak({ scenarioModule: __filename, options: { outDirectory }, keepDirectory: false });
  if (leftovers.length > 0) {
    console.error(`not ok - processes outlived the run: ${leftovers.join(', ')}`);
    process.exitCode = 1;
  }
  if (fs.existsSync(directory)) {
    console.error(`not ok - the run directory ${directory} was not removed`);
    process.exitCode = 1;
  }
  const reportFile = path.join(outDirectory, 'report.json');
  if (code !== 0 || !fs.existsSync(reportFile)) {
    console.error(`not ok - the run did not finish (exit ${code})`);
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  for (const skipped of report.skipped) {
    console.log(`# skipped: ${skipped}`);
  }
  console.log(`# ${report.actions} actions, ${report.files} files watched`);
  if (report.actions === 0) {
    console.error('not ok - no action ran');
    process.exitCode = 1;
  }
  for (const violation of report.violations) {
    console.error(`not ok - ${violation}`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    console.log('ok - selecting, hovering and opening sections wrote nothing');
  }
}

// --- Electron side: act, and record every write ---------------------------------------------

// Records every write-shaped event under `source`, each tagged with the action before it.
function installRecorder(source) {
  const events = [];
  let action = 'start';
  const inSource = (target) => typeof target === 'string' && path.resolve(target).startsWith(source + path.sep);
  const restores = [];
  const originalInfo = console.info;
  console.info = (...argumentsList) => {
    const line = argumentsList.map(String).join(' ');
    if (line.includes('"stacki.document"')) {
      events.push({ action, what: `document intent: ${line}` });
    }
    originalInfo.apply(console, argumentsList);
  };
  restores.push(() => {
    console.info = originalInfo;
  });
  for (const name of ['renameSync', 'writeFileSync']) {
    const original = fs[name];
    fs[name] = function recorded(...argumentsList) {
      const target = name === 'renameSync' ? argumentsList[1] : argumentsList[0];
      if (inSource(target)) {
        events.push({ action, what: `${name} ${path.relative(source, target)}` });
      }
      return original.apply(this, argumentsList);
    };
    restores.push(() => {
      fs[name] = original;
    });
  }
  const pending = [source];
  for (let watched = 0; pending.length > 0 && watched < WATCH_DIRECTORIES_MAX; watched += 1) {
    const directory = pending.pop();
    const watcher = fs.watch(directory, (kind, name) => {
      if (/\.(astro|css|ts|js|md|mdx|json)$/.test(String(name))) {
        events.push({ action, what: `watch ${kind} ${path.relative(source, path.join(directory, String(name)))}` });
      }
    });
    restores.push(() => watcher.close());
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push(path.join(directory, entry.name));
      }
    }
  }
  return {
    events,
    setAction: (label) => {
      action = label;
    },
    dispose: () => {
      for (const restore of restores.reverse()) {
        restore();
      }
    },
  };
}

// Every source file's bytes and mtime, by project-relative path.
function sourceState(source) {
  const files = new Map();
  const pending = [source];
  for (let visited = 0; pending.length > 0 && visited < WATCH_DIRECTORIES_MAX; visited += 1) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (/\.(astro|css)$/.test(entry.name)) {
        files.set(path.relative(source, full), { bytes: fs.readFileSync(full), mtimeMs: fs.statSync(full).mtimeMs });
      }
    }
  }
  return files;
}

function stateChanges(before, after) {
  const changes = [];
  for (const [file, was] of before) {
    const now = after.get(file);
    if (now === undefined) {
      changes.push(`${file} disappeared`);
    } else if (!now.bytes.equals(was.bytes)) {
      changes.push(`${file} changed its bytes`);
    } else if (now.mtimeMs !== was.mtimeMs) {
      changes.push(`${file} was rewritten with identical bytes (mtime moved)`);
    }
  }
  for (const file of after.keys()) {
    if (!before.has(file)) {
      changes.push(`${file} appeared`);
    }
  }
  return changes;
}

// A visible control by its accessible name, or by its text where it has none.
const control = (name) =>
  `[...document.querySelectorAll('button, [role="tab"]')].find((e) => e.getClientRects().length > 0 && ((e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(name)}) || (e.textContent || '').trim() === ${JSON.stringify(name)})) || undefined`;
// The visible options of whatever menu or list is open, the first not named `except`.
const option = (except) =>
  `[...document.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"]')].find((e) => e.getClientRects().length > 0 && (e.textContent || '').trim() !== ${JSON.stringify(except)}) || undefined`;
// A panel tab: named by its text alone (the rail's Settings button is named "Settings (⌥Z)").
const tab = (name) =>
  `[...document.querySelectorAll('button')].find((e) => e.getClientRects().length > 0 && !e.hasAttribute('aria-label') && (e.textContent || '').trim() === ${JSON.stringify(name)}) || undefined`;
const optionNamed = (name) =>
  `[...document.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"]')].find((e) => e.getClientRects().length > 0 && (e.textContent || '').trim().startsWith(${JSON.stringify(name)})) || undefined`;

// The other reads a person makes all day, held to the same rule: the Settings tab showing the
// expression fields themselves, the canvas breakpoints, the Style context, the Code view, the
// Pages and Variables panels, and switching to another page and back.
async function auditNeighbours({ driver, act, quiet, report }) {
  const press = async (label, finder) => {
    const point = await driver.panelPoint(finder, { scroll: false });
    if (point === undefined) {
      report.skipped.push(`${label}: control not found`);
      return false;
    }
    await act(label, () => driver.pointerPress(point, { label }));
    return true;
  };
  if (await press('open the Settings tab', tab('Settings'))) {
    let fieldsShown = 0;
    for (const [name, selector] of TARGETS.slice(0, 7)) {
      await act(`settings: canvas select ${name}`, async () => driver.pointerPress(await driver.canvasPoint(selector)));
      fieldsShown += await driver.evaluate(`[...document.querySelectorAll('.expr-input')].filter((e) => e.getClientRects().length > 0).length`);
    }
    if (fieldsShown === 0) {
      report.skipped.push('the Settings tab showed no code field: no class expression was on screen');
    }
    await quiet('settings tab selection');
    await press('back to the Style tab', tab('Style'));
  }
  const initial = await driver.evaluate(
    `(() => { const on = [...document.querySelectorAll('button.on')].find((e) => /— \\d$/.test(e.getAttribute('aria-label') || '')); return on ? on.getAttribute('aria-label') : ''; })()`,
  );
  for (const breakpoint of ['Desktop', 'Tablet', 'Phone', 'Canvas — all breakpoints']) {
    await press(`canvas breakpoint ${breakpoint}`, control(breakpoint));
    await driver.sleep(300);
  }
  if (initial.length > 0) {
    await press(`canvas breakpoint back to ${initial}`, control(initial));
  }
  await quiet('canvas breakpoints');
  if (await press('open the Style context menu', control('Style context'))) {
    await press('pick another Style context', option('Base'));
    if (await press('open the Style context menu again', control('Style context'))) {
      await press('pick Base', optionNamed('Base'));
    }
  }
  await quiet('style context');
  for (const rail of ['Code', 'Pages', 'Variables', 'Style selectors', 'Components', 'Assets']) {
    await press(`open the ${rail} panel`, control(rail));
    await driver.sleep(500);
    await quiet(`${rail} panel`);
  }
  await press('back to the Navigator', control('Navigator'));
  if (await press('open the page switcher', control('Current page'))) {
    if (await press('switch to another page', `document.querySelector('.page-menu-item:not(.current)') || undefined`)) {
      await driver.sleep(2000);
      await driver.waitForApp();
      const page = await driver.evaluate(`(document.querySelector('.page-switch-label') || {}).textContent || ''`);
      if (page === 'Home') {
        report.skipped.push('the page switcher left the page on Home');
      }
      if (await press('open the page switcher again', control('Current page'))) {
        await press('switch back to Home', optionNamed('Home'));
        await driver.sleep(2000);
        await driver.waitForApp();
      }
    }
  }
  await quiet('page switch');
}

async function runInElectron({ window, project, options }) {
  const { createDriver } = require('../../helpers/e2e/soakDriver.js');
  const { installRecorder: installPanelRecorder } = require('../../helpers/e2e/panelRecorder.js');
  const driver = createDriver(window, project);
  const source = path.join(project, 'src');
  const report = { actions: 0, files: 0, skipped: [], violations: [] };
  // Recorded from before the project opens: starting the app with a project is a read too.
  const before = sourceState(source);
  report.files = before.size;
  const recorder = installRecorder(source);
  recorder.setAction('app start with the project');
  await driver.waitForApp();
  await driver.setPageFocus('focused');
  // The panel's frame recorder: `settle` waits on the frames it records.
  await installPanelRecorder(driver.contents);
  await driver.sleep(500);
  await driver.settle();
  await driver.sleep(QUIET_MS);
  const act = async (label, run) => {
    recorder.setAction(label);
    report.actions += 1;
    await run();
    await driver.settle();
  };
  const quiet = async (label) => {
    recorder.setAction(`${label} (after)`);
    await driver.sleep(QUIET_MS);
    await driver.settle();
  };
  const navigatorRow = (index) => `[...document.querySelectorAll('.structure-node:not(.is-pseudo)')][${index}] || undefined`;
  const selectedRow = () =>
    driver.evaluate(`[...document.querySelectorAll('.structure-node:not(.is-pseudo)')].findIndex((e) => e.classList.contains('selected'))`);
  try {
    // Canvas presses, learning each element's navigator row on the way.
    const rows = new Map();
    for (const [name, selector] of TARGETS) {
      await act(`canvas select ${name}`, async () => driver.pointerPress(await driver.canvasPoint(selector), { label: `canvas select ${name}` }));
      const row = await selectedRow();
      if (row >= 0) {
        rows.set(name, row);
      } else {
        report.skipped.push(`no navigator row for ${name}`);
      }
    }
    await quiet('canvas selection');
    // Navigator presses.
    for (const [name] of TARGETS) {
      const row = rows.get(name);
      if (row !== undefined) {
        const point = await driver.panelPoint(navigatorRow(row), { scroll: false });
        if (point === undefined) {
          report.skipped.push(`navigator row for ${name} not on screen`);
        } else {
          await act(`navigator select ${name}`, () => driver.pointerPress(point, { label: `navigator select ${name}` }));
        }
      }
    }
    await quiet('navigator selection');
    // Arrow keys through the navigator, from the first target's row down and back up.
    const first = rows.get(TARGETS[0][0]);
    if (first === undefined) {
      report.skipped.push('keyboard selection: the expression rows are not in the navigator');
    } else {
      const point = await driver.panelPoint(navigatorRow(first), { scroll: false });
      if (point !== undefined) {
        await act('navigator select call one (for keys)', () => driver.pointerPress(point));
        for (let step = 0; step < TARGETS.length; step += 1) {
          await act(`key Down ${step + 1}`, () => driver.key('Down'));
        }
        for (let step = 0; step < TARGETS.length; step += 1) {
          await act(`key Up ${step + 1}`, () => driver.key('Up'));
        }
      }
    }
    await quiet('keyboard selection');
    // Hovering the canvas elements and the navigator rows.
    for (const [name, selector] of TARGETS) {
      await act(`hover canvas ${name}`, async () => driver.hover(await driver.canvasPoint(selector)));
      const row = rows.get(name);
      const point = row === undefined ? undefined : await driver.panelPoint(navigatorRow(row), { scroll: false });
      if (point !== undefined) {
        await act(`hover navigator ${name}`, () => driver.hover(point));
      }
    }
    await quiet('hover');
    // Each Style panel section closed and opened again, on an expression element.
    await act('canvas select call two (for sections)', async () => driver.pointerPress(await driver.canvasPoint('#soak-expr-two')));
    const toggles = await driver.evaluate(`document.querySelectorAll('button.embed-editor_section-toggle').length`);
    if (toggles === 0) {
      report.skipped.push('the Style panel shows no section toggles');
    }
    for (let index = 0; index < Math.min(toggles, SECTION_TOGGLES_MAX); index += 1) {
      for (const turn of ['close', 'open']) {
        const point = await driver.panelPoint(`document.querySelectorAll('button.embed-editor_section-toggle')[${index}] || undefined`);
        if (point !== undefined) {
          await act(`section ${index + 1} ${turn}`, () => driver.pointerPress(point));
        }
      }
    }
    await quiet('sections');
    await auditNeighbours({ driver, act, quiet, report });
  } finally {
    recorder.dispose();
  }
  for (const event of recorder.events) {
    report.violations.push(`${event.action}: ${event.what}`);
  }
  for (const change of stateChanges(before, sourceState(source))) {
    report.violations.push(`after the run: ${change}`);
  }
  fs.writeFileSync(path.join(options.outDirectory, 'report.json'), JSON.stringify(report, undefined, 1));
  return 0;
}

module.exports = { runInElectron };

if (process.versions.electron === undefined) {
  orchestrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
