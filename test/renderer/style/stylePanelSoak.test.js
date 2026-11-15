// Goal: the Style panel is premium, smooth and flawless in the REAL app: no popover closes by
// itself, no control paints a state it then takes back, nothing shifts or jumps, no click-out
// leaves a caret or writes a value, and clear/undo/redo leave the field, label, canvas and
// file in agreement. jsdom with a fake canvas bridge passed while people kept finding these in
// the app, so this suite runs the app itself.
//
// Method: test/helpers/e2e/soakLaunch.js starts the real desktop app (main from dist/electron,
// renderer from a private Vite dev server over the working tree, real Astro dev server, real
// canvas iframe) on a copy of the Lumos example site with the soak page on top
// (test/fixtures/style-soak). soakDriver.js acts through webContents.sendInputEvent at real
// coordinates; panelRecorder.js records every painted frame of the panel and every popover's
// life; soakScenarios.js runs the scenario library; soakInvariants.js says what is a
// violation. Nothing is faked: no bridge, no clock, no timers.
//
// Runs:
//   STACKI_SOAK=1 env -u ELECTRON_RUN_AS_NODE npm test -- stylePanelSoak   the short run (2-3 min, half of it Astro starting)
//   STACKI_SOAK=long node test/renderer/style/stylePanelSoak.test.js the full matrix at 1x, 4x, 6x CPU
//   STACKI_SOAK_SEED=1234   the random walk's seed (printed on every run; a rerun reproduces it)
//   STACKI_SOAK_THROTTLES=1,4,6  CPU slowdowns (Chromium's Emulation.setCPUThrottlingRate)
//   STACKI_SOAK_WALK=300    random-walk steps
//   STACKI_SOAK_OUT=<dir>   where report.json and violation screenshots go
//   STACKI_SOAK_ONLY=switch,popover  run only the named scenarios
//   STACKI_SOAK_RENDERER_REV=<commit>  serve the renderer as it was at a commit (git archive),
//                           to prove the soak catches a defect that commit still had
// Opt-in everywhere: it opens a visible window and judges timing, so it runs only when
// STACKI_SOAK is set (1 for the short run, long for the full matrix, ci on a runner) and
// otherwise skips with how to run it. A red soak is a finding to triage, not a gate: neither
// the pre-push gate nor Check runs it by default (a nightly job will).
// The suite skips (and says why) where the fixture's Astro install or the built main process is
// missing. A window opens for the run; it needs a display (CI on Linux runs under xvfb). The long
// run takes about an hour per CPU rate; the evidence films (STACKI_SOAK_ONLY=film) write the
// panel's real painted frames as PNGs next to the report.
//
// Known failures: KNOWN_FAILURES lists the catalogued defects the current tree still has, by
// catalog id, each with the invariant and a pattern on the violation's summary. A violation
// that matches is reported as expected; one that matches nothing fails the run. Timing-born
// defects do not reproduce on every run, so an entry that did not show is reported, not failed.
// Latency budgets (one frame for a pure UI toggle, 100 ms for a canvas-dependent update) are
// warnings, never failures: a busy machine must not turn the suite red.

const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

// The catalogued defects the current tree still has, from the soak's failure catalog. Each
// names the invariant it breaks and a pattern on the violation summary; the root cause and the
// file are in `cause`, so a red run says where to look. When a fix lands, its entry stops
// showing ("did not show this run"): delete it then, and the invariant guards the fix.
const KNOWN_FAILURES = Object.freeze([
  {
    id: 'SP-03',
    title: 'the panel paints a frame with no controls between two elements',
    invariant: 'blank-panel',
    pattern: /no controls between/,
    cause:
      'a switch shown past its 1.5 s hold (StylePanel useSwitchHold) with the answer still owed draws section placeholders: a slow canvas, or one that re-renders when a class-expression element is selected (two canvas-ready per selection)',
  },
  {
    id: 'SP-04',
    title: 'a chip pressed right after a switch opens its picker, which then closes itself',
    invariant: 'popover-closed-itself',
    pattern: /varpicker.*unmounted/,
    cause:
      'left only on a freshly reloaded canvas: the picker opened on the element still shown unmounts about 230 ms later with no panel commit (no switch, no section change); see VariablePicker / VariableConnect / pickerExit',
  },
  {
    id: 'SP-12',
    title: 'rows move under the pointer on a switch: the panel keeps scrollTop while the content above changes height',
    invariant: 'scroll-jump',
    pattern: /panel scroll jumped/,
    cause:
      'left at 4x and 6x only (paragraph <-> nested label): StylePanel useSwitchScrollAnchor holds the first surviving row, but rows below it whose sections change still move while scrollTop does',
  },
  {
    id: 'SP-14',
    title:
      "a component's <style is:global> rule is not offered for its element on the page: #soak-gcard shows no .soak-gcard chip, and a set reaches the canvas through another selector while SoakGlobalCard.astro is never written",
    invariant: 'state-disagrees',
    pattern: /on globalCard after/,
    cause:
      'unconfirmed: the chips for an element inside a component instance come from the classes the canvas reports (renderedClasses / instanceClasses); the class rule in the component file never becomes the pick',
  },
  {
    id: 'SP-15',
    title:
      'inline style attribute: after set, clear and undo, redo leaves the attribute declaring the value (the clear is not redone); the set can reach the canvas late',
    invariant: 'state-disagrees',
    pattern: /on inline after (set|redo)/,
    cause: 'unconfirmed: the inline path writes through setProp(style) (useInlineTarget), whose history step for a clear may coalesce with the set it undoes',
  },
]);

