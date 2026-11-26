// Goal: in the real app, Design mode is a canvas of frames over a sandbox copy, worked with a real pointer and
// keyboard, and the project folder is byte-identical however it is used. Entered from the AI panel header's button,
// the canvas is the view. A click on an element in a frame selects it in the real Navigator, Style and Settings
// panels; a Style edit lands in the copy and in that frame only; Option-drag and the right-click menu duplicate a
// frame at once; Delete removes a selected frame; a frame is moved by its name; switching between frames shows each
// one's own version; the fence refuses git and writes; Send to AI reopens the project with a picture per frame
// waiting in the AI panel (never sent); coming back shows every frame at once from its kept document.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) runs the real desktop app hidden, with a temporary user
// data folder and the mock keychain, on a copy of the Lumos fixture site with the style soak page. Pointer and key
// input are real input events at window coordinates (soakDriver.js). No step sleeps: each waits on the state it
// expects (test/helpers/waitFor.js). Times are measured in the page, from the event that started each action.
// Screenshots go to STACKI_SCREENSHOT_DIR (default node_modules/.stacki-test/design-mode). The suite skips where the
// fixture's Astro install or the built main process is missing. Run it by hand with
// `node test/renderer/app/designMode/designModeSoak.test.js`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** A step's wait for the state it expects: short, so a failure shows within a couple of minutes. */
const WAIT_MS_MAX = 30_000;
/** Opening a copy also starts its dev server, which takes longer than any other step. */
const OPEN_WAIT_MS_MAX = 90_000;
/** How long the target must hold after a selection, as long as a person takes to start typing. */
const THINK_MS = 1_500;
const POLL_MS = 100;
/** One press's wait to be the selection, before it is pressed again. */
const SELECT_WAIT_MS_MAX = 10_000;
/** Characters a field's old value may have. */
const FIELD_CHARS_MAX = 12;
const TREE_FILES_MAX = 50_000;
const CHECKS_MIN = 30;

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
    console.log(`# times ${JSON.stringify(report.times)}`);
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

const modeButton = (name) => `[...document.querySelectorAll('.ai-header .ai-mode-button')].find((b) => ${name}.test(b.getAttribute('aria-label') || ''))`;
const PLAIN_INDENT = `getComputedStyle(document.querySelector('#soak-plain')).textIndent`;
const TILES = `[...document.querySelectorAll('.dm-tile:not([data-dm-ghost])')]`;
/** In the page: a frame's shown document. */
const FRAME_DOCUMENT = `((id) => [...document.querySelectorAll('.dm-tile[data-dm-tile="' + id + '"] iframe')].find((f) => f.style.visibility !== 'hidden')?.contentDocument)`;
/** In the page: the ids of the frames that show a document with the soak page in it, in order. */
const DRAWN = `${TILES}.map((t) => t.dataset.dmTile).filter((id) => ${FRAME_DOCUMENT}(id)?.querySelector('#soak-plain')).join(',')`;
const frameIndent = (id) =>
  `(() => { const doc = ${FRAME_DOCUMENT}('${id}'); const e = doc && doc.querySelector('#soak-plain'); return e ? doc.defaultView.getComputedStyle(e).textIndent : undefined; })()`;
/** In the page: the window point of an element drawn in a frame, where the frame's own hit test finds it. */
const framePointOf = (id, selector) => `(() => {
  const doc = ${FRAME_DOCUMENT}('${id}'); const element = doc && doc.querySelector(${JSON.stringify(selector)});
  const body = document.querySelector('.dm-tile[data-dm-tile="${id}"] .dm-body'); if (!element || !body) return undefined;
  const outer = body.getBoundingClientRect(); const zoom = outer.width / body.offsetWidth; const r = element.getBoundingClientRect();
  for (let row = 1; row < 5; row += 1) for (let column = 1; column < 12; column += 1) {
    const x = r.left + (r.width * column) / 12; const y = r.top + (r.height * row) / 5;
    const sx = outer.left + x * zoom; const sy = outer.top + y * zoom;
    const top = document.elementFromPoint(sx, sy);
    if (element.contains(doc.elementFromPoint(x, y)) && top && top.closest('.dm-plane')) return { x: Math.round(sx), y: Math.round(sy) };
  }
  return undefined;
})()`;
const centreOf = (selector) =>
  `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return undefined; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) }; })()`;
