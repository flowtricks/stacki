// Goal: the component canvas's frames are transparent and its surface is the page's own. With no canvas Background
// setting the surface shows what the site's page shows (its root's background, else its body's), a theme class on the
// canvas root re-themes it, frames show the surface through their corners, the project's CSS cannot paint, pad,
// border or caption the scaffolding, captions are never cut off, and the canvas root's outline is the whole pane at
// every hover, selection, pan and zoom.
//
// Method: a copy of the Studio fixture's Lumos site (its :root and [class*="theme-"] paint background-color) in a
// temporary directory, never the owner's projects, with a hostile stylesheet added: rules aimed at body's children, at
// [data-frame], at ::before and at body, all !important. The built app is launched by Playwright with a mock keychain, a
// temporary user data directory and hidden windows (test/helpers/hiddenFlowPreload.js; HOME is left as it is). Pixels
// are read from the window's own capture (capturePage) at each frame's corner and at empty canvas, and compared. Outside
// the gate (it starts the dev server): `node test/integration/componentCanvasSurfaceFlow.js <screenshot directory>`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../helpers/sources.js');
const { waitFor: waitForState } = require('../helpers/waitFor.js');
const { _electron: electron } = require(repoPath('studio/node_modules/playwright'));

const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'stacki-component-canvas-surface'));
const SITE = repoPath('studio/test/fixtures/site');
const WAIT_MS = 60_000;
const POLLS_MAX = 600;
// Colour channels that differ by no more than this are the same paint (antialiasing, colour management).
const CHANNEL_TOLERANCE = 6;

// Rules a project might well have, aimed at whatever the canvas puts around a component.
const HOSTILE_CSS = `
/* Hostile to the canvas scaffolding (componentCanvasSurfaceFlow.js). */
body > * { background: rgb(255, 0, 0) !important; padding: 24px !important; border: 4px solid rgb(0, 0, 255) !important; margin: 12px !important; }
[data-frame], [data-label] { background: rgb(255, 0, 0) !important; outline: 6px solid rgb(0, 255, 0) !important; }
:where(*)::before { content: "HOSTILE" !important; font-size: 40px !important; }
body { padding: 40px !important; }
`;

function writeFixture(project) {
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(SITE, 'src'), path.join(project, 'src'), { recursive: true });
  fs.cpSync(path.join(SITE, 'public'), path.join(project, 'public'), { recursive: true });
  for (const file of ['package.json', 'astro.config.mjs', 'tsconfig.json']) {
    fs.copyFileSync(path.join(SITE, file), path.join(project, file));
  }
  const cloned = childProcess.spawnSync('cp', ['-c', '-R', path.join(SITE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'inherit' });
  assert.equal(cloned.status, 0, 'the fixture packages were cloned');
  fs.appendFileSync(path.join(project, 'src/styles/base.css'), HOSTILE_CSS);
}