const SHORT_WALK_STEPS = 10;
const LONG_WALK_STEPS = 300;

function optionsFromEnvironment() {
  const mode = process.env.STACKI_SOAK === 'long' ? 'long' : 'short';
  const seedText = process.env.STACKI_SOAK_SEED ?? '';
  const seed = seedText.length > 0 ? Number.parseInt(seedText, 10) : Math.floor(Math.random() * 2 ** 31);
  const throttles = (process.env.STACKI_SOAK_THROTTLES ?? (mode === 'long' ? '1,4,6' : '1')).split(',').map((rate) => Number.parseFloat(rate));
  const walkSteps = Number.parseInt(process.env.STACKI_SOAK_WALK ?? String(mode === 'long' ? LONG_WALK_STEPS : SHORT_WALK_STEPS), 10);
  const outDirectory = process.env.STACKI_SOAK_OUT ?? repoPath('node_modules/.stacki-test/style-soak');
  const rendererRevision = process.env.STACKI_SOAK_RENDERER_REV ?? '';
  const git = (...args) =>
    require('node:child_process')
      .spawnSync('git', args, { cwd: repoPath('src'), encoding: 'utf8' })
      .stdout.trim();
  const tree = { head: git('rev-parse', 'HEAD'), dirty: git('status', '--short', '--', 'src', 'shared', 'electron').split('\n').filter(Boolean) };
  return { mode, seed, throttles, walkSteps, outDirectory, only: process.env.STACKI_SOAK_ONLY ?? '', rendererRevision, tree };
}

function classify(violation) {
  return KNOWN_FAILURES.find((known) => known.invariant === violation.invariant && known.pattern.test(violation.summary));
}

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../../helpers/e2e/soakLaunch.js');
  if ((process.env.STACKI_SOAK ?? '') === '') {
    console.log(
      '# skip stylePanelSoak: opt-in; run it with STACKI_SOAK=1 env -u ELECTRON_RUN_AS_NODE npm test -- stylePanelSoak (STACKI_SOAK=long for the full matrix)',
    );
    return;
  }
  const unavailable = soakUnavailableReason();
  if (unavailable !== undefined) {
    console.log(`# skip stylePanelSoak: ${unavailable}`);
    return;
  }
  const options = optionsFromEnvironment();
  fs.rmSync(options.outDirectory, { recursive: true, force: true });
  fs.mkdirSync(options.outDirectory, { recursive: true });
  console.log(
    `# stylePanelSoak ${options.mode} run on ${options.rendererRevision || `${options.tree.head.slice(0, 8)}${options.tree.dirty.length > 0 ? ' + uncommitted' : ''}`}, seed ${options.seed}, CPU ${options.throttles.join('x, ')}x, walk ${options.walkSteps} steps`,
  );
  const { code, directory, leftovers } = await runSoak({ scenarioModule: __filename, options, keepDirectory: false });
  // Nothing of this run may outlive it: no process naming its directory, and no directory.
  const { processesOfRun } = require('../../helpers/e2e/soakProcesses.js');
  const remaining = processesOfRun(directory);
  if (leftovers.length > 0 || remaining.length > 0) {
    console.error(`not ok - soak processes outlived the run: ${[...new Set([...leftovers, ...remaining.map((entry) => entry.pid)])].join(', ')}`);
    process.exitCode = 1;
  }
  if (fs.existsSync(directory)) {
    console.error(`not ok - the run directory ${directory} was not removed`);
    process.exitCode = 1;
  }
  const reportFile = path.join(options.outDirectory, 'report.json');
  if (code !== 0 || !fs.existsSync(reportFile)) {
    console.error(`not ok - the soak did not finish (exit ${code})`);
    process.exitCode = 1;
    return;
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const unexpected = [];
  const seen = new Set();
  for (const violation of report.violations) {
    const known = classify(violation);
    if (known === undefined) {
      unexpected.push(violation);
    } else {
      seen.add(known.id);
    }
  }
  for (const known of KNOWN_FAILURES) {
    console.log(`# ${known.id} ${seen.has(known.id) ? 'still fails (expected)' : 'did not show this run'}: ${known.title}`);
  }
  for (const harnessError of report.harnessErrors) {
    console.error(`not ok - harness error in ${harnessError.scenario} at ${harnessError.throttle}x: ${harnessError.error.split('\n')[0]}`);
    unexpected.push({
      invariant: 'harness-error',
      summary: harnessError.error.split('\n')[0],
      scenario: harnessError.scenario,
      step: 0,
      seed: options.seed,
      throttle: harnessError.throttle,
      action: '',
    });
  }
  for (const warning of report.warnings.slice(0, 20)) {
    console.log(`# warning [${warning.invariant}] ${warning.summary}`);
  }
  console.log(
    `# ${report.segments} segments, ${report.violations.length} violations (${unexpected.length} unexpected), ${report.warnings.length} warnings, report ${reportFile}`,
  );
  for (const violation of unexpected.slice(0, 40)) {
    console.error(
      `not ok - [${violation.invariant}] ${violation.summary}\n    scenario ${violation.scenario}, step ${violation.step}, seed ${violation.seed}, CPU ${violation.throttle}x, action: ${violation.action}`,
    );
  }
  if (unexpected.length > 0) {
    process.exitCode = 1;
  }
}

