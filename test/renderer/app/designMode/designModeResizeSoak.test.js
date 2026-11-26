// Goal: in the real app, a Design mode frame is made wider and narrower with a real pointer, as an artboard is. A
// drag of either side shows the width while it lasts and reflows the frame's own page, so a media query answers
// before the release, while the canvas under the frame is neither resized nor pictured again; the other side stays
// where it is; Escape puts the width back. On release the canvas under Design mode takes the width, and the frame is
// pictured again at it. The width stays within the editor's limits, a taller page that gets shorter makes a shorter
// frame, a drag zoomed in or out follows the pointer, Space still pans, a width can be typed, each frame keeps its
// own through switching, duplicating, leaving and coming back, and the project is byte-identical afterwards.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) runs the real desktop app hidden, with a temporary user
// data folder and the mock keychain, on a copy of the Lumos fixture site with the style soak page, to which this
// test adds one media query before the mode begins. No step sleeps: each waits on the state it expects
// (test/helpers/waitFor.js). Screenshots go to STACKI_SCREENSHOT_DIR (default
// node_modules/.stacki-test/design-resize). The suite skips where the fixture's Astro install or the built main
// process is missing. Run it by hand with `node test/renderer/app/designMode/designModeResizeSoak.test.js`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const WAIT_MS_MAX = 30_000;
const OPEN_WAIT_MS_MAX = 90_000;
const POLL_MS = 100;
const TREE_FILES_MAX = 50_000;
const CHECKS_MIN = 30;
const DRAG_STEPS = 12;

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../../../helpers/e2e/soakLaunch.js');
  // It drives the real pointer, so like every pointer probe it runs on macOS only (docs/release-runbook.md).
  const unavailable = process.platform === 'darwin' ? soakUnavailableReason() : 'a pointer probe, macOS only';
  if (unavailable !== undefined) {
    console.log(`# skip designModeResizeSoak: ${unavailable}`);
    return;
  }
  const { repoPath } = require('../../../helpers/sources.js');
  const outDirectory = process.env.STACKI_SCREENSHOT_DIR ?? repoPath('node_modules/.stacki-test/design-resize');
  fs.mkdirSync(outDirectory, { recursive: true });
  fs.rmSync(path.join(outDirectory, 'report.json'), { force: true });
  // While Design mode is on, the app may write only to its copy, its own data and the temporary folder.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-design-resize-'));
  const { code, directory, leftovers } = await runSoak({ scenarioModule: __filename, options: { outDirectory: staging }, keepDirectory: false });
  for (const name of fs.readdirSync(staging)) {
    fs.copyFileSync(path.join(staging, name), path.join(outDirectory, name));
  }
  fs.rmSync(staging, { recursive: true, force: true });
  const fail = (what) => {
    console.error(`not ok - ${what}`);
    process.exitCode = 1;
  };
  if (leftovers.length > 0) {
    fail(`processes outlived the run: ${leftovers.join(', ')}`);
  }
  if (fs.existsSync(directory)) {
    fail(`the run directory ${directory} was not removed`);
  }
  const reportFile = path.join(outDirectory, 'report.json');
  if (code !== 0 || !fs.existsSync(reportFile)) {
    fail(`the run did not finish (exit ${code})`);
    return;
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  report.failures.forEach(fail);
  if (report.checked < CHECKS_MIN) {
    fail(`only ${report.checked} checks ran`);
  }
  console.log(`# ${JSON.stringify(report.notes)}`);
  if (process.exitCode !== 1) {
    console.log(`ok - ${report.checked} checks: a Design mode frame is resized like an artboard, its page reflowing`);
  }
}

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