// Deleted, not emptied: Electron runs as plain Node when the name is set at all.
function electronEnvironment() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-canvas-surface-')));
  const project = path.join(root, 'site');
  writeFixture(project);
  const app = await electron.launch({
    args: [
      '-r',
      repoPath('test/helpers/hiddenFlowPreload.js'),
      repoPath('dist/electron/main.js'),
      '--use-mock-keychain',
      `--user-data-dir=${path.join(root, 'user-data')}`,
      project,
    ],
    env: electronEnvironment(),
  });
  const results = {};
  const shot = async (name) => {
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      return target === undefined ? '' : (await target.capturePage()).toPNG().toString('base64');
    });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(png, 'base64'));
  };
  // One pixel of the window, as the person sees it: [r, g, b].
  const pixel = (point) =>
    app.evaluate(async ({ BrowserWindow }, at) => {
      const target = BrowserWindow.getAllWindows()[0];
      const image = await target.capturePage({ x: Math.round(at.x), y: Math.round(at.y), width: 4, height: 4 });
      const bitmap = image.toBitmap();
      // The bitmap is BGRA, at the display's scale; its first pixel is the point asked for.
      return [bitmap[2], bitmap[1], bitmap[0]];
    }, point);
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
    const canvas = window.frameLocator('.preview-frame-wrap iframe').first();
    await canvas.locator('body').waitFor({ timeout: WAIT_MS });
    await window.locator('[data-rail-id="components"]').click();
    await window.locator('button[aria-label="Options for Button"]').first().click({ force: true });
    await window.getByRole('menuitem', { name: 'Open in canvas' }).click();
    await canvas.locator('stacki-frame').nth(4).waitFor({ timeout: WAIT_MS });
    // Frame settings out of the way of the frames, so every corner is canvas.
    const close = window.getByRole('button', { name: 'Minimize frame settings' });
    if ((await close.count()) > 0) {
      await close.click();
    }
    (await window.waitForTimeout) === undefined ? undefined : undefined;
    results.plain = await surfaceReport(window, canvas, pixel);
    await shot('01-no-class.png');

    // A theme class on the canvas root: the surface re-themes, the frames stay clear.
    if ((await window.locator('[data-node-id]').count()) === 0) {
      await window.locator('[data-rail-id="navigator"]').click();
    }
    await window.locator('[data-node-id]', { hasText: 'html' }).first().click();
    const settingsGroup = window.locator('.props-group-head', { hasText: 'Settings' }).first();
    if ((await settingsGroup.getAttribute('aria-expanded')) !== 'true') {
      await settingsGroup.click();
    }
    await window.locator('.props-field', { hasText: 'class' }).first().locator('input, [contenteditable="true"]').first().click();
    await window.keyboard.type('theme-brand');
    await window.keyboard.press('Enter');
    await window.keyboard.press('Tab');
    await waitFor(async () => (await canvas.locator('html.theme-brand').count()) === 1, 'the canvas root has the theme class');
    await waitFor(async () => {
      const report = await surfaceReport(window, canvas, pixel);
      return JSON.stringify(report.surface) !== JSON.stringify(results.plain.surface);
    }, 'the surface re-themes');
    results.brand = await surfaceReport(window, canvas, pixel);
    await shot('02-theme-brand.png');

    // The root's outline is the whole pane: selected, after a pan, and after a zoom.
    results.outline = [];
    for (const step of ['selected', 'panned', 'zoomed']) {
      if (step === 'panned') {
        const box = await window.locator('.preview-frame-wrap iframe').boundingBox();
        await window.mouse.move(box.x + 40, box.y + box.height - 40);
        await window.mouse.wheel(120, 80);
      }
      if (step === 'zoomed') {
        await window.getByRole('button', { name: 'Zoom in' }).click();
      }
      results.outline.push({ step, ...(await rootOutline(window)) });
    }
    await shot('03-root-outline.png');
  } catch (error) {
    results.error = String(error && error.stack ? error.stack : error);
    await shot('error.png').catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
  }
  const failures = [
    ...(results.error === undefined ? [] : [results.error]),
    ...[results.plain, results.brand].filter(Boolean).flatMap((report) => report.problems),
    ...(results.outline ?? []).filter((outline) => !outline.whole).map((outline) => `the root outline is not the pane when ${outline.step}`),
  ];
  console.log(`RESULT ${JSON.stringify(results, undefined, 2)}`);
  console.log(`Screenshots: ${SHOTS}`);
  console.log(failures.length === 0 ? 'PASS frames are clear, the surface is the page’s, captions are whole' : `FAIL\n${failures.join('\n')}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
})();

// The surface's colour at an empty point of the canvas, and each frame: its top-left corner pixel (inside the frame
// box, outside a rounded component), its box, and whether its caption fits it and is the frame's own text.
async function surfaceReport(window, canvas, pixel) {
  const outer = await window.evaluate(() => {
    const frame = document.querySelector('.preview-frame-wrap iframe');
    const box = frame.getBoundingClientRect();
    return { left: box.left, top: box.top, scale: box.width / frame.offsetWidth, height: box.height };
  });
  const toWindow = (x, y) => ({ x: outer.left + x * outer.scale, y: outer.top + y * outer.scale });
  const surface = await pixel(toWindow(6, outer.height / outer.scale - 6));
  const debug = await canvas.locator('html').evaluate((html) => ({
    ready: html.hasAttribute('data-stacki-ready'),
    sheets: [...document.querySelectorAll('style')].map((style) => (style.textContent ?? '').slice(0, 80)),
    rules: [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules].filter((rule) => String(rule.cssText).includes('stacki-frame[data-frame]')).map((rule) => rule.cssText.slice(0, 120));
      } catch {
        return [];
      }
    }),
  }));
  const frames = await canvas.locator('stacki-frame').evaluateAll((all) =>
    all.map((frame) => {
      const rect = frame.getBoundingClientRect();
      const before = getComputedStyle(frame, '::before');
      const probe = document.createElement('canvas').getContext('2d');
      probe.font = `${before.fontWeight} ${before.fontSize} ${before.fontFamily}`;
      const label = frame.getAttribute('data-label') ?? '';
      return {
        label,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        captionWidth: probe.measureText(label).width,
        captionText: before.content,
        captionFont: before.fontSize,
        padding: getComputedStyle(frame).paddingTop,
        border: getComputedStyle(frame).borderTopWidth,
        background: getComputedStyle(frame).backgroundColor,
        // The part of the frame its component leaves bare: where the frame is wider than the component (a caption wider
        // than a small button), its top-right corner shows only what is behind the frame.
        bare: frame.firstElementChild === null ? 0 : rect.right - frame.firstElementChild.getBoundingClientRect().right,
      };
    }),
  );
  const problems = [];
  const close = (left, right) => left.every((channel, index) => Math.abs(channel - right[index]) <= CHANNEL_TOLERANCE);
  for (const frame of frames) {
    if (frame.background !== 'rgba(0, 0, 0, 0)') {
      problems.push(`${frame.label}: the frame paints ${frame.background}`);
    }
    if (frame.bare > 4) {
      const corner = await pixel(toWindow(frame.left + frame.width - 2, frame.top + 2));
      frame.corner = corner;
      if (!close(corner, surface)) {
        problems.push(`${frame.label}: its bare corner ${corner} is not the surface ${surface}`);
      }
    }
    if (frame.captionWidth > frame.width + 1) {
      problems.push(`${frame.label}: the caption (${Math.round(frame.captionWidth)}px) is wider than its frame (${Math.round(frame.width)}px)`);
    }
    if (frame.captionText !== JSON.stringify(frame.label) || frame.captionFont !== '12px') {
      problems.push(`${frame.label}: the project's CSS changed the caption (${frame.captionText}, ${frame.captionFont})`);
    }
    if (frame.padding !== '0px' || frame.border !== '0px') {
      problems.push(`${frame.label}: the project's CSS padded or bordered the frame`);
    }
  }
  return { surface, frames, problems, debug };
}

// The selected root's outline against the pane it is drawn over.
async function rootOutline(window) {
  return window.evaluate(() => {
    const outline = document.querySelector('.node-outline.sel');
    const pane = document.querySelector('.preview-frame-wrap iframe');
    if (outline === null || pane === null) {
      return { whole: false, outline: undefined };
    }
    const box = outline.getBoundingClientRect();
    const view = pane.getBoundingClientRect();
    const whole =
      Math.abs(box.left - view.left) <= 2 &&
      Math.abs(box.top - view.top) <= 2 &&
      Math.abs(box.width - view.width) <= 3 &&
      Math.abs(box.height - view.height) <= 3;
    return { whole, outline: [box.left, box.top, box.width, box.height].map(Math.round), pane: [view.left, view.top, view.width, view.height].map(Math.round) };
  });
}

async function waitFor(check, what) {
  await waitForState({ what, read: check, until: (value) => value === true, pollCountMax: POLLS_MAX });
}