// The opening tag of the soak page's inline-styled paragraph, and whether its style attribute
// declares `property`.
function inlineStyleDeclares(source, property) {
  const tag = /<p id="soak-inline"[^>]*>/.exec(source);
  if (tag === null) {
    return false;
  }
  const style = /style="([^"]*)"/.exec(tag[0]);
  return style !== null && new RegExp(`(^|;)\\s*${property}\\s*:`).test(style[1]);
}

// One set -> clear -> undo -> redo cycle for each kind of place a style lives: the page's own
// <style is:global> block, a component's <style is:global> block, an external stylesheet, and
// the element's style attribute (picked through the inline chip). Each element has exactly one
// rule (or attribute) the edit can go to, so the file it must land in is known.
async function editEverySource(runner, family) {
  const textIndent = family('text-indent');
  await runner.editCycle({ element: 'plain', family: textIndent, value: '12px', file: 'src/pages/index.astro', selector: '.soak-plain' });
  await runner.editCycle({ element: 'globalCard', family: textIndent, value: '12px', file: 'src/components/SoakGlobalCard.astro', selector: '.soak-gcard' });
  await runner.editCycle({ element: 'external', family: textIndent, value: '12px', file: 'src/styles/soak.css', selector: '.soak-ext' });
  await runner.editCycle({
    element: 'inline',
    family: textIndent,
    value: '12px',
    file: 'src/pages/index.astro',
    selector: '#soak-inline[style]',
    pick: `document.querySelector('button.embed-editor_selector-chip.is-inline:not([aria-pressed="true"])') || undefined`,
    declaredIn: (source) => inlineStyleDeclares(source, 'text-indent'),
  });
}