/** A short page whose cards wrap, so it is taller the narrower it is, with one media query. */
const PAGE = `<html>
  <body>
    <p id="soak-plain">A line the media query spaces out.</p>
    <div class="cards">${'<div class="card">card</div>'.repeat(12)}</div>
  </body>
</html>
<style is:global>
  .cards { display: flex; flex-wrap: wrap; }
  .card { width: 240px; height: 300px; }
  #soak-plain { letter-spacing: 1px; }
  @media (width < 48rem) { #soak-plain { letter-spacing: 5px; } }
</style>
`;
const modeButton = `[...document.querySelectorAll('.ai-header .ai-mode-button')].find((b) => /design mode/i.test(b.getAttribute('aria-label') || ''))`;
const tile = (id) => `document.querySelector('.dm-tile[data-dm-tile="${id}"]')`;
const FRAME_DOCUMENT = (id) => `[...document.querySelectorAll('.dm-tile[data-dm-tile="${id}"] iframe')].find((f) => f.style.visibility !== 'hidden')`;
/** In the page: a frame as drawn: its width and place in canvas pixels, its document's width, and its edges on screen. */
const drawn = (id) => `(() => {
  const t = ${tile(id)}; const f = ${FRAME_DOCUMENT(id)}; const body = t && t.querySelector('.dm-body');
  const doc = f && f.contentDocument; const probe = doc && doc.querySelector('#soak-plain');
  if (!body || !probe) return undefined;
  const r = body.getBoundingClientRect();
  return { width: body.offsetWidth, height: body.offsetHeight, x: parseFloat(t.style.left), inner: f.contentWindow.innerWidth,
    spacing: doc.defaultView.getComputedStyle(probe).letterSpacing, content: doc.body.scrollHeight, left: r.left, right: r.right, zoom: r.width / body.offsetWidth };
})()`;
/** In the page: where a frame's side is pressed: the middle of the strip beside it, near the top of the page. */
const edgePoint = (id, edge) => `(() => {
  const strip = ${tile(id)}?.querySelector('.dm-edge.is-${edge} .dm-edge-grip'); const plane = document.querySelector('.dm-plane');
  if (!strip || !plane) return undefined;
  const r = strip.parentElement.getBoundingClientRect(); const g = strip.getBoundingClientRect();
  const at = { x: Math.round(r.left + r.width / 2), y: Math.round(g.top + g.height / 2) };
  const hit = document.elementFromPoint(at.x, at.y);
  return hit && hit.closest('.dm-edge') === strip.parentElement ? at : undefined;
})()`;
const centreOf = (selector) =>
  `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return undefined; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`;

