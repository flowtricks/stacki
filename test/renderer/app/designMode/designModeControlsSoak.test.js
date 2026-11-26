// Goal: in the real app, the things the owner works Design mode with behave: a flex-grow card in a flex column can be
// made shorter and narrower by its handles, writing only what takes effect; the page's own pictures show in a frame;
// hovering a value in the Style panel previews in the frame and leaves nothing behind; the bar's controls stay opaque
// under a real pointer, start over asks first, and the zoom keys zoom; the toolbar keeps only the pointer button,
// which shows the frame live; nothing writes project settings; and Send to AI drafts only a sentence and a picture
// of the whole page, never sent.
//
// Method: the soak harness (test/helpers/e2e/soakLaunch.js) on the Lumos fixture, with a section shaped like the
// owner's card and two pictures written into the temporary copy. Every press, drag, hover and key is a real input
// event. The suite skips where the fixture's Astro install or the built main process is missing. Run it by hand with
// `node test/renderer/app/designMode/designModeControlsSoak.test.js`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WAIT_MS_MAX = 12_000;
const OPEN_WAIT_MS_MAX = 90_000;
const POLL_MS = 100;
const CHECKS_MIN = 20;

async function orchestrate() {
  const { runSoak, soakUnavailableReason } = require('../../../helpers/e2e/soakLaunch.js');
  const unavailable = soakUnavailableReason();
  if (unavailable !== undefined) {
    console.log(`# skip designModeControlsSoak: ${unavailable}`);
    return;
  }
  const { repoPath } = require('../../../helpers/sources.js');
  const outDirectory = process.env.STACKI_SCREENSHOT_DIR ?? repoPath('node_modules/.stacki-test/design-mode-controls');
  fs.mkdirSync(outDirectory, { recursive: true });
  fs.rmSync(path.join(outDirectory, 'report.json'), { force: true });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-design-controls-'));
  const { code, directory, leftovers } = await runSoak({ scenarioModule: __filename, options: { outDirectory: staging }, keepDirectory: false });
  for (const name of fs.readdirSync(staging)) {
    fs.copyFileSync(path.join(staging, name), path.join(outDirectory, name));
  }
  fs.rmSync(staging, { recursive: true, force: true });
  const reportFile = path.join(outDirectory, 'report.json');
  if (code !== 0 || !fs.existsSync(reportFile) || leftovers.length > 0 || fs.existsSync(directory)) {
    console.error(`not ok - the run did not finish cleanly (exit ${code}, left ${leftovers.join(', ')})`);
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
    console.log(`ok - ${report.checked} checks: Design mode's controls behaved`);
  }
}

const CARD = `
<section id="card-section" style="display:flex;flex-direction:column;min-height:48rem">
  <div id="card" class="owner-card">
    <h2 id="card-title">Style Guide</h2>
    <img id="public-picture" src="/owner-picture.png" alt="" width="200" height="100" loading="lazy" />
    <Image id="asset-picture" src={ownerAsset} alt="" width={160} />
    <div id="background-picture" class="owner-bg"></div>
    <picture><source srcset="/owner-picture.png 1x, /owner-picture.png 2x" /><img id="set-picture" src="/owner-picture.png" alt="" width="120" /></picture>
    <img id="svg-picture" src="/owner-mark.svg" alt="" width="40" height="40" />
    <img id="folder-picture" src="/work/dist/owner-picture.png" alt="" width="80" />
    <img id="hidden-picture" src="/owner-picture.png" alt="" style="display:none" />
    <video id="poster-video" poster="/owner-picture.png" width="80" height="40"></video>
  </div>
</section>
<img id="lazy-picture" src="/work/dist/owner-picture.png?far" alt="" loading="lazy" width="100" height="50" style="margin-top: 400rem" />
<style is:global>
  .owner-card { flex: 1 1 0%; display: grid; align-content: center; justify-items: start; background: #b4e550; color: #111; padding: 2rem; border-radius: 1rem; min-height: 20rem; }
  .owner-bg { width: 120px; height: 60px; background-image: url("/owner-picture.png"); background-size: cover; }
</style>
`;