// The Electron side: run the plan against the window and write the report.
async function runInElectron({ window, project, options }) {
  const electron = require('electron');
  const { createDriver } = require('../../helpers/e2e/soakDriver.js');
  const { createRunner, FAMILIES } = require('../../helpers/e2e/soakScenarios.js');
  const driver = createDriver(window, project);
  const family = (id) => FAMILIES.find((candidate) => candidate.id === id);
  const typeFamilies = FAMILIES.filter((candidate) => candidate.property !== undefined);
  const report = { options, segments: 0, violations: [], warnings: [], skipped: [], harnessErrors: [], recordings: [] };
  const runner = createRunner({ driver, electron, window, outDirectory: options.outDirectory, seed: options.seed });
  await runner.begin();
  await runner.learnNavigator();
  for (const throttle of options.throttles) {
    runner.setThrottle(throttle);
    await driver.setCpuThrottling(throttle);
    const want = (name) => options.only.length === 0 || options.only.split(',').includes(name);
    // A scenario that throws (a control the harness could not find, a crash in the app) is
    // reported and the run goes on: one broken scenario must not hide the others' findings.
    const guarded = async (name, body) => {
      if (!want(name)) {
        return;
      }
      try {
        await body();
      } catch (error) {
        report.harnessErrors.push({ scenario: name, throttle, error: String(error instanceof Error ? error.stack : error) });
      }
    };
    // Painted-frame films are evidence for the catalog, not checks: only when asked for.
    if (options.only.split(',').includes('film')) {
      await guarded('film', async () => {
        await runner.filmSwitches({
          pairs: [
            ['expressionOne', 'expressionTwo'],
            ['paragraph', 'headingOne'],
            ['headingTwo', 'headingOne'],
            ['paragraph', 'nestedSpan'],
          ],
        });
        await runner.filmSwitches({
          pairs: [
            ['expressionOne', 'expressionTwo'],
            ['paragraph', 'headingOne'],
            ['headingTwo', 'headingOne'],
          ],
          family: family('weight'),
          delayMs: 120,
        });
      });
    }
    if (options.mode === 'short') {
      await guarded('switch', async () => {
        await runner.switchOnly({
          pairs: [
            ['paragraph', 'nestedSpan'],
            ['headingOne', 'headingTwo'],
          ],
          methods: ['canvas'],
          repeats: 2,
        });
      });
      await guarded('switch-press', async () => {
        await runner.switchMatrix({
          pairs: [['headingTwo', 'headingOne']],
          methods: ['canvas'],
          delays: ['chip', 0],
          families: [family('weight')],
          fresh: true,
        });
      });
      await guarded('popover', async () => {
        await runner.popoverMatrix({ element: 'headingOne', families: [family('weight')], exitPaths: ['outside-press', 'escape'] });
      });
      await guarded('hover-preview', async () => {
        await runner.hoverPreview({ element: 'headingOne', families: [family('weight')], exitPaths: ['escape'] });
      });
      await guarded('edit-cycle', async () => {
        await editEverySource(runner, family);
      });
      await guarded('random-walk', async () => {
        await runner.randomWalk({ steps: options.walkSteps, families: typeFamilies });
      });
    } else {
      const pairs = [
        ['headingOne', 'headingTwo'],
        ['expressionOne', 'expressionTwo'],
        ['paragraph', 'nestedSpan'],
        ['paragraph', 'headingOne'],
        ['plain', 'headingOne'],
        ['cardTitle', 'headingTwo'],
        ['inline', 'nestedSpan'],
      ];
      await guarded('switch', async () => {
        await runner.switchOnly({ pairs, methods: ['canvas', 'navigator', 'keyboard'], repeats: 6 });
      });
      await guarded('switch-press', async () => {
        await runner.switchMatrix({
          pairs: pairs.slice(0, 3),
          methods: ['canvas', 'navigator'],
          delays: ['chip', 0, 16, 50, 120, 300, 1000, 1600],
          families: [family('weight'), family('font-family'), family('size'), family('color'), family('text-transform')],
        });
      });
      await guarded('popover', async () => {
        await runner.popoverMatrix({
          element: 'headingOne',
          families: FAMILIES,
          exitPaths: ['outside-press', 'canvas-press-same', 'canvas-press-other', 'escape', 'tab', 'window-blur', 'scroll'],
        });
        await runner.popoverMatrix({ element: 'plain', families: FAMILIES, exitPaths: ['outside-press', 'escape'] });
      });
      await guarded('rapid-toggle', async () => {
        await runner.rapidToggle({ element: 'headingOne', families: typeFamilies });
      });
      await guarded('hover-preview', async () => {
        await runner.hoverPreview({
          element: 'headingOne',
          families: [family('weight'), family('font-family'), family('size'), family('color')],
          exitPaths: ['outside-press', 'canvas-press-same', 'canvas-press-other', 'escape', 'tab', 'shift-tab', 'window-blur', 'scroll'],
        });
      });
      await guarded('picker-arrow', async () => {
        await runner.arrowPreview({ element: 'headingOne', families: [family('size'), family('font-family')] });
      });
      await guarded('edit-cycle', async () => {
        await editEverySource(runner, family);
        await runner.editCycle({
          element: 'nestedSpan',
          family: family('text-indent'),
          value: '2em',
          file: 'src/pages/index.astro',
          selector: '.soak-nest_label',
        });
        await runner.editCycle({
          element: 'nestedSpan',
          family: family('line-height'),
          value: '1.9',
          file: 'src/pages/index.astro',
          selector: '.soak-nest_label',
        });
      });
      await guarded('type-switch', async () => {
        await runner.typeThenSwitch({ element: 'plain', other: 'headingOne', family: family('size'), typed: '30px', file: 'src/pages/index.astro' });
      });
      await guarded('breakpoint', async () => {
        await runner.breakpoints({ element: 'nestedSpan', options: 2 });
      });
      await guarded('random-walk', async () => {
        await runner.randomWalk({ steps: options.walkSteps, families: typeFamilies });
      });
    }
  }
  await driver.setCpuThrottling(1);
  report.segments = runner.results.segments;
  report.violations = runner.results.violations;
  report.warnings = runner.results.warnings;
  report.skipped = runner.results.skipped;
  report.recordings = runner.results.recordings;
  report.films = runner.results.films;
  fs.writeFileSync(path.join(options.outDirectory, 'report.json'), JSON.stringify(report, undefined, 1));
  return 0;
}

module.exports = { runInElectron, KNOWN_FAILURES };

if (process.versions.electron === undefined) {
  orchestrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
