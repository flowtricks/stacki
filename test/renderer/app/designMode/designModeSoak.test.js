// Goal: in the real app, Design mode is the normal editor working on a sandbox copy, and the project folder is
// byte-identical however it is used. Entered from the AI panel's Modes menu, the window reopens on a copy in the
// app's data folder; the real Style panel starts the selection on Inline styles and its edit lands in the copy;
// a duplicated frame keeps its own version, and switching frames shows each one's own style on the canvas; Compare
// shows the frames side by side; the fence refuses a git request and a write into the project from inside the
// running app; Send to AI reopens the project with the frames waiting in the AI panel (never sent); the copy and
// its .env are gone afterwards; coming back restores the frames from the draft, and Exit leaves again.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) runs the real desktop app hidden, with a temporary user
// data folder and the mock keychain, on a copy of the Lumos fixture site with the style soak page. Pointer and key
// input are real input events at window coordinates (soakDriver.js). No step sleeps: each waits on the state it
// expects (test/helpers/waitFor.js). The fence and the session are read from main's own modules in the same
// process. Screenshots (written to the temporary folder during the run, the only place outside the copy the fence
// lets the app write) go to STACKI_SCREENSHOT_DIR (default node_modules/.stacki-test/design-mode). The suite skips
// where the fixture's Astro install or the built main process is missing. Run it by hand with
// `node test/renderer/app/designMode/designModeSoak.test.js`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** A step's wait for the state it expects: short, so a failure shows within a couple of minutes. */
const WAIT_MS_MAX = 30_000;
/** Opening a copy also starts its dev server, which takes longer than any other step. */
const OPEN_WAIT_MS_MAX = 90_000;
/** How long a person takes between selecting and typing: the panel settles its target meanwhile. */
const THINK_MS = 1_500;
const POLL_MS = 100;
/** One press's wait to be the selection, before it is pressed again. */
const SELECT_WAIT_MS_MAX = 10_000;
/** Characters a field's old value may have. */
const FIELD_CHARS_MAX = 12;
const TREE_FILES_MAX = 50_000;
const CHECKS_MIN = 20;

// --- Node side: start the app and read its verdict -----------------------------------------

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../../../helpers/e2e/soakLaunch.js');
  const unavailable = soakUnavailableReason();
  if (unavailable !== undefined) {
    console.log(`# skip designModeSoak: ${unavailable}`);
    return;
  }
  const { repoPath } = require('../../../helpers/sources.js');
  const outDirectory = process.env.STACKI_SCREENSHOT_DIR ?? repoPath('node_modules/.stacki-test/design-mode');
  fs.mkdirSync(outDirectory, { recursive: true });
  fs.rmSync(path.join(outDirectory, 'report.json'), { force: true });
  // While Design mode is on, the app may write only to its copy, its own data and the temporary folder: the run
  // writes its pictures and report to the temporary folder, and they are moved to `outDirectory` afterwards.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-design-soak-'));
  const { code, directory, leftovers } = await runSoak({ scenarioModule: __filename, options: { outDirectory: staging }, keepDirectory: false });
  for (const name of fs.readdirSync(staging)) {
    fs.copyFileSync(path.join(staging, name), path.join(outDirectory, name));
  }
  fs.rmSync(staging, { recursive: true, force: true });
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
  for (const failure of report.failures) {
    console.error(`not ok - ${failure}`);
    process.exitCode = 1;
  }
  if (report.checked < CHECKS_MIN) {
    console.error(`not ok - only ${report.checked} checks ran`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    console.log(`ok - ${report.checked} checks: Design mode edited its copy with the real panels and left the project byte-identical`);
  }
}

// --- Electron side: act, and compare the project's bytes -----------------------------------

/** Every file of the project but node_modules and Astro's own .astro cache, as one digest. */
function treeDigest(root) {
  const hash = crypto.createHash('sha256');
  const pending = [root];
  let files = 0;
  while (pending.length > 0 && files < TREE_FILES_MAX) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules' || entry.name === '.astro') {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        hash.update(path.relative(root, full));
        hash.update(fs.readFileSync(full));
        files += 1;
      }
    }
  }
  return `${files} files ${hash.digest('hex')}`;
}

const MENU_ROWS = `[...document.querySelectorAll('[role^="menuitem"]')].filter((e) => e.getClientRects().length > 0)`;
const modeRow = (name) => `${MENU_ROWS}.findLast((r) => ${name}.test(r.textContent || ''))`;
const PLAIN_INDENT = `getComputedStyle(document.querySelector('#soak-plain')).textIndent`;
const TABS = `[...document.querySelectorAll('.dm-tab-name')]`;