async function runInElectron({ window, project, options }) {
  const { app, nativeImage } = require('electron');
  const { createDriver } = require('../../../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../../../helpers/e2e/panelRecorder.js');
  const { waitFor } = require('../../../helpers/waitFor.js');
  const { designFenceState } = require('#dist/electron/lib/designMode/designFence.js');
  const driver = createDriver(window, project);
  const report = { checked: 0, failures: [], notes: {} };
  const check = (what, condition, detail) => {
    report.checked += 1;
    console.log(`CHECK ${condition ? 'pass' : 'FAIL'} ${what}${condition || detail === undefined ? '' : ` ${String(detail).slice(0, 500)}`}`);
    if (!condition) {
      report.failures.push(`${what}${detail === undefined ? '' : ` (${String(detail).slice(0, 500)})`}`);
    }
  };
  const shot = (name) => driver.screenshot(path.join(options.outDirectory, `${name}.png`)).catch(() => undefined);
  const until = (what, expression, test = Boolean, waitMsMax = WAIT_MS_MAX) =>
    waitFor({ what, read: () => driver.evaluate(expression).catch(() => undefined), until: test, pollIntervalMs: POLL_MS, pollCountMax: waitMsMax / POLL_MS });
  const only = process.env.DM_STEPS === undefined ? undefined : new RegExp(process.env.DM_STEPS);
  const run = async (what, act) => {
    if (only !== undefined && !only.test(what)) {
      return;
    }
    try {
      await act();
    } catch (error) {
      console.log(`CHECK FAIL ${what}: ${String(error && error.message ? error.message : error).slice(0, 400)}`);
      report.failures.push(`${what}: ${String(error && error.message ? error.message : error)}`);
      await shot('failed-' + what.replace(/\W+/g, '-'));
    }
  };
  const centre = (finder) =>
    `(() => { const e = ${finder}; if (!e) return undefined; const r = e.getBoundingClientRect(); return r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : undefined; })()`;
  const press = async (what, finder, extra) => {
    const at = await until(what, centre(finder));
    await driver.pointerPress(at, extra);
    return at;
  };
  const rightPress = async (what, finder) => {
    const at = await until(what, centre(finder));
    driver.contents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 });
    driver.contents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 });
  };
  const move = (point, held) =>
    driver.contents.sendInputEvent({
      type: 'mouseMove',
      x: point.x,
      y: point.y,
      ...(held === 'held' ? { button: 'left', modifiers: ['leftButtonDown'] } : {}),
    });
  const reopened = async () => {
    await driver.waitForApp();
    await driver.setPageFocus('focused');
    await installRecorder(driver.contents);
    await driver.settle();
  };
  const FRAME = `document.querySelector('.dm-tile[data-dm-tile="f1"] .dm-document:not([style*="visibility: hidden"])')?.contentDocument`;
  const inFrame = (selector, expression) =>
    `(() => { const d = ${FRAME}; const e = d && d.querySelector(${JSON.stringify(selector)}); if (!e) return undefined; const style = d.defaultView.getComputedStyle(e); const rect = e.getBoundingClientRect(); return ${expression}; })()`;
  const framePoint = (selector, fx = 0.5, fy = 0.5) =>
    `(() => { const d = ${FRAME}; const e = d && d.querySelector(${JSON.stringify(selector)}); const body = document.querySelector('.dm-tile[data-dm-tile="f1"] .dm-body'); if (!e || !body) return undefined; const o = body.getBoundingClientRect(); const z = o.width / body.offsetWidth; const r = e.getBoundingClientRect(); return { x: Math.round(o.left + (r.left + r.width * ${fx}) * z), y: Math.round(o.top + (r.top + r.height * ${fy}) * z), zoom: z }; })()`;
  const liveRootNow = () => {
    const fence = designFenceState();
    return fence.kind === 'on' ? path.join(fence.sandboxRoot, 'site', path.basename(project)) : '';
  };
  const pageNow = () => fs.readFileSync(path.join(liveRootNow(), 'src/pages/index.astro'), 'utf8');
  const cardLine = () =>
    pageNow()
      .split('\n')
      .find((line) => line.includes('id="card"')) ?? '';

  await reopened();
  // The owner's shape of card, with a public picture, an imported one and a background.
  const pixels = Buffer.alloc(400 * 200 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels.set([200, 40 + (index % 160), 220, 255], index);
  }
  const png = nativeImage.createFromBitmap(pixels, { width: 400, height: 200 }).toPNG();
  fs.mkdirSync(path.join(project, 'public'), { recursive: true });
  fs.writeFileSync(path.join(project, 'public/owner-picture.png'), png);
  fs.writeFileSync(
    path.join(project, 'public/owner-mark.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="red"/></svg>',
  );
  fs.mkdirSync(path.join(project, 'public/work/dist'), { recursive: true });
  fs.writeFileSync(path.join(project, 'public/work/dist/owner-picture.png'), png);
  fs.mkdirSync(path.join(project, 'src/assets'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src/assets/owner-asset.png'), png);
  const index = path.join(project, 'src/pages/index.astro');
  fs.writeFileSync(
    index,
    fs
      .readFileSync(index, 'utf8')
      .replace('---\n', '---\nimport { Image } from "astro:assets";\nimport ownerAsset from "@/assets/owner-asset.png";\n')
      .replace(/(<Layout[^>]*>\n)/, `$1${CARD}`),
  );
  await waitFor({
    what: 'the card live',
    read: () => driver.canvasEvaluate(`!!document.querySelector('#card') && document.querySelector('#public-picture').naturalWidth`).catch(() => false),
    until: (width) => width > 0,
    pollIntervalMs: 250,
    pollCountMax: 240,
  });
  await driver.settle();
  report.notes.liveImages = await driver.canvasEvaluate(
    `JSON.stringify([...document.querySelectorAll('#card img')].map((i) => [i.getAttribute('src').slice(0, 60), i.naturalWidth]))`,
  );

  const before = fs.readFileSync(index, 'utf8');
  const stylesheets = () =>
    fs
      .readdirSync(path.join(project, 'src/styles'))
      .map((name) => fs.readFileSync(path.join(project, 'src/styles', name), 'utf8'))
      .join('');
  const stylesBefore = stylesheets();

  await driver.evaluate(
    `document.querySelector('.ai-mode-button') ? 0 : ([...document.querySelectorAll('.rail button')].find((b) => /AI/.test(b.getAttribute('aria-label') || ''))?.click(), 0)`,
  );
  await press(
    'the Design mode button',
    `[...document.querySelectorAll('.ai-header .ai-mode-button')].find((b) => /design mode/i.test(b.getAttribute('aria-label') || ''))`,
  );
  await until(
    'the canvas on the copy',
    `!!document.querySelector('.dm-bar') && !document.querySelector('.dm-status') && !!document.querySelector('.dm-plane')`,
    Boolean,
    OPEN_WAIT_MS_MAX,
  );
  await reopened();
  await until('the card in the frame', inFrame('#card', 'rect.height'), (height) => height > 100, OPEN_WAIT_MS_MAX);
  await driver.sleep(2_500);

  const picturesOf = (frameId) =>
    `(() => { const d = document.querySelector('.dm-tile[data-dm-tile="${frameId}"] .dm-document:not([style*="visibility: hidden"])')?.contentDocument; if (!d || !d.querySelector('#card')) return undefined; const all = [...d.querySelectorAll('img')]; return all.every((i) => i.complete) ? JSON.stringify({ images: all.map((i) => ({ id: i.id || i.src.slice(0, 40), width: i.naturalWidth, data: i.src.startsWith('data:') })), poster: d.querySelector('#poster-video').poster.startsWith('data:'), background: d.defaultView.getComputedStyle(d.querySelector('#background-picture')).backgroundImage.startsWith('url("data:') }) : undefined; })()`;
  const allDrawn = (text) => {
    const found = JSON.parse(text);
    return found.images.length >= 7 && found.images.every((image) => image.width > 0) && found.poster && found.background;
  };

  await run('the pictures show in the frame, in a duplicate too', async () => {
    const first = await until('the pictures', picturesOf('f1'));
    report.notes.frameImages = first;
    check('every picture is drawn in the frame', allDrawn(first), first);
    await shot('01-card');
    await press('the frame name', `document.querySelector('.dm-title-name')`);
    await driver.settle();
    await driver.key('d', { modifiers: ['meta'] });
    const copy = await until('the copy\u2019s pictures', picturesOf('f2'));
    check('and in its duplicate', allDrawn(copy), copy);
    await driver.sleep(1_500);
    await driver.key('Delete');
    await until('one frame again', `document.querySelectorAll('.dm-tile').length === 1`);
  });

  const fit = async () => {
    await driver.evaluate(`document.activeElement?.blur(); 0`);
    await driver.key('1', { modifiers: ['shift'] });
    await driver.settle();
  };
  /** Pans until the point of an element is well inside the canvas, then presses it. */
  const select = async (selector, fx, fy) => {
    await fit();
    await until(
      `${selector} on screen`,
      `(() => { const at = ${framePoint(selector, fx, fy)}; const plane = document.querySelector('.dm-plane'); if (!at || !plane) return false; const box = plane.getBoundingClientRect(); if (at.y > box.top + 60 && at.y < box.bottom - 220 && at.x > box.left + 20 && at.x < box.right - 20) return true; plane.dispatchEvent(new WheelEvent('wheel', { deltaX: at.x - (box.left + box.width / 2), deltaY: at.y - (box.top + box.height / 2), bubbles: true, cancelable: true })); return false; })()`,
    );
    await driver.settle();
    const at = await until(`${selector} in the frame`, framePoint(selector, fx, fy));
    await driver.pointerPress(at);
    await until('the outline', `!!document.querySelector('[data-dm-outline="picked"]')`);
    await driver.settle();
  };
  const handle = (name) => `document.querySelector('[data-dm-handle="${name}"]')`;
  /** Pans the canvas until the handle itself is what a press on it would hit. */
  const reach = (name) =>
    until(
      `the ${name} handle in reach`,
      `(() => { const h = ${handle(name)}; if (!h) return false; const r = h.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2; const plane = document.querySelector('.dm-plane'); const box = plane.getBoundingClientRect(); if (y < box.bottom - 220 && y > box.top + 60 && x > box.left + 20 && x < box.right - 20 && document.elementFromPoint(x, y) === h) return true; plane.dispatchEvent(new WheelEvent('wheel', { deltaX: x - (box.left + box.width / 2), deltaY: y - (box.top + box.height / 2), bubbles: true, cancelable: true })); return false; })()`,
    );

  await run('hovering a value in the Style panel previews in the frame and leaves nothing behind', async () => {
    await driver.evaluate(`document.querySelector('.dm-plane').focus(); 0`);
    await driver.key('1', { modifiers: ['shift'] });
    await until(
      'no notification over the canvas',
      `![...document.querySelectorAll('.toast-stack [role="status"], .toast-stack [role="alert"]')].some((t) => t.getBoundingClientRect().height > 0)`,
      Boolean,
      20_000,
    );
    await select('#soak-heading-one', 0.1, 0.25);
    await until('the heading picked', `(document.querySelector('.embed-editor_root')?.textContent || '').includes('text-style-h1')`);
    await driver.settle();
    const file = pageNow();
    const size = () => driver.evaluate(inFrame('#soak-heading-one', 'style.fontSize + "|" + style.fontWeight'));
    const rest = await size();
    // The Size field's variable chip opens the variable chooser.
    const chip = `(() => { const field = document.querySelector('.embed-editor_root [data-prop="font-size"]'); const box = field && (field.closest('.embed-editor_varconnect') || field.parentElement); return box && ([...box.querySelectorAll('button, [role="button"]')].find((b) => /h1/.test(b.textContent || '')) || box.querySelector('button')); })()`;
    const place = await driver.panelPoint(chip);
    if (place === undefined) {
      report.notes.sizeField = await driver.evaluate(`[...document.querySelectorAll('.embed-editor_root [data-prop]')].map((e) => e.dataset.prop).join(',')`);
      throw new Error('the Size field chip was not found');
    }
    await driver.pointerPress(place);
    await driver.sleep(800);
    report.notes.chooser = await driver.evaluate(
      `JSON.stringify([...document.querySelectorAll('button, [role="option"], [role="menuitem"]')].filter((b) => /(^|[^a-z])h3([^0-9]|$)/i.test(b.textContent || '')).map((b) => [b.className, b.textContent.trim().slice(0, 30)]).slice(0, 6))`,
    );
    const option = `[...document.querySelectorAll('button, [role="option"], [role="menuitem"]')].find((b) => b.getBoundingClientRect().width > 0 && /(^|[^a-z0-9-])h3([^0-9]|$)/i.test((b.textContent || '').trim()))`;
    const over = await until('the h3 value', centre(option));
    let nudge = 0;
    const hovered = await waitFor({
      what: 'the preview in the frame',
      read: () => {
        // A hidden window delivers pointer moves on its own frames, so the pointer keeps moving on the value.
        nudge = 1 - nudge;
        move({ x: over.x + nudge * 3, y: over.y });
        return size();
      },
      until: (value) => value !== rest,
      pollIntervalMs: 200,
      pollCountMax: 30,
    }).catch(() => undefined);
    const liveHovered = await driver.canvasEvaluate(`getComputedStyle(document.querySelector('#soak-heading-one')).fontSize`);
    check('hovering a variable previews it in the frame', hovered !== undefined, `frame ${rest}, live canvas ${liveHovered}, chooser ${report.notes.chooser}`);
    await shot('03-variable-hover');
    await driver.key('Escape');
    await until('the frame restored', inFrame('#soak-heading-one', 'style.fontSize + "|" + style.fontWeight'), (value) => value === rest, 8_000).catch(
      () => undefined,
    );
    check('leaving the chooser puts the frame back exactly', (await size()) === rest, await size());
    await driver.sleep(1_500);
    check('and nothing was saved', pageNow() === file);
  });

  await run('a flex-grow card gets shorter by its bottom handle, and only what takes effect is written', async () => {
    await select('#card', 0.98, 0.01);
    await until('the card picked', `(document.querySelector('.embed-editor_root')?.textContent || '').includes('owner-card')`);
    const start = await driver.evaluate(inFrame('#card', 'rect.height'));
    const zoom = (await driver.evaluate(framePoint('#card'))).zoom;
    // The handle may be below the window: the canvas is panned until it is on screen.
    await reach('s');
    await driver.settle();
    const at = await until('the handle', centre(handle('s')));
    console.log(
      'NOTE handle',
      JSON.stringify(at),
      await driver.evaluate(
        `(() => { const e = document.elementFromPoint(${at.x}, ${at.y}); const p = document.querySelector('.dm-plane').getBoundingClientRect(); return JSON.stringify({ hit: e && String(e.className), handle: e && e.dataset.dmHandle, plane: [p.left, p.top, p.right, p.bottom], inner: [innerWidth, innerHeight], picked: document.querySelector('.embed-editor_root')?.textContent.slice(0, 60) }); })()`,
      ),
    );
    const dragBy = -Math.round(150 * zoom);
    driver.contents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 6; step += 1) {
      move({ x: at.x, y: at.y + Math.round((dragBy * step) / 6) }, 'held');
      await driver.sleep(40);
    }
    // A hidden window delivers pointer moves on its own frames: the last one is repeated until the frame has it.
    await waitFor({
      what: 'the frame to follow the pointer',
      read: async () => {
        move({ x: at.x, y: at.y + dragBy }, 'held');
        return driver.evaluate(inFrame('#card', 'rect.height'));
      },
      until: (height) => Math.abs(start - height - 150) < 8,
      pollIntervalMs: POLL_MS,
      pollCountMax: 60,
    }).catch((error) => console.log('NOTE follow', String(error.message).slice(0, 200)));
    const during = await until('the size readout', `document.querySelector('.dm-size')?.textContent`);
    const heldHeight = await driver.evaluate(inFrame('#card', 'rect.height'));
    check('the card is drawn shorter while it is held', heldHeight < start - 100, `${start} -> ${heldHeight}`);
    check('the readout matches what is drawn', Number(/× (\d+)/.exec(during)?.[1]) === Math.round(heldHeight), `${during} vs ${heldHeight}`);
    await shot('02-resizing');
    driver.contents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y + dragBy, button: 'left', clickCount: 1 });
    await waitFor({ what: 'the height written', read: cardLine, until: (line) => /height: [\d.]+rem/.test(line), pollIntervalMs: POLL_MS, pollCountMax: 150 });
    await driver.sleep(2_500);
    const after = await driver.evaluate(inFrame('#card', 'rect.height'));
    const live = await driver.canvasEvaluate(`document.querySelector('#card').getBoundingClientRect().height`);
    report.notes.shrink = { start, heldHeight, after, live, line: cardLine().trim() };
    check(
      'the card stays shorter once saved, in the frame and the live page',
      Math.abs(after - heldHeight) < 2 && live < start - 100,
      JSON.stringify(report.notes.shrink),
    );
    check('only the card’s own inline style changed', stylesheets() === stylesBefore && /flex-grow: 0|flex-basis: auto/.test(cardLine()), cardLine());
  });

  await run('content that cannot be smaller stops the handle, and the width and side handle work', async () => {
    await driver.settle();
    const at = await until('the bottom handle', centre(handle('s')));
    await driver.drag(at, { x: at.x, y: 80 }, { steps: 10, label: 'as small as it goes' });
    await driver.sleep(2_500);
    const smallest = await driver.evaluate(inFrame('#card', '({ height: rect.height, content: e.scrollHeight })'));
    const written = Number(/(?:^|[ ;"])height: ([\d.]+)rem/.exec(cardLine())?.[1]) * 16;
    check('the height written is the height drawn', Math.abs(written - smallest.height) < 2, `${written} vs ${smallest.height} ${cardLine()}`);
    const width = await driver.evaluate(inFrame('#card', 'rect.width'));
    await reach('e');
    await driver.settle();
    const side = await until('the side handle', centre(handle('e')));
    const zoom = (await driver.evaluate(framePoint('#card'))).zoom;
    await driver.drag(side, { x: side.x - Math.round(200 * zoom), y: side.y }, { steps: 8, label: 'narrower' });
    await driver.sleep(2_500);
    const narrower = await driver.evaluate(inFrame('#card', 'rect.width'));
    check('the right handle makes it narrower', Math.abs(width - narrower - 200) < 6, `${width} -> ${narrower} ${cardLine()}`);
  });

  await run('the bar is one solid piece whose controls stay opaque under the pointer', async () => {
    const opaque = `(() => { const alpha = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (m) { const p = m[1].split(',').map(Number); return p.length > 3 ? p[3] : 1; } const s = /\\/\\s*([\\d.]+)\\)/.exec(c); return s ? Number(s[1]) : (c === 'transparent' ? 0 : 1); }; return JSON.stringify([...document.querySelectorAll('.dm-shell, .dm-shell button')].map((e) => ({ name: e.className, bg: getComputedStyle(e).backgroundColor, opaque: alpha(getComputedStyle(e).backgroundColor) === 1 }))); })()`;
    const states = [];
    for (const selector of ['.dm-start-over', '.dm-send', '.dm-exit']) {
      move(await until(selector, centre(`document.querySelector('${selector}')`)));
      await driver.sleep(300);
      states.push(...JSON.parse(await driver.evaluate(opaque)));
      await shot('04-hover' + selector.replace('.', '-'));
    }
    report.notes.bar = states.slice(0, 4);
    check(
      'every fill in the bar is opaque, hovered or not',
      states.every((state) => state.opaque),
      JSON.stringify(states.filter((state) => !state.opaque)),
    );
    const blue = states.filter((state) => state.name === 'dm-send').map((state) => state.bg);
    check('Send to AI stays its blue', new Set(blue).size === 1, blue.join(' / '));
    check(
      'one bar, with no zoom readout',
      await driver.evaluate(`document.querySelectorAll('.dm-shell').length === 1 && !/%/.test(document.querySelector('.dm-shell').textContent)`),
    );
    await press('start over', `document.querySelector('.dm-start-over')`);
    await until(
      'the question',
      `!![...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')].find((d) => /start over/i.test(d.textContent))`,
    );
    check('start over asks first', true);
    await shot('05-confirm');
    await driver.key('Escape');
    await driver.settle();
    check('cancelling keeps the frames', (await driver.evaluate(`document.querySelectorAll('.dm-tile').length`)) === 1);
    const world = `document.querySelector('.dm-world').style.transform`;
    const seen = [await driver.evaluate(world)];
    await driver.evaluate(`document.activeElement?.blur(); 0`);
    for (const [key, modifiers] of [
      ['=', ['meta']],
      ['-', ['meta']],
      ['-', ['meta']],
      ['0', ['meta']],
      ['1', ['shift']],
    ]) {
      await driver.key(key, { modifiers });
      await driver.sleep(300);
      seen.push(await driver.evaluate(world));
    }
    check('the zoom keys zoom the canvas', seen.every((value, i) => i === 0 || value !== seen[i - 1]) && /scale\(1\)/.test(seen[4]), seen.join(' ; '));
  });

  await run('the toolbar keeps only the pointer button, which shows the frame live', async () => {
    const shown = `JSON.stringify({ size: [...document.querySelectorAll('.preview-size-controls, .preview-toolbar-more')].filter((e) => e.getBoundingClientRect().width > 0).length, groups: [...document.querySelectorAll('.preview-toolbar .device-btns, .device-btns')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.className), buttons: [...document.querySelectorAll('.device-btns button')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getAttribute('aria-label')) })`;
    const toolbar = JSON.parse(await driver.evaluate(shown));
    check(
      'only the pointer button is left',
      toolbar.size === 0 && toolbar.buttons.length === 1 && /interact/i.test(toolbar.buttons[0]),
      JSON.stringify(toolbar),
    );
    await shot('06-toolbar');
    const device = await driver.evaluate(`document.querySelector('.preview-frame-wrap iframe[aria-hidden="false"]').getBoundingClientRect().width`);
    await driver.evaluate(`document.activeElement?.blur(); 0`);
    await driver.key('4');
    await driver.sleep(800);
    check(
      'a breakpoint key changes nothing hidden',
      (await driver.evaluate(`document.querySelector('.preview-frame-wrap iframe[aria-hidden="false"]').getBoundingClientRect().width`)) === device,
    );
    await press('the pointer button', `[...document.querySelectorAll('.device-btns.is-interaction button')][0]`);
    await until('the live preview', `getComputedStyle(document.querySelector('.dm-canvas')).display === 'none'`);
    check('with the pointer button on, the frame runs live', await driver.evaluate(`!!document.querySelector('.dm-bar .dm-exit')`));
    await shot('07-interact');
    await press('the pointer button again', `[...document.querySelectorAll('.device-btns.is-interaction button')][0]`);
    await until('the canvas back', `getComputedStyle(document.querySelector('.dm-canvas')).display !== 'none'`);
    check('and the canvas comes back', true);
  });

  await run('nothing offers or accepts a write to project settings', async () => {
    await driver.evaluate(
      `document.querySelector('.structure-node') ? 0 : ([...document.querySelectorAll('.rail button')].find((b) => /navigator/i.test(b.getAttribute('aria-label') || ''))?.click(), 0)`,
    );
    await driver.sleep(800);
    await rightPress('a component row', `[...document.querySelectorAll('.structure-node')].find((n) => /Heading|Section/.test(n.textContent))`);
    const menu = await until('the element menu', `[...document.querySelectorAll('[role="menu"], .ctx-menu')].map((m) => m.textContent).join(' ') || undefined`);
    check('no Set component defaults', !/component defaults/i.test(menu), menu);
    await shot('08-menu');
    await driver.key('Escape');
    for (const call of [`window.avb.writeProjectMetadata({ projectPath: ${JSON.stringify(liveRootNow())}, kind: 'components', text: '{}' })`]) {
      const said = await driver.evaluate(`${call}.then(() => 'ran', (error) => String(error && error.message))`);
      check('main refuses a project settings write', said !== 'ran', said);
    }
  });

  await run('close stays reachable in a narrow window', async () => {
    const [width, height] = window.getContentSize();
    window.setContentSize(900, 700);
    await driver.sleep(1_200);
    const exit = await driver.evaluate(
      `(() => { const e = document.querySelector('.dm-bar .dm-exit'); const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.left >= 0 && r.right <= innerWidth && !!hit && e.contains(hit); })()`,
    );
    check('close is whole and uncovered at 900 pixels', exit);
    await shot('09-narrow');
    window.setContentSize(width, height);
    await driver.sleep(800);
  });

  await run('Send to AI drafts one sentence and a picture of the whole page', async () => {
    await driver.evaluate(`document.activeElement?.blur(); 0`);
    await driver.key('1', { modifiers: ['shift'] });
    await driver.settle();
    const page = await driver.evaluate(
      `(() => { const b = document.querySelector('.dm-tile .dm-body'); return { width: b.offsetWidth, height: b.offsetHeight }; })()`,
    );
    const { ipcMain } = require('electron');
    const captured = [];
    ipcMain.removeHandler('ai:prompt');
    ipcMain.handle('ai:prompt', (_event, input) => {
      captured.push(input);
      return { ok: false, error: { code: 'invalid', message: 'captured by the check' } };
    });
    await press('Send to AI', `document.querySelector('.dm-bar .dm-send')`);
    await until(
      'the project again',
      `!document.querySelector('.dm-bar') && !!document.querySelector('.embed-editor_root, .ai-composer')`,
      Boolean,
      OPEN_WAIT_MS_MAX,
    );
    await reopened();
    await until('the picture in the draft', `document.querySelectorAll('.ai-composer img').length`, (count) => count >= 1);
    await driver.sleep(1_500);
    check('nothing was sent by itself', captured.length === 0);
    await press('send', `[...document.querySelectorAll('.ai-composer button')].find((x) => /^send/i.test(x.getAttribute('aria-label') || '') && !x.disabled)`);
    await waitFor({ what: 'the prompt', read: () => captured.length, until: (count) => count === 1, pollIntervalMs: 100, pollCountMax: 150 });
    const input = captured[0];
    fs.writeFileSync(
      path.join(options.outDirectory, 'payload.json'),
      JSON.stringify({ ...input, attachments: input.attachments.map((part) => ({ ...part, data: `${part.data.length} base64 chars` })) }, null, 2),
    );
    const sizes = input.attachments.map((attachment, i) => {
      const image = nativeImage.createFromBuffer(Buffer.from(attachment.data, 'base64'));
      fs.writeFileSync(path.join(options.outDirectory, `payload-${i + 1}.png`), image.toPNG());
      return image.getSize();
    });
    report.notes.payload = { text: input.text, sizes, page, keys: Object.keys(input), attachmentKeys: input.attachments.map((part) => Object.keys(part)) };
    console.log('PAYLOAD', JSON.stringify(report.notes.payload));
    const ratio = sizes.reduce((total, size) => total + size.height / size.width, 0);
    check('the pictures hold the whole page', Math.abs(ratio - page.height / page.width) / (page.height / page.width) < 0.03, JSON.stringify({ ratio, page }));
    check('the words are one sentence naming the page', /^Rebuild the \/ page to look like the attached pictures?\b[^\n]*\.$/.test(input.text), input.text);
    check(
      'no source, styles or positions go with it',
      !/```|translate|height:|rem\b|style=|data-avb|data-dm/.test(
        JSON.stringify({ ...input, projectPath: '', attachments: input.attachments.map((part) => ({ ...part, data: '' })) }),
      ),
    );
    check('the project is as it was', fs.readFileSync(index, 'utf8') === before && stylesheets() === stylesBefore);
  });

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