async function runInElectron({ window, project, options }) {
  const { createDriver } = require('../../../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../../../helpers/e2e/panelRecorder.js');
  const { waitFor } = require('../../../helpers/waitFor.js');
  const driver = createDriver(window, project);
  const report = { checked: 0, failures: [], notes: {} };
  const check = (what, condition, detail) => {
    report.checked += 1;
    if (!condition) {
      report.failures.push(`${what}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
    }
  };
  const shot = (name) => driver.screenshot(path.join(options.outDirectory, `${name}.png`));
  const until = async (what, expression, test = Boolean, waitMsMax = WAIT_MS_MAX) => {
    let last;
    try {
      return await waitFor({
        what,
        read: async () => {
          last = await driver.evaluate(expression).catch(() => undefined);
          return last;
        },
        until: test,
        pollIntervalMs: POLL_MS,
        pollCountMax: waitMsMax / POLL_MS,
      });
    } catch (error) {
      throw new Error(`${error.message}; last: ${JSON.stringify(last)}`);
    }
  };
  const untilFrame = (what, id, test) => until(what, drawn(id), (value) => value !== undefined && test(value));
  const untilCanvasWidth = (what, width) =>
    waitFor({
      what,
      read: () => driver.canvasEvaluate('window.innerWidth').catch(() => undefined),
      until: (inner) => inner === width,
      pollIntervalMs: POLL_MS,
      pollCountMax: WAIT_MS_MAX / POLL_MS,
    });
  const canvasWidth = () => driver.canvasEvaluate('window.innerWidth');
  const run = async (what, act) => {
    try {
      await act();
    } catch (error) {
      report.failures.push(`${what}: ${String(error && error.message ? error.message : error)}`);
      await shot('failed-' + what.replace(/\W+/g, '-')).catch(() => undefined);
    }
  };
  const reopened = async () => {
    await driver.waitForApp();
    await driver.setPageFocus('focused');
    await installRecorder(driver.contents);
    await driver.settle();
  };
  const fitCanvas = async () => {
    await driver.evaluate(`document.activeElement?.blur(); 0`);
    await driver.key('1', { modifiers: ['shift'] });
    await driver.settle();
  };
  const mouse = (type, at, extra = {}) => driver.contents.sendInputEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1, ...extra });
  /** Presses at `from` and moves to `to` a step at a time, leaving the button down. */
  const dragHeld = async (from, to) => {
    mouse('mouseMove', from);
    mouse('mouseDown', from);
    for (let step = 1; step <= DRAG_STEPS; step += 1) {
      mouse('mouseMove', { x: Math.round(from.x + ((to.x - from.x) * step) / DRAG_STEPS), y: from.y });
      // A round trip through the page, so each move is taken before the next is sent.
      await driver.evaluate('0');
    }
  };
  /** Drags side `edge` of frame `id` by `byPx` canvas pixels with a real pointer, and releases. */
  const resizeBy = async (id, edge, byPx) => {
    const at = await until(`the ${edge} side of ${id}`, edgePoint(id, edge));
    const { zoom } = await driver.evaluate(drawn(id));
    await driver.drag(at, { x: Math.round(at.x + byPx * zoom), y: at.y }, { steps: DRAG_STEPS, label: 'resize frame' });
  };
  const near = (value, wanted, slack) => Math.abs(value - wanted) <= slack;
  const enter = async () => {
    await driver.evaluate(
      `document.querySelector('.ai-mode-button') ? 0 : ([...document.querySelectorAll('.rail button')].find((b) => /AI/.test(b.getAttribute('aria-label') || ''))?.click(), 0)`,
    );
    await until('the Design mode button', `!!(${modeButton})`);
    await driver.settle();
    await driver.evaluate(`${modeButton}.click()`);
    await until(
      'the Design mode canvas',
      `!!document.querySelector('.dm-bar') && !document.querySelector('.dm-status') && !!document.querySelector('.dm-plane')`,
      Boolean,
      OPEN_WAIT_MS_MAX,
    );
    await reopened();
    await until('a drawn frame', `!!(${drawn('f1')})`, Boolean, OPEN_WAIT_MS_MAX);
    await until('the live canvas up', `!!document.querySelector('.preview-frame-wrap iframe[aria-hidden="false"]')`, Boolean, OPEN_WAIT_MS_MAX);
  };

  const page = path.join(project, 'src/pages/index.astro');
  fs.writeFileSync(page, PAGE);
  await driver.waitForApp();
  await driver.setPageFocus('focused');
  await installRecorder(driver.contents);
  await driver.settle();
  const before = treeDigest(project);
  let start;

  await run('entering', async () => {
    await enter();
    await fitCanvas();
    await until('the fixture page in the frame', `!!${FRAME_DOCUMENT('f1')}?.contentDocument?.querySelector('.cards')`);
    start = await untilFrame('the frame at the canvas width', 'f1', (frame) => frame.width > 700 && frame.spacing === '1px');
    report.notes.start = { width: start.width, height: start.height, zoom: start.zoom };
    check('a frame starts at the canvas width', near(await canvasWidth(), start.width, 1), [await canvasWidth(), start.width]);
    check('a frame has a handle on each side', (await driver.evaluate(`${tile('f1')}.querySelectorAll('.dm-edge').length`)) === 2);
    const at = await until('the right side', edgePoint('f1', 'e'));
    await driver.hover(at);
    check('the side shows a resize cursor', (await driver.evaluate(`getComputedStyle(document.elementFromPoint(${at.x}, ${at.y})).cursor`)) === 'ew-resize');
    await shot('01-start');
  });

  await run('a drag reflows the frame live and Escape puts it back', async () => {
    const live = await canvasWidth();
    await driver.evaluate(`window.__dmHtml = ${FRAME_DOCUMENT('f1')}; window.__dmSource = window.__dmHtml.srcdoc; 0`);
    const at = await until('the right side', edgePoint('f1', 'e'));
    await dragHeld(at, { x: Math.round(at.x + (600 - start.width) * start.zoom), y: at.y });
    const during = await untilFrame('the frame near 600 mid-drag', 'f1', (frame) => near(frame.width, 600, 4));
    check('the media query answers during the drag', during.spacing === '5px' && during.inner === during.width, during);
    check('the left side stays put', near(during.left, start.left, 1) && during.x === start.x, [during.left, start.left]);
    const readout = await driver.evaluate(`document.querySelector('.dm-width')?.textContent`);
    check('the width is read out during the drag', readout === `${during.width} px`, [readout, during.width]);
    check('the resize cursor holds during the drag', (await driver.evaluate(`getComputedStyle(document.querySelector('.dm-plane')).cursor`)) === 'ew-resize');
    check('the canvas under it is not resized per move', (await canvasWidth()) === live);
    check(
      'the frame is not pictured again per move',
      await driver.evaluate(`window.__dmHtml === ${FRAME_DOCUMENT('f1')} && window.__dmHtml.srcdoc === window.__dmSource`),
    );
    await shot('02-dragging');
    await driver.key('Escape');
    const back = await untilFrame('the width put back', 'f1', (frame) => frame.width === start.width);
    mouse('mouseUp', at);
    await driver.settle();
    check('Escape puts the width and the reflow back', back.spacing === '1px' && (await driver.evaluate(`!document.querySelector('.dm-width')`)));
    check('nothing happens on the release after Escape', (await driver.evaluate(drawn('f1'))).width === start.width);
  });

  await run('a released drag resizes the canvas under Design mode and pictures the page there', async () => {
    await driver.evaluate(`window.__dmSource = ${FRAME_DOCUMENT('f1')}.srcdoc; 0`);
    await resizeBy('f1', 'e', 600 - start.width);
    const set = await untilFrame('the frame at about 600', 'f1', (frame) => near(frame.width, 600, 4));
    report.notes.narrow = set.width;
    await untilCanvasWidth('the live canvas at the frame width', set.width);
    check('the live canvas takes the width', true);
    await until('a new picture of the page at that width', `${FRAME_DOCUMENT('f1')}.srcdoc !== window.__dmSource`);
    const after = await untilFrame('the new picture drawn', 'f1', (frame) => frame.inner === set.width);
    check('the pictured page answers the media query', after.spacing === '5px', after);
    check('the frame is as tall as the reflowed page', after.height >= after.content && after.height <= Math.max(after.content + 40, 1_000), after);
    await driver.settle();
    report.notes.styleContext = await driver.evaluate(
      `[...document.querySelectorAll('.embed-editor_root button, .embed-editor_root [role="combobox"]')].map((b) => (b.textContent || '').trim()).filter((t) => /@media|@container|base|px|rem/i.test(t)).slice(0, 8)`,
    );
    await shot('03-narrow');
  });

  await run('the left side moves while the right one stays, and a wider page makes a shorter frame', async () => {
    await fitCanvas();
    const narrow = await driver.evaluate(drawn('f1'));
    await resizeBy('f1', 'w', -300);
    const wide = await untilFrame('the frame 300 wider', 'f1', (frame) => near(frame.width, narrow.width + 300, 4));
    check('the right side stays where it was', near(wide.x + wide.width, narrow.x + narrow.width, 1), [wide, narrow]);
    check('the frame moved left by what it gained', near(narrow.x - wide.x, wide.width - narrow.width, 1));
    await untilCanvasWidth('the live canvas at the wider width', wide.width);
    check('the media query lets go when wide again', (await driver.evaluate(drawn('f1'))).spacing === '1px');
    check('a page that reflows shorter makes a shorter frame', wide.height < narrow.height, [narrow.height, wide.height]);
    report.notes.heights = { narrow: narrow.height, wide: wide.height };
  });

  await run('the width stays within its limits', async () => {
    await fitCanvas();
    await resizeBy('f1', 'e', -3000);
    const least = await untilFrame('the narrowest frame', 'f1', (frame) => frame.width === 280);
    check('a frame is never narrower than 280', least.width === 280);
    await untilCanvasWidth('the live canvas at 280', 280);
  });

  await run('a drag follows the pointer zoomed in', async () => {
    await driver.evaluate(`document.activeElement?.blur(); 0`);
    await driver.key('0', { modifiers: ['meta'] });
    await driver.settle();
    const full = await driver.evaluate(drawn('f1'));
    check('the canvas is at full size', near(full.zoom, 1, 0.01), full.zoom);
    const at = await until('the right side at full size', edgePoint('f1', 'e'));
    await driver.drag(at, { x: at.x + 120, y: at.y }, { steps: DRAG_STEPS });
    await untilFrame('120 wider at full size', 'f1', (frame) => near(frame.width, 400, 1));
    check('at 100% a pointer pixel is a frame pixel', true);
    await driver.key('-', { modifiers: ['meta'] });
    await driver.key('-', { modifiers: ['meta'] });
    await driver.settle();
    const out = await driver.evaluate(drawn('f1'));
    const side = await until('the right side zoomed out', edgePoint('f1', 'e'));
    await driver.drag(side, { x: side.x + 64, y: side.y }, { steps: DRAG_STEPS });
    await untilFrame('wider by the pointer over the zoom', 'f1', (frame) => near(frame.width, 400 + 64 / out.zoom, 2));
    check('zoomed out, the pointer travel is divided by the zoom', true);
  });

  await run('Space still pans from a frame side', async () => {
    await fitCanvas();
    const was = await driver.evaluate(drawn('f1'));
    const world = `document.querySelector('.dm-world').style.transform`;
    const camera = await driver.evaluate(world);
    const at = await until('the right side', edgePoint('f1', 'e'));
    await driver.evaluate(`document.querySelector('.dm-plane').focus(); 0`);
    driver.contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    await driver.drag(at, { x: at.x + 50, y: at.y }, { steps: DRAG_STEPS });
    driver.contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await until('the canvas panned', world, (value) => value !== camera);
    check('Space-drag pans and resizes nothing', (await driver.evaluate(drawn('f1'))).width === was.width);
  });

  const widthButton = (id) => centreOf(`.dm-tile[data-dm-tile="${id}"] .dm-title-width`);
  const typeWidth = async (id, text, lastKey) => {
    const button = await until(`the width of ${id}`, widthButton(id));
    await driver.pointerPress(button);
    await until('the width field', `document.activeElement?.classList.contains('dm-width-input')`);
    await driver.evaluate(`document.activeElement.select(); 0`);
    await driver.typeText(text);
    await driver.key(lastKey);
    await until('the field gone', `!document.querySelector('.dm-width-input')`);
  };

  await run('a width can be typed beside the frame name', async () => {
    await fitCanvas();
    await typeWidth('f1', '390', 'Enter');
    await untilFrame('the typed width', 'f1', (frame) => frame.width === 390 && frame.spacing === '5px');
    await untilCanvasWidth('the live canvas at 390', 390);
    check('Enter sets the typed width', true);
    await fitCanvas();
    await typeWidth('f1', '900', 'Escape');
    await driver.settle();
    check('Escape in the field changes nothing', (await driver.evaluate(drawn('f1'))).width === 390);
    await typeWidth('f1', '12', 'Enter');
    await driver.settle();
    check('a width under the limit is not taken', (await driver.evaluate(drawn('f1'))).width === 390);
    await shot('04-typed');
  });

  await run('a media query picked in the style panel resizes the shown frame, and an element stays picked', async () => {
    await fitCanvas();
    // A press near the start of the paragraph, where the frame's page has its text.
    await driver.pointerPress(
      await until(
        'the paragraph in the frame',
        `(() => { const f = ${FRAME_DOCUMENT('f1')}; const p = f?.contentDocument?.querySelector('#soak-plain'); const body = ${tile('f1')}?.querySelector('.dm-body'); if (!p || !body) return undefined; const o = body.getBoundingClientRect(); const z = o.width / body.offsetWidth; const r = p.getBoundingClientRect(); return { x: Math.round(o.left + (r.left + 20) * z), y: Math.round(o.top + (r.top + 8) * z) }; })()`,
      ),
    );
    await until('the element picked', `!!document.querySelector('[data-dm-outline="picked"]')`);
    await driver.settle();
    /** Opens the style panel's media query list and presses the row whose label matches. */
    const pickQuery = async (label) => {
      await driver.pointerPress(await until('the query dropdown', centreOf('.embed-editor_context-select')));
      const row = `(() => { const row = [...document.querySelectorAll('.u-select-option[role="option"]')].find((o) => ${label}.test((o.textContent || '').trim())); if (!row) return undefined; const r = row.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`;
      await driver.pointerPress(await until(`the ${label} row`, row));
    };
    await pickQuery('/^Base/i');
    const base = await untilFrame('the frame at a Base width', 'f1', (frame) => frame.width > 700 && frame.spacing === '1px');
    await untilCanvasWidth('the live canvas at the Base width', base.width);
    check('picking Base widens the shown frame', true);
    check('the picked element stays picked through it', await driver.evaluate(`!!document.querySelector('[data-dm-outline="picked"]')`));
    await driver.settle();
    await pickQuery('/48rem/');
    const queried = await untilFrame('the frame inside the query', 'f1', (frame) => frame.width < 768 && frame.spacing === '5px');
    await untilCanvasWidth('the live canvas inside the query', queried.width);
    check('picking the media query narrows the shown frame to it', true);
    await driver.settle();
    report.notes.picked = { base: base.width, query: queried.width };
    await fitCanvas();
    const side = await until('the right side', edgePoint('f1', 'e'));
    await driver.drag(side, { x: Math.round(side.x - 60 * queried.zoom), y: side.y }, { steps: DRAG_STEPS });
    await untilFrame('a drag with an element picked', 'f1', (frame) => frame.width < queried.width - 40);
    check(
      'a drag of the shown frame keeps the element picked',
      await driver.evaluate(`!!document.querySelector('[data-dm-outline="picked"]') && !document.querySelector('.dm-tile.is-selected')`),
    );
    await shot('04b-picked');
    await fitCanvas();
    await typeWidth('f1', '390', 'Enter');
    await untilCanvasWidth('the live canvas at 390 again', 390);
  });

  await run('each frame keeps its own width through duplicating and switching', async () => {
    await driver.pointerPress(await until('the first name', centreOf('.dm-tile[data-dm-tile="f1"] .dm-title-name')));
    await until('the frame selected', `!!document.querySelector('.dm-tile.is-selected[data-dm-tile="f1"]')`);
    await driver.key('d', { modifiers: ['meta'] });
    await untilFrame('the copy at the same width', 'f2', (frame) => frame.width === 390);
    check('a duplicate is as wide as its source', true);
    await fitCanvas();
    await driver.settle();
    await resizeBy('f2', 'e', 610);
    const second = await untilFrame('the copy near 1000', 'f2', (frame) => near(frame.width, 1000, 6));
    await untilCanvasWidth('the live canvas at the copy width', second.width);
    check('resizing the copy leaves the first frame', (await driver.evaluate(drawn('f1'))).width === 390);
    await driver.pointerPress(await until('the first name', centreOf('.dm-tile[data-dm-tile="f1"] .dm-title-name')));
    await untilCanvasWidth('the live canvas back at 390', 390);
    await driver.settle();
    check('showing the first frame gives the canvas its width', true);
    check('and the other keeps its own', (await driver.evaluate(drawn('f2'))).width === second.width);
    await fitCanvas();
    // A side of a frame not shown resizes it and shows it.
    await resizeBy('f2', 'e', -200);
    const third = await untilFrame('the unshown frame narrower', 'f2', (frame) => near(frame.width, second.width - 200, 6));
    await untilCanvasWidth('the live canvas at it', third.width);
    check('dragging the side of a frame not shown shows it at that width', true);
    check('the first frame is still 390', (await driver.evaluate(drawn('f1'))).width === 390);
    report.notes.widths = [390, third.width];
    await fitCanvas();
    await shot('05-two-widths');
  });

  await run('the widths come back after leaving, and the project is untouched', async () => {
    const wanted = report.notes.widths;
    await driver.pointerPress(await until('the close button', centreOf('.dm-bar .dm-exit')));
    await until('the project again', `!document.querySelector('.dm-bar') && !document.querySelector('.dm-canvas')`, Boolean, OPEN_WAIT_MS_MAX);
    await reopened();
    check('leaving puts the editor back on Desktop', (await canvasWidth()) > 700, await canvasWidth());
    check('the project is byte-identical', treeDigest(project) === before);
    await enter();
    await untilFrame('the first width again', 'f1', (frame) => frame.width === wanted[0]);
    await untilFrame('the second width again', 'f2', (frame) => frame.width === wanted[1]);
    await untilCanvasWidth('the live canvas at the shown frame width', wanted[1]);
    await driver.settle();
    check('both widths and the shown one come back', (await driver.evaluate(drawn('f1'))).width === wanted[0]);
    await shot('06-back');
    await driver.pointerPress(await until('the close button', centreOf('.dm-bar .dm-exit')));
    await until('the project again', `!document.querySelector('.dm-bar')`, Boolean, OPEN_WAIT_MS_MAX);
    check('the project is still byte-identical', treeDigest(project) === before);
  });

  fs.writeFileSync(path.join(options.outDirectory, 'report.json'), JSON.stringify(report, undefined, 2));
  return 0;
}

module.exports = { runInElectron };

if (require.main === module) {
  void orchestrate();
}