async function runInElectron({ window, project, options }) {
  const { app } = require('electron');
  const { createDriver } = require('../../../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../../../helpers/e2e/panelRecorder.js');
  const { waitFor } = require('../../../helpers/waitFor.js');
  const { designFenceState, checkDesignFence } = require('#dist/electron/lib/designMode/designFence.js');
  const driver = createDriver(window, project);
  const report = { checked: 0, failures: [] };
  const check = (what, condition, detail) => {
    report.checked += 1;
    if (!condition) {
      report.failures.push(`${what}${detail === undefined ? '' : ` (${String(detail)})`}`);
    }
  };
  const shot = (name) => driver.screenshot(path.join(options.outDirectory, `${name}.png`));
  const until = (what, expression, test = Boolean, waitMsMax = WAIT_MS_MAX) =>
    waitFor({
      what,
      read: () => driver.evaluate(expression).catch(() => undefined),
      until: test,
      pollIntervalMs: POLL_MS,
      pollCountMax: waitMsMax / POLL_MS,
    });
  /** A wait across a reload into another project, which starts its dev server. */
  const untilOpen = (what, expression) => until(what, expression, Boolean, OPEN_WAIT_MS_MAX);
  const untilCanvas = (what, expression, test = Boolean) =>
    waitFor({
      what,
      read: () => driver.canvasEvaluate(expression).catch(() => undefined),
      until: test,
      pollIntervalMs: POLL_MS,
      pollCountMax: WAIT_MS_MAX / POLL_MS,
    });
  const run = async (what, act) => {
    try {
      await act();
      await collectToasts();
    } catch (error) {
      report.failures.push(`${what}: ${String(error && error.message ? error.message : error)}`);
      await shot('failed-' + what.replace(/\W+/g, '-')).catch(() => undefined);
    }
  };
  const openAiPanel = () =>
    driver.evaluate(
      `document.querySelector('.ai-modes-button') ? 0 : ([...document.querySelectorAll('.rail button')].find((b) => /AI/.test(b.getAttribute('aria-label') || ''))?.click(), 0)`,
    );
  /** Opens the AI panel header's Modes menu and picks the row matching `name`. */
  const pickMode = async (name) => {
    await openAiPanel();
    await until('the Modes button', `!!document.querySelector('.ai-modes-button')`);
    await driver.settle();
    await driver.evaluate(`document.querySelector('.ai-modes-button').click()`);
    await until(`the ${name.source} row`, `!!${modeRow(name)}`);
    await driver.evaluate(`${modeRow(name)}.click()`);
  };
  /** Selects `selector` on the canvas with a real click, and waits for the Style panel to show it. */
  const selectOnCanvas = async (selector) => {
    const name = selector.replace(/^#/, '');
    // The panel names the selection's id once it is the target; a press that lands while the canvas is still
    // swapping pages is pressed again, within a bound.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await driver.pointerPress(await driver.canvasPoint(selector));
      const named = await waitFor({
        what: `${selector} selected`,
        read: () => driver.evaluate(`(document.querySelector('.embed-editor_root')?.textContent || '').includes(${JSON.stringify(name)})`).catch(() => false),
        until: Boolean,
        pollIntervalMs: POLL_MS,
        pollCountMax: SELECT_WAIT_MS_MAX / POLL_MS,
      }).then(
        () => true,
        () => false,
      );
      if (named) {
        await driver.settle();
        return;
      }
    }
    throw new Error(`${selector} could not be selected`);
  };
  /** Types `value` into the Style panel's text indent field (a plain length field) and waits for the canvas to show it. */
  const setIndent = async (value) => {
    const field = await driver.panelPoint(
      `(() => { const field = document.querySelector('[data-prop="text-indent"]'); const box = field && field.closest('.embed-editor_varconnect'); return (box && box.querySelector('[contenteditable="true"]')) || field || undefined; })()`,
    );
    if (field === undefined) {
      throw new Error('the text indent field is not in the Style panel');
    }
    await driver.pointerPress(field);
    // The field holds the last value: it is emptied first, a key at a time (the field may be a token editor, where
    // select-all does not take the whole value).
    await driver.key('End');
    for (let removed = 0; removed < FIELD_CHARS_MAX; removed += 1) {
      await driver.key('Backspace');
    }
    await driver.typeText(value);
    await driver.key('Enter');
    await untilCanvas(`the canvas at ${value}`, PLAIN_INDENT, (size) => size === value);
  };
  // Every toast's text, kept in main as the page shows it: the window reloads, the record must not.
  const toasts = [];
  const watchToasts = () =>
    driver.evaluate(`(() => {
      window.__dmToasts = [];
      new MutationObserver(() => {
        for (const toast of document.querySelectorAll('.toast-stack [role="status"], .toast-stack [role="alert"], .toast-list > *')) {
          const text = (toast.textContent || '').trim();
          if (text && !window.__dmToasts.includes(text)) window.__dmToasts.push(text);
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
      return 0;
    })()`);
  const collectToasts = async () => {
    const seen = (await driver.evaluate(`window.__dmToasts || []`).catch(() => [])) ?? [];
    for (const text of seen) {
      if (!toasts.includes(text)) {
        toasts.push(text);
      }
    }
  };
  /** The window reloaded (a project switch): wait for the app again, and put back what the reload dropped. */
  const reopened = async () => {
    await driver.waitForApp();
    await driver.setPageFocus('focused');
    await installRecorder(driver.contents);
    await watchToasts();
    await driver.settle();
  };
  const sandboxes = path.join(app.getPath('userData'), 'design-sandboxes');
  const leftInSandboxes = () => (fs.existsSync(sandboxes) ? fs.readdirSync(sandboxes) : []);

  await driver.waitForApp();
  await driver.setPageFocus('focused');
  await installRecorder(driver.contents);
  await watchToasts();
  await driver.settle();
  const before = treeDigest(project);
  const realProject = fs.realpathSync(project);
  const plainBefore = fs.readFileSync(path.join(project, 'src/pages/index.astro'), 'utf8');

  await run('enter from the Modes menu: the window reopens on a private copy', async () => {
    await pickMode(/design mode/i);
    await collectToasts();
    await untilOpen('the Design mode bar', `!!document.querySelector('.dm-bar')`);
    await reopened();
    const fence = designFenceState();
    check('the fence is up', fence.kind === 'on');
    check(
      'the copy is in the app data folder',
      fence.kind === 'on' && fence.sandboxRoot.startsWith(fs.realpathSync(app.getPath('userData'))),
      fence.sandboxRoot,
    );
    check('the fence guards the project itself', fence.kind === 'on' && fence.realRoot === realProject);
    check('the copy is private to the person', (fs.statSync(sandboxes).mode & 0o777) === 0o700);
    check('the copy holds the project .env, which the dev server needs', leftInSandboxes().length === 1);
    check(
      'history and git are out of reach',
      await driver.evaluate(`![...document.querySelectorAll('.rail button')].some((b) => /history/i.test(b.getAttribute('aria-label') || ''))`),
    );
    check('one frame, the original', (await driver.evaluate(`${TABS}.length`)) === 1);
    await shot('01-entered');
  });

  await run('the real Style panel starts on Inline styles and edits the copy', async () => {
    await selectOnCanvas('#soak-plain');
    await until('the Inline styles chip picked', `!!document.querySelector('.embed-editor_selector-chip.is-inline.is-active')`);
    check('a new selection starts on Inline styles', true);
    // A person looks before typing; the panel finishes picking its target meanwhile, and it must stay inline.
    await driver.sleep(THINK_MS);
    check(
      'Inline styles is still the target a moment later',
      await driver.evaluate(`!!document.querySelector('.embed-editor_selector-chip.is-inline.is-active')`),
    );
    await setIndent('40px');
    const fence = designFenceState();
    const live = fence.kind === 'on' ? path.join(fence.sandboxRoot, 'site', path.basename(project)) : '';
    // The canvas shows an edit before the save lands (instant edits); the file is read until it holds it.
    // Written in rem where the project writes lengths in rem (40px is 2.5rem).
    const inline = /id="soak-plain"[^>]*style="[^"]*text-indent: ?(40px|2\.5rem)/;
    const saved = await waitFor({
      what: 'the inline style saved in the copy',
      read: () => fs.readFileSync(path.join(live, 'src/pages/index.astro'), 'utf8'),
      until: (text) => inline.test(text),
      pollIntervalMs: POLL_MS,
      pollCountMax: SELECT_WAIT_MS_MAX / POLL_MS,
    }).then(
      () => true,
      () => false,
    );
    const line = fs
      .readFileSync(path.join(live, 'src/pages/index.astro'), 'utf8')
      .split('\n')
      .find((text) => text.includes('soak-plain'));
    check('the edit is an inline style in the copy', saved, line);
    check('the project page is unchanged', fs.readFileSync(path.join(project, 'src/pages/index.astro'), 'utf8') === plainBefore);
    await shot('02-inline-style');
  });

  await run('the Navigator works on the copy', async () => {
    // Opened only when it is not already: the rail button toggles the panel.
    await driver.evaluate(
      `document.querySelector('.structure-node') ? 0 : ([...document.querySelectorAll('.rail button')].find((b) => /navigator/i.test(b.getAttribute('aria-label') || ''))?.click(), 0)`,
    );
    await until('the navigator tree', `document.querySelectorAll('.structure-node').length > 2`);
    check('the navigator lists the copy page', true);
    await shot('03-navigator');
  });

  await run('a duplicated frame keeps its own version', async () => {
    await driver.evaluate(`document.querySelector('.dm-bar .dm-icon[aria-label="Duplicate frame"]').click()`);
    await until('two frames', `${TABS}.length === 2`);
    await selectOnCanvas('#soak-plain');
    await setIndent('60px');
    await driver.evaluate(`${TABS}[0].click()`);
    await untilCanvas('the first frame shown again', PLAIN_INDENT, (size) => size === '40px');
    check('switching to the first frame shows its own style', true);
    await driver.evaluate(`${TABS}[1].click()`);
    await untilCanvas('the second frame shown again', PLAIN_INDENT, (size) => size === '60px');
    check('switching back shows the second frame’s style', true);
    await shot('04-two-frames');
  });

  await run('Compare shows the frames side by side', async () => {
    await driver.evaluate(`[...document.querySelectorAll('.dm-bar .dm-button')].find((b) => /compare/i.test(b.textContent || '')).click()`);
    await until(
      'the board with both frames',
      `document.querySelectorAll('.dm-board-frame').length === 2 && document.querySelectorAll('.dm-board-picture').length === 2`,
    );
    check('both frames have a picture', true);
    await shot('05-compare');
    await driver.evaluate(`document.querySelectorAll('.dm-board-frame')[0].click()`);
    await until('the board closed', `!document.querySelector('.dm-board')`);
    await untilCanvas('the first frame shown from the board', PLAIN_INDENT, (size) => size === '40px');
    check('a board tile opens its frame', true);
  });

  await run('the fence refuses git and any write into the project, from inside the running app', async () => {
    let refused = 'no';
    try {
      checkDesignFence('git:commit', { projectPath: project });
    } catch {
      refused = 'yes';
    }
    check('a git request is refused', refused === 'yes');
    let blocked = 'no';
    try {
      fs.writeFileSync(path.join(project, 'src/pages/written-in-design-mode.astro'), 'x');
    } catch (error) {
      blocked = error && error.code === 'EACCES' ? 'yes' : 'other';
    }
    check('a write into the project fails before it runs', blocked === 'yes');
    check('nothing appeared in the project', !fs.existsSync(path.join(project, 'src/pages/written-in-design-mode.astro')));
  });

  await run('Send to AI reopens the project with the frames waiting in the AI panel', async () => {
    await driver.evaluate(`document.querySelector('.dm-bar .dm-button.is-primary').click()`);
    await collectToasts();
    await untilOpen('the project open again', `!document.querySelector('.dm-bar') && !!document.querySelector('.embed-editor_root')`);
    await reopened();
    await until('the frames in the AI panel draft', `(document.querySelector('.ai-composer')?.textContent || '').includes('Design mode')`);
    check('the draft carries the request', true);
    check('the fence is down', designFenceState().kind === 'off');
    check('the copy and its .env are deleted', leftInSandboxes().length === 0);
    check('the project is byte-identical', treeDigest(project) === before);
    await shot('06-sent');
  });

  await run('coming back restores the frames; Exit leaves again', async () => {
    await pickMode(/design mode/i);
    await collectToasts();
    await untilOpen('the Design mode bar again', `!!document.querySelector('.dm-bar') && ${TABS}.length === 2`);
    await reopened();
    check('both frames came back from the draft', true);
    await untilCanvas('the shown frame’s style restored', PLAIN_INDENT, (size) => size === '40px');
    await shot('07-restored');
    await driver.evaluate(`[...document.querySelectorAll('.dm-bar .dm-button')].find((b) => /^exit$/i.test((b.textContent || '').trim())).click()`);
    await collectToasts();
    await untilOpen('out of Design mode', `!document.querySelector('.dm-bar') && !!document.querySelector('.embed-editor_root')`);
    await reopened();
    check('the fence is down after Exit', designFenceState().kind === 'off');
    check('the copy is deleted after Exit', leftInSandboxes().length === 0);
    const drafts = path.join(app.getPath('userData'), 'design-drafts');
    const draftText = fs
      .readdirSync(drafts)
      .map((folder) => path.join(drafts, folder, 'draft.json'))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('');
    check('a draft is kept in the app data folder', draftText.length > 0);
    check('the draft keeps no .env', !draftText.includes('"rel":".env'));
    await shot('08-exited');
  });

  await collectToasts();
  const refusals = toasts.filter((text) => /not available in design mode/i.test(text));
  check('no refused request reached the person as a toast', refusals.length === 0, refusals.join(' | '));
  report.toasts = toasts;
  const after = treeDigest(project);
  check('the project folder is byte-identical after everything', after === before, `${before} → ${after}`);
  fs.writeFileSync(path.join(options.outDirectory, 'report.json'), JSON.stringify(report, null, 2));
  return 0;
}

module.exports = { runInElectron };

if (process.versions.electron === undefined) {
  orchestrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