const OUTLINE = `(() => { const o = document.querySelector('[data-dm-outline="picked"]'); if (!o) return undefined; return { frame: o.closest('.dm-tile').dataset.dmTile, top: parseFloat(o.style.top), height: parseFloat(o.style.height) }; })()`;
/** Times, in the page, how long after the next release of the pointer `ready` first holds. */
const armTimer = (ready) => `(() => {
  window.__dmTime = undefined;
  const from = () => {
    const start = performance.now(); let polls = 0;
    const look = () => { polls += 1; if (${ready}) { window.__dmTime = performance.now() - start; } else if (polls < 6000) setTimeout(look, 4); };
    setTimeout(look, 0);
  };
  window.addEventListener('pointerup', from, { capture: true, once: true });
  return 0;
})()`;

async function runInElectron({ window, project, options }) {
  const { app } = require('electron');
  const { createDriver } = require('../../../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../../../helpers/e2e/panelRecorder.js');
  const { waitFor, waitForSteady } = require('../../../helpers/waitFor.js');
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
      `document.querySelector('.ai-mode-button') ? 0 : ([...document.querySelectorAll('.rail button')].find((b) => /AI/.test(b.getAttribute('aria-label') || ''))?.click(), 0)`,
    );
  /** Clicks the AI panel header's mode button named `name`. */
  const pickMode = async (name) => {
    await openAiPanel();
    await until(`the ${name.source} button`, `!!${modeButton(name)}`);
    await driver.settle();
    await driver.evaluate(`${modeButton(name)}.click()`);
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

  const times = {};
  const point = (what, expression) => until(what, expression);
  /** A real press at the point `expression` names, once it names one. */
  const pressAt = async (what, expression, options) => {
    const at = await point(what, expression);
    await driver.pointerPress(at, options);
    return at;
  };
  const panelNames = (name) => `(document.querySelector('.embed-editor_root')?.textContent || '').includes(${JSON.stringify(name)})`;
  const selectInFrame = async (id, selector) => {
    await pressAt(`${selector} in ${id}`, framePointOf(id, selector), { label: 'select in frame' });
    await until(`the Style panel on ${selector}`, panelNames(selector.slice(1)), Boolean, WAIT_MS_MAX);
    await until(`the outline in ${id}`, OUTLINE, (outline) => outline !== undefined && outline.frame === id);
    await driver.settle();
  };
  const liveRootNow = () => {
    const fence = designFenceState();
    return fence.kind === 'on' ? path.join(fence.sandboxRoot, 'site', path.basename(project)) : '';
  };

  /** Chooses Design mode with a real press and times, in the page, how long until a frame is drawn on a canvas. */
  const enterAndTime = async () => {
    await openAiPanel();
    const button = await point(
      'the Design mode button',
      `(() => { const b = ${modeButton(/design mode/i)}; if (!b) return undefined; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    await driver.settle();
    await driver.evaluate(armTimer(`!!document.querySelector('.dm-canvas') && !!document.querySelector('.dm-tile .dm-document, .dm-tile .dm-skeleton')`));
    await driver.evaluate(
      `(() => { const from = () => { const start = performance.now(); const look = () => { if ((${DRAWN}) !== '') { window.__dmDrawnAt = performance.now() - start; } else if (performance.now() - start < 20000) setTimeout(look, 4); }; setTimeout(look, 0); }; window.__dmDrawnAt = undefined; window.addEventListener('pointerup', from, { capture: true, once: true }); return 0; })()`,
    );
    await driver.pointerPress(button);
    const canvasMs = await until('the canvas on the click', `window.__dmTime`, (value) => value !== undefined);
    const drawnMs = await until('a drawn frame before the reload', `window.__dmDrawnAt`, (value) => value !== undefined);
    return { canvasMs: Math.round(canvasMs), drawnMs: Math.round(drawnMs) };
  };

  await run('entering shows the canvas with the page as its first frame', async () => {
    times.enter = await enterAndTime();
    check('the canvas is up within 100 ms of the click', times.enter.canvasMs < 100, times.enter.canvasMs);
    check('a drawn frame within half a second of the click', times.enter.drawnMs < 500, times.enter.drawnMs);
    await shot('00-opening');
    await collectToasts();
    await untilOpen(
      'the Design mode canvas',
      `!!document.querySelector('.dm-bar') && !document.querySelector('.dm-status') && !!document.querySelector('.dm-plane')`,
    );
    await reopened();
    const fence = designFenceState();
    check('the fence is up', fence.kind === 'on');
    check('the copy is in the app data folder', fence.kind === 'on' && fence.sandboxRoot.startsWith(fs.realpathSync(app.getPath('userData'))));
    check('the copy is private to the person', (fs.statSync(sandboxes).mode & 0o777) === 0o700);
    await untilOpen('the first frame drawn', `${DRAWN} === 'f1'`);
    await untilOpen('the live canvas up', `!!document.querySelector('.preview-frame-wrap iframe[aria-hidden="false"]')`);
    await untilCanvas('the live page', PLAIN_INDENT);
    const covers = await until(
      'the canvas over the preview',
      `(() => { const w = document.querySelector('.preview-frame-wrap').getBoundingClientRect(); const hit = document.elementFromPoint(w.left + w.width / 2, w.top + w.height / 2); return !!hit && !!hit.closest('.dm-canvas'); })()`,
    );
    check('the canvas is the view', covers === true);
    check(
      'frame documents run no script',
      await driver.evaluate(`[...document.querySelectorAll('.dm-document')].every((f) => f.getAttribute('sandbox') === 'allow-same-origin')`),
    );
    await driver.settle();
    await shot('01-entered');
  });

  await run('a click in a frame drives the real Style panel, on Inline styles, and the edit shows in the frame', async () => {
    await selectInFrame('f1', '#soak-plain');
    await until('the Inline styles chip picked', `!!document.querySelector('.embed-editor_selector-chip.is-inline.is-active')`);
    await waitForSteady({
      what: 'Inline styles still the target',
      read: () => driver.evaluate(`!!document.querySelector('.embed-editor_selector-chip.is-inline.is-active')`).catch(() => false),
      until: Boolean,
      steadyPollCount: THINK_MS / POLL_MS,
      pollIntervalMs: POLL_MS,
      pollCountMax: WAIT_MS_MAX / POLL_MS,
    });
    check('a new selection starts on Inline styles', true);
    await setIndent('40px');
    const started = Date.now();
    await until('the frame at 40px', frameIndent('f1'), (size) => size === '40px');
    times.frameBehindLiveMs = Date.now() - started;
    check('the frame shows the edit', true);
    const saved = await waitFor({
      what: 'the inline style saved in the copy',
      read: () => fs.readFileSync(path.join(liveRootNow(), 'src/pages/index.astro'), 'utf8'),
      until: (text) => /id="soak-plain"[^>]*style="[^"]*text-indent: ?(40px|2\.5rem)/.test(text),
      pollIntervalMs: POLL_MS,
      pollCountMax: SELECT_WAIT_MS_MAX / POLL_MS,
    }).then(
      () => true,
      () => false,
    );
    check('the edit is an inline style in the copy', saved);
    check('the project page is unchanged', fs.readFileSync(path.join(project, 'src/pages/index.astro'), 'utf8') === plainBefore);
    await shot('02-inline-style');
  });

  await run('the Navigator follows the pick, and a Navigator pick is outlined in the frame', async () => {
    await until('the navigator tree', `document.querySelectorAll('.structure-node').length > 2`);
    const selectedRow = `(document.querySelector('.structure-node.selected, .structure-node.is-selected, .structure-node[aria-selected="true"]')?.textContent || '')`;
    const rowText = await driver.evaluate(selectedRow);
    check('the Navigator selected a row', rowText.length > 0, rowText);
    const before = await driver.evaluate(OUTLINE);
    const heading = `[...document.querySelectorAll('.structure-node')].find((n) => /heading/i.test(n.textContent || ''))`;
    const row = await driver.panelPoint(heading);
    await driver.pointerPress(row);
    await until('the outline moved with the Navigator', OUTLINE, (outline) => outline !== undefined && outline.top !== before.top);
    check('a Navigator pick is outlined in the frame', true);
    await shot('03-navigator');
  });

  await run('a component clicked in a frame shows its props in the Settings panel', async () => {
    await pressAt('the heading component in f1', framePointOf('f1', '#soak-heading-one'), { label: 'select component' });
    await until('the outline on the heading', OUTLINE, (outline) => outline !== undefined);
    await driver.settle();
    const tabPoint = (name) =>
      `(() => { const b = [...document.querySelectorAll('.right-tabs button')].find((x) => x.textContent.trim() === '${name}'); if (!b) return undefined; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`;
    await pressAt('the Settings tab', tabPoint('Settings'));
    // The Settings panel itself, shown: its title names the component, and it lists the component's own props.
    const shownProps = `(() => { const title = [...document.querySelectorAll('.props-title')].find((t) => t.checkVisibility({ visibilityProperty: true })); return title ? title.parentElement.innerText : undefined; })()`;
    const props = await until(
      'the component props',
      shownProps,
      (text) => typeof text === 'string' && /^\s*Heading/.test(text) && /variant/i.test(text) && /max\s?width/i.test(text),
    );
    check('the Settings panel lists the component\u2019s own props', typeof props === 'string', props);
    report.settingsText = props;
    await driver.settle();
    await shot('04-settings');
    await pressAt('the Style tab', tabPoint('Style'));
    await driver.settle();
  });

  await run('Option-drag on a frame duplicates it at once', async () => {
    const from = await point('a point on f1', framePointOf('f1', '#soak-heading-two'));
    const box = await driver.evaluate(
      `(() => { const r = document.querySelector('.dm-tile[data-dm-tile="f1"] .dm-body').getBoundingClientRect(); return { width: r.width }; })()`,
    );
    await driver.evaluate(armTimer(`${DRAWN} === 'f1,f2' && !document.querySelector('[data-dm-ghost]')`));
    await driver.drag(from, { x: Math.round(from.x + box.width + 24), y: from.y }, { modifiers: ['alt'], steps: 10, label: 'option drag' });
    times.optionDragMs = await until('the copy drawn', `window.__dmTime`, (value) => value !== undefined);
    check('Option-drag makes a drawn copy within 100 ms of release', times.optionDragMs < 100, times.optionDragMs);
    check('the copy keeps the frame\u2019s look', (await driver.evaluate(frameIndent('f2'))) === '40px');
    check('the copy is the selected frame', await driver.evaluate(`!!document.querySelector('.dm-tile.is-selected[data-dm-tile="f2"]')`));
    await shot('05-option-drag');
    await pressAt('the zoom button', centreOf('.dm-zoom'));
    await driver.settle();
    await shot('06-two-frames-fitted');
  });

  await run('each frame keeps its own version', async () => {
    await selectInFrame('f2', '#soak-plain');
    await setIndent('60px');
    await until('the copy at 60px', frameIndent('f2'), (size) => size === '60px');
    check('the first frame is unchanged by the copy\u2019s edit', (await driver.evaluate(frameIndent('f1'))) === '40px');
    const started = Date.now();
    await selectInFrame('f1', '#soak-plain');
    await untilCanvas('the copy of the site showing the first frame', PLAIN_INDENT, (size) => size === '40px');
    times.switchFrameMs = Date.now() - started;
    check('picking in the first frame shows its version to the panels', true);
    check('the second frame kept its own version', (await driver.evaluate(frameIndent('f2'))) === '60px');
    check('the first frame kept its own version', (await driver.evaluate(frameIndent('f1'))) === '40px');
    await setIndent('48px');
    await until('the first frame at 48px', frameIndent('f1'), (size) => size === '48px');
    check('an edit after switching lands in that frame only', (await driver.evaluate(frameIndent('f2'))) === '60px');
    await shot('07-two-versions');
  });

  await run('right-click on a frame duplicates it from the menu', async () => {
    const at = await point('a point on f2', framePointOf('f2', '#soak-plain'));
    driver.contents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 });
    driver.contents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 });
    const item = `(() => { const b = [...document.querySelectorAll('.menu-surface .menu-row')].find((r) => /duplicate/i.test(r.textContent || '')); if (!b) return undefined; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`;
    await point('the menu', item);
    await shot('08-menu');
    await driver.evaluate(armTimer(`${DRAWN} === 'f1,f2,f3'`));
    await pressAt('Duplicate', item);
    times.menuDuplicateMs = await until('the third frame drawn', `window.__dmTime`, (value) => value !== undefined);
    check('Duplicate in the menu makes a drawn copy within 100 ms', times.menuDuplicateMs < 100, times.menuDuplicateMs);
    await until('the third frame shows the second\u2019s version', frameIndent('f3'), (size) => size === '60px');
    check('the menu copied the right frame', true);
    await pressAt('the zoom button', centreOf('.dm-zoom'));
    await driver.settle();
    await shot('09-three-frames');
  });

  await run('a frame moves by its name', async () => {
    const title = await point('the third name', centreOf('.dm-tile[data-dm-tile="f3"] .dm-title-name'));
    const left = `parseFloat(document.querySelector('.dm-tile[data-dm-tile="f3"]').style.left)`;
    const before = await driver.evaluate(left);
    await driver.drag(title, { x: title.x + 40, y: title.y + 60 }, { label: 'move frame' });
    await until('the frame moved', left, (value) => value > before);
    check('dragging a name moves the frame', (await driver.evaluate(`${TILES}.length`)) === 3);
  });

  await run('the canvas pans and zooms, a frame is renamed from its menu, and Escape steps out', async () => {
    const world = `document.querySelector('.dm-world').style.transform`;
    const middle = await point(
      'the canvas',
      `(() => { const r = document.querySelector('.dm-plane').getBoundingClientRect(); return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    const before = await driver.evaluate(world);
    await driver.wheel(middle, -120);
    await until('the canvas panned', world, (value) => value !== before);
    check('a scroll pans the canvas', true);
    const zoom = `parseFloat(document.querySelector('.dm-zoom').textContent)`;
    const percent = await driver.evaluate(zoom);
    driver.contents.sendInputEvent({ type: 'mouseWheel', x: middle.x, y: middle.y, deltaX: 0, deltaY: 120, canScroll: true, modifiers: ['meta'] });
    await until('the canvas zoomed', zoom, (value) => value !== percent);
    check('a scroll with \u2318 zooms the canvas', true);
    const panned = await driver.evaluate(world);
    await driver.drag(middle, { x: middle.x + 60, y: middle.y + 30 }, { label: 'pan' });
    await until('the canvas dragged', world, (value) => value !== panned);
    check('dragging the empty canvas pans it', (await driver.evaluate(`${TILES}.length`)) === 3);
    await pressAt('the zoom button', centreOf('.dm-zoom'));
    await driver.settle();
    const name = await point('the third name', centreOf('.dm-tile[data-dm-tile="f3"] .dm-title-name'));
    driver.contents.sendInputEvent({ type: 'mouseDown', x: name.x, y: name.y, button: 'right', clickCount: 1 });
    driver.contents.sendInputEvent({ type: 'mouseUp', x: name.x, y: name.y, button: 'right', clickCount: 1 });
    await pressAt(
      'Rename',
      `(() => { const b = [...document.querySelectorAll('.menu-surface .menu-row')].find((r) => /rename/i.test(r.textContent || '')); if (!b) return undefined; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    await until('the name field', `document.activeElement?.className === 'dm-title-input'`);
    await driver.typeText('Bold');
    await driver.key('Enter');
    await until('the new name', `document.querySelector('.dm-tile[data-dm-tile="f3"] .dm-title-name')?.textContent`, (text) => text === 'Bold');
    check('a frame is renamed', true);
    await selectInFrame('f3', '#soak-plain');
    await driver.evaluate(`0`);
    await driver.key('Escape');
    await until(
      'the frame selected',
      `!!document.querySelector('.dm-tile.is-selected[data-dm-tile="f3"]') && !document.querySelector('[data-dm-outline="picked"]')`,
    );
    check('Escape steps from an element to its frame', true);
    await driver.key('Escape');
    await until('nothing selected', `!document.querySelector('.dm-tile.is-selected')`);
    check('Escape again clears the selection', (await driver.evaluate(`${TILES}.length`)) === 3);
  });

  await run('Delete removes a selected frame; the last one stays; \u2318D duplicates it', async () => {
    await pressAt('the third name', centreOf('.dm-tile[data-dm-tile="f3"] .dm-title-name'));
    await until('f3 selected', `!!document.querySelector('.dm-tile.is-selected[data-dm-tile="f3"]')`);
    await driver.settle();
    await driver.evaluate(armTimer(`false`));
    await driver.key('Delete');
    await until('two frames', `${TILES}.length === 2`);
    check('Delete removed the selected frame', true);
    await pressAt('the second name', centreOf('.dm-tile[data-dm-tile="f2"] .dm-title-name'));
    await until('f2 selected', `!!document.querySelector('.dm-tile.is-selected[data-dm-tile="f2"]')`);
    await untilCanvas('the site copy on f2', PLAIN_INDENT, (size) => size === '60px');
    await driver.settle();
    await driver.key('Backspace');
    await until('one frame', `${TILES}.length === 1`);
    check('Backspace removed the selected frame', true);
    await untilCanvas('the site copy back on the remaining frame', PLAIN_INDENT, (size) => size === '48px');
    check('removing the shown frame shows the other', true);
    await pressAt('the first name', centreOf('.dm-tile[data-dm-tile="f1"] .dm-title-name'));
    await driver.settle();
    await driver.key('Delete');
    await driver.settle();
    check('the last frame stays', (await driver.evaluate(`${TILES}.length`)) === 1);
    // A second frame again, for what follows.
    await driver.key('d', { modifiers: ['meta'] });
    await until('two frames from the keyboard', `${TILES}.length === 2`);
    check('\u2318D duplicates the selected frame', true);
    await driver.settle();
    await pressAt('the zoom button', centreOf('.dm-zoom'));
    await driver.settle();
    const copy = await driver.evaluate(`${TILES}[1].dataset.dmTile`);
    await selectInFrame(copy, '#soak-plain');
    await setIndent('72px');
    await until('the new copy at 72px', frameIndent(copy), (size) => size === '72px');
  });

  await run('an element is dragged and resized in its frame, Escape lets go, and undo takes it back', async () => {
    await pressAt('the zoom button', centreOf('.dm-zoom'));
    await driver.settle();
    const [first, second] = await driver.evaluate(`${TILES}.map((t) => t.dataset.dmTile)`);
    await selectInFrame(second, '#soak-plain');
    const translateIn = (id) =>
      `(() => { const doc = ${FRAME_DOCUMENT}('${id}'); const e = doc && doc.querySelector('#soak-plain'); return e ? doc.defaultView.getComputedStyle(e).translate : undefined; })()`;
    const pageNow = () => fs.readFileSync(path.join(liveRootNow(), 'src/pages/index.astro'), 'utf8');
    const lineNow = () =>
      pageNow()
        .split('\n')
        .find((line) => line.includes('id="soak-plain"')) ?? '';
    const untilFile = (what, test) => waitFor({ what, read: lineNow, until: test, pollIntervalMs: POLL_MS, pollCountMax: WAIT_MS_MAX / POLL_MS });
    const zoom = await driver.evaluate(
      `(() => { const b = document.querySelector('.dm-tile[data-dm-tile="${second}"] .dm-body'); return b.getBoundingClientRect().width / b.offsetWidth; })()`,
    );
    const from = await point('the element', framePointOf(second, '#soak-plain'));
    // Held and then let go of with Escape: nothing is written.
    const before = lineNow();
    driver.contents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    driver.contents.sendInputEvent({ type: 'mouseMove', x: from.x + 30, y: from.y + 30, button: 'left' });
    await until('the element follows the pointer', translateIn(second), (value) => value !== undefined && value !== 'none');
    check('the element follows the pointer while it is held', true);
    await driver.key('Escape');
    driver.contents.sendInputEvent({ type: 'mouseUp', x: from.x + 30, y: from.y + 30, button: 'left', clickCount: 1 });
    await until('the element back', translateIn(second), (value) => value === 'none');
    await driver.settle();
    check('Escape lets go without writing', lineNow() === before, lineNow());
    // A drag that is released.
    await driver.drag(from, { x: from.x + 90, y: from.y + 60 }, { steps: 10, label: 'move element' });
    await untilFile('the move written', (line) => /translate: [^;"]+rem [^;"]+rem/.test(line));
    const moved = /translate: ([-\d.]+)rem ([-\d.]+)rem/.exec(lineNow());
    const offBy = moved === null ? Infinity : Math.max(Math.abs(Number(moved[1]) * 16 - 90 / zoom), Math.abs(Number(moved[2]) * 16 - 60 / zoom));
    check('the move is written in rem as an inline style, where it was dropped', offBy <= 7 / zoom + 1, `${lineNow()} zoom ${zoom} off ${offBy}`);
    await untilCanvas('the live page moved', `getComputedStyle(document.querySelector('#soak-plain')).translate`, (value) => value !== 'none');
    await until('the frame moved', translateIn(second), (value) => value !== undefined && value !== 'none');
    check('the other frame is untouched', (await driver.evaluate(translateIn(first))) === 'none');
    await driver.settle();
    await shot('09c-moved');
    await driver.menu('CmdOrCtrl+Z', 'Undo');
    await untilFile('the move undone', (line) => !line.includes('translate'));
    await until('the frame back', translateIn(second), (value) => value === 'none');
    check('undo takes the move back, in the file and the frame', true);
    await driver.settle();
    // The corner handle resizes.
    const corner = await point('the corner handle', centreOf(`.dm-tile[data-dm-tile="${second}"] [data-dm-handle="se"]`));
    const handleCentre = await driver.evaluate(
      `(() => { const r = document.querySelector('.dm-tile[data-dm-tile="${second}"] [data-dm-handle="se"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    check('the picked element has a corner handle', corner !== undefined);
    await driver.drag(handleCentre, { x: handleCentre.x - 70, y: handleCentre.y + 40 }, { steps: 8, label: 'resize' });
    await untilFile('the size written', (line) => /width: [\d.]+rem/.test(line) && /height: [\d.]+rem/.test(line));
    check('the corner handle writes width and height in rem', true, lineNow());
    await driver.settle();
    await shot('09d-resized');
  });

  await run('publishing and pulling stay out of reach, and the bar holds in a narrow window', async () => {
    check(
      'the chip that would end the mode\u2019s look is not shown',
      await driver.evaluate(`[...document.querySelectorAll('.view-as-chip')].every((chip) => chip.getBoundingClientRect().width === 0)`),
    );
    check('there is no Publish button', await driver.evaluate(`!document.querySelector('.stacki-publish-control')`));
    const published = await driver.evaluate(
      `window.avb.publishStart({ projectPath: ${JSON.stringify(liveRootNow())}, target: 'all' }).then(() => 'ran', (error) => String(error && error.message))`,
    );
    check('publishing is refused by main', /not available in design mode/i.test(published), published);
    const toastsBefore = await driver.evaluate(`window.__dmToasts.length`);
    await driver.key('g', { modifiers: ['alt', 'shift'] });
    await driver.settle();
    const said = await driver.evaluate(`window.__dmToasts.slice(${toastsBefore}).join(' | ')`);
    check('Option+Shift+G says nothing about a repository', !/repository|github/i.test(said), said);
    const [width, height] = window.getContentSize();
    window.setContentSize(1100, 760);
    await until('the narrow window', `innerWidth <= 1100`);
    await driver.settle();
    const fits = await driver.evaluate(
      `JSON.stringify([...document.querySelectorAll('.dm-bar .dm-badge, .dm-bar button')].map((e) => { const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { name: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 20), width: Math.round(r.width), inside: r.left >= 0 && r.right <= innerWidth, clipped: e.scrollWidth > e.clientWidth + 1, reachable: !!hit && (e.contains(hit) || hit.contains(e)) }; }))`,
    );
    check(
      'every control of the bar is whole and reachable at 1100 pixels',
      JSON.parse(fits).every((control) => control.width >= 32 && control.inside && !control.clipped && control.reachable),
      fits,
    );
    await pressAt('the zoom button', centreOf('.dm-zoom'));
    await driver.settle();
    await shot('09b-narrow');
    window.setContentSize(width, height);
    await until('the wide window', `innerWidth === ${width}`);
    await driver.settle();
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

  await run('Send to AI reopens the project with a picture of each frame waiting in the AI panel', async () => {
    await pressAt('Send to AI', centreOf('.dm-bar .dm-button.is-primary'));
    await collectToasts();
    await untilOpen('the project open again', `!document.querySelector('.dm-bar') && !!document.querySelector('.embed-editor_root')`);
    await reopened();
    await until('the frames in the AI panel draft', `(document.querySelector('.ai-composer')?.textContent || '').includes('Design mode')`);
    check('the draft carries the request', true);
    const pictures = await until(
      'the pictures',
      `[...document.querySelectorAll('.ai-composer img')].map((i) => i.src).filter((s) => s.startsWith('data:image/png'))`,
      (list) => list.length >= 2,
    );
    pictures
      .slice(0, 2)
      .forEach((picture, index) =>
        fs.writeFileSync(path.join(options.outDirectory, `10-handoff-${index + 1}.png`), Buffer.from(picture.slice(picture.indexOf(',') + 1), 'base64')),
      );
    check('one picture a frame', pictures.length === 2, pictures.length);
    check('the fence is down', designFenceState().kind === 'off');
    check('the copy and its .env are deleted', leftInSandboxes().length === 0);
    check('the project is byte-identical', treeDigest(project) === before);
    await shot('11-sent');
  });

  await run('coming back shows every frame from its kept document; Exit leaves again', async () => {
    const asked = Date.now();
    times.reenter = await enterAndTime();
    check('kept frames are drawn within half a second of the click', times.reenter.drawnMs < 500, times.reenter.drawnMs);
    await collectToasts();
    await untilOpen(
      'the canvas again with both frames drawn',
      `!!document.querySelector('.dm-bar') && !document.querySelector('.dm-status') && (${DRAWN}).split(',').length === 2`,
    );
    times.reenterMs = Date.now() - asked;
    const first = await driver.evaluate(
      `JSON.stringify(${TILES}.map((t) => { const doc = ${FRAME_DOCUMENT}(t.dataset.dmTile); return doc.defaultView.getComputedStyle(doc.querySelector('#soak-plain')).textIndent; }))`,
    );
    check('both frames come back with their own look', first === '["48px","72px"]', first);
    times.liveCanvasUpAfterFrames = await driver.canvasEvaluate(PLAIN_INDENT).then(
      () => 'up',
      () => 'not yet',
    );
    await reopened();
    await untilCanvas('the shown frame\u2019s style restored', PLAIN_INDENT, (size) => size === '72px');
    await driver.settle();
    await shot('12-restored');
    await pressAt('Exit', centreOf('.dm-bar .dm-exit'));
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
  });

  await collectToasts();
  const refusals = toasts.filter((text) => /not available in design mode/i.test(text));
  check('no refused request reached the person as a toast', refusals.length === 0, refusals.join(' | '));
  report.toasts = toasts;
  report.times = times;
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
