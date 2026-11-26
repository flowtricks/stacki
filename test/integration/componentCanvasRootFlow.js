// Goal: the component canvas itself is a selectable element, its page's <html> root. A click between frames selects it
// as `html` (the Navigator's top row, the breadcrumb, the normal outline), never the canvas's own wrappers; its Settings
// panel has a class field whose classes go on the canvas's <html>, so a theme class (theme-dark) re-themes every
// frame's background and text; Frame settings shows the canvas's own settings while it is selected; and all of it is
// written to .stacki/component-canvas.json, at this component or the project, never to the project's CSS or layouts.
//
// Method: a copy of the Studio fixture's Lumos site (its base.css defines .theme-dark on <html>) in a temporary
// directory, never the owner's projects; the built app launched by Playwright with a mock keychain, a temporary user
// data directory and hidden windows (test/helpers/hiddenFlowPreload.js; HOME is left as it is), driven with real mouse
// clicks and keys. Files are read from disk to check what was written. Outside the gate (it starts the dev server):
// `node test/integration/componentCanvasRootFlow.js <screenshot directory>`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../helpers/sources.js');
const { waitFor: waitForState } = require('../helpers/waitFor.js');
const { _electron: electron } = require(repoPath('studio/node_modules/playwright'));

const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'stacki-component-canvas-root'));
const SITE = repoPath('studio/test/fixtures/site');
const WAIT_MS = 60_000;
const POLLS_MAX = 600;
const BUTTON = 'src/components/Button.astro';

function writeFixture(project) {
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(SITE, 'src'), path.join(project, 'src'), { recursive: true });
  fs.cpSync(path.join(SITE, 'public'), path.join(project, 'public'), { recursive: true });
  for (const file of ['package.json', 'astro.config.mjs', 'tsconfig.json']) {
    fs.copyFileSync(path.join(SITE, file), path.join(project, file));
  }
  const cloned = childProcess.spawnSync('cp', ['-c', '-R', path.join(SITE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'inherit' });
  assert.equal(cloned.status, 0, 'the fixture packages were cloned');
}

// Every file under these folders, with its text: what the canvas must never write. Walked with a bounded queue.
const SNAPSHOT_FILES_MAX = 5_000;
function snapshotOf(project, folders) {
  const files = {};
  const pending = folders.map((folder) => path.join(project, folder));
  for (let visited = 0; visited < SNAPSHOT_FILES_MAX && pending.length > 0; visited++) {
    const directory = pending.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        files[path.relative(project, full)] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  assert.equal(pending.length, 0, 'the fixture fits the snapshot bound');
  return files;
}

// Deleted, not emptied: Electron runs as plain Node when the name is set at all.
function electronEnvironment() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-canvas-root-')));
  const project = path.join(root, 'site');
  writeFixture(project);
  const read = (file) => (fs.existsSync(path.join(project, file)) ? fs.readFileSync(path.join(project, file), 'utf8') : '');
  const sourcesBefore = snapshotOf(project, ['src']);
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
  try {
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
    const canvas = window.frameLocator('.preview-frame-wrap iframe').first();
    await canvas.locator('body').waitFor({ timeout: WAIT_MS });
    await window.locator('[data-rail-id="components"]').click();
    await window.locator('button[aria-label="Options for Button"]').first().click({ force: true });
    await window.getByRole('menuitem', { name: 'Open in canvas' }).click();
    await canvas.locator('stacki-frame').nth(4).waitFor({ timeout: WAIT_MS });
    // Opening a canvas shows the Navigator; the rail button toggles it, so it is pressed only when it is not showing.
    if ((await window.locator('[data-node-id]').count()) === 0) {
      await window.locator('[data-rail-id="navigator"]').click();
    }
    await waitFor(async () => (await window.locator('[data-node-id]').count()) > 0, 'the Navigator shows');
    results.navigator = await window.locator('[data-node-id]').allInnerTexts();
    // The link variant's text on the canvas, before any theme: read from the frame's own document.
    const linkColour = () =>
      canvas
        .locator('stacki-frame[data-frame="variant=link"] > *')
        .first()
        .evaluate((element) => getComputedStyle(element).color);
    results.linkColourBefore = await linkColour();

    results.markers = await canvas.locator('html').evaluate((html) => ({
      html: html.getAttribute('data-avb-p'),
      body: document.body.getAttribute('data-avb-p'),
      wrappers: document.querySelectorAll('stacki-canvas, stacki-canvas-world, stacki-canvas-row, stacki-frame-label, stacki-frame-body').length,
      bodyMarker: [...document.documentElement.childNodes]
        .filter((node) => node.nodeType === 8)
        .map((node) => node.data)
        .join(' '),
    }));
    // Every point of the canvas, hovered then pressed: what lights up is the root or a frame's instance, one outline at
    // a time, and no name the canvas generated (stacki-…) is ever shown. Then the Navigator's keys walk up from a frame.
    results.surfaced = await scanCanvas(window, canvas);
    results.keyboardSteps = await walkUp(window);
    assert.deepEqual(results.surfaced.names, [], 'no stacki- name surfaces anywhere on the canvas');
    assert.ok(results.surfaced.outlinesMax <= 1, 'one hover outline at a time');
    assert.ok(
      results.keyboardSteps.every((step) => !step.includes('stacki-')),
      'walking up never reaches a wrapper',
    );
    // Hover, then click, the space between frames: the canvas root.
    const space = await pointIn(window, canvas, 'html', { x: 0.15, y: 0.97 });
    await window.mouse.move(space.x, space.y);
    await waitFor(
      async () =>
        (
          await window
            .locator('.preview-frame-wrap')
            .innerText()
            .catch(() => '')
        ).includes('html'),
      'the hover names html',
    );
    results.hoverText = (await window.locator('.preview-frame-wrap').innerText()).slice(0, 200);
    await shot('01-hover-canvas.png');
    await window.mouse.click(space.x, space.y);
    await waitFor(async () => (await window.locator('.crumbs').innerText()).includes('html'), 'the breadcrumb names html');
    results.crumbs = await window.locator('.crumbs').innerText();
    results.selectedRow = await window
      .locator('[data-node-id].selected, .tree-row.selected')
      .first()
      .innerText()
      .catch(() => '');
    results.wrappersShown = await window.evaluate(() => document.body.innerText.includes('stacki-'));
    results.popupRoot = await window
      .locator('[data-testid="component-canvas-panel"]')
      .innerText()
      .catch(() => '');
    await shot('02-root-selected.png');

    // Its class field: theme-dark goes on the canvas's <html>, and every frame takes the theme.
    const settingsGroup = window.locator('.props-group-head', { hasText: 'Settings' }).first();
    if ((await settingsGroup.getAttribute('aria-expanded')) !== 'true') {
      await settingsGroup.click();
    }
    const classInput = window.locator('.props-field', { hasText: 'class' }).first().locator('input, [contenteditable="true"]').first();
    await classInput.click();
    await window.keyboard.type('theme-dark');
    await window.keyboard.press('Enter');
    await window.keyboard.press('Tab');
    await waitFor(async () => read('.stacki/component-canvas.json').includes('"theme-dark"'), 'the class is saved').catch(async (error) => {
      results.toasts = await window.locator('.toast, [role="alert"], [role="status"]').allInnerTexts();
      results.classFieldHtml = (await window.locator('.props-field', { hasText: 'class' }).first().innerHTML()).slice(0, 600);
      throw error;
    });
    await waitFor(
      async () =>
        canvas
          .locator('html.theme-dark')
          .count()
          .then((count) => count === 1),
      'the canvas html has the class',
    );
    await waitFor(async () => (await linkColour().catch(() => results.linkColourBefore)) !== results.linkColourBefore, 'the link frame re-themes');
    results.linkColourAfter = await linkColour();
    results.settingsAfterClass = JSON.parse(read('.stacki/component-canvas.json'));
    await shot('03-theme-dark.png');

    // Frame settings while the root is selected: the canvas's own background, at the scope chosen there.
    results.scope = await window.locator('button.dd-trigger[aria-label="Apply to"]').innerText();
    const background = window.locator('.component-canvas-color input');
    await background.fill('#202040');
    await background.press('Enter');
    await waitFor(async () => read('.stacki/component-canvas.json').includes('#202040'), 'the canvas background is saved');
    results.settingsAfterBackground = JSON.parse(read('.stacki/component-canvas.json'));
    await shot('04-root-background.png');

    // A frame again: Frame settings speak of it, and the Settings panel of its instance.
    await window.locator('[data-node-id]', { hasText: 'variant: main' }).first().click();
    await waitFor(async () => (await window.locator('[data-testid="component-canvas-panel"]').innerText()).includes('Width'), 'frame settings for the frame');
    await shot('05-frame-again.png');

    results.sourcesUntouched = JSON.stringify(snapshotOf(project, ['src'])) === JSON.stringify(sourcesBefore);
    results.buttonUntouched = read(BUTTON) === sourcesBefore[BUTTON];
  } catch (error) {
    results.error = String(error && error.stack ? error.stack : error);
    await shot('error.png').catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
  }
  console.log(`RESULT ${JSON.stringify(results, undefined, 2)}`);
  console.log(`Screenshots: ${SHOTS}`);
  process.exitCode = results.error === undefined ? 0 : 1;
})();

// A grid of points over the canvas: each hovered and, every few, pressed; every name shown (hover tags, the selection's
// tag, the breadcrumb, the Navigator's selected row) is collected, and any generated one is reported.
const SCAN_COLUMNS = 12;
const SCAN_ROWS = 9;
async function scanCanvas(window, canvas) {
  const names = new Set();
  let outlinesMax = 0;
  const shown = async () =>
    window.evaluate(() => [
      ...[...document.querySelectorAll('.node-outline-tag')].map((tag) => tag.textContent ?? ''),
      document.querySelector('.crumbs')?.textContent ?? '',
      ...[...document.querySelectorAll('[data-node-id]')].map((row) => row.textContent ?? ''),
    ]);
  for (let row = 0; row < SCAN_ROWS; row++) {
    for (let column = 0; column < SCAN_COLUMNS; column++) {
      const point = await pointIn(window, canvas, 'html', { x: (column + 0.5) / SCAN_COLUMNS, y: (row + 0.5) / SCAN_ROWS });
      await window.mouse.move(point.x, point.y);
      if ((row * SCAN_COLUMNS + column) % 7 === 0) {
        await window.mouse.click(point.x, point.y);
      }
      outlinesMax = Math.max(outlinesMax, await window.locator('.node-outline.hover').count());
      for (const text of await shown()) {
        if (text.includes('stacki-')) {
          names.add(text.slice(0, 80));
        }
      }
    }
  }
  return { names: [...names], outlinesMax };
}

// From a frame's row, the Navigator's keys up and left, three times each: the breadcrumb at every step.
async function walkUp(window) {
  const steps = [];
  await window.locator('[data-node-id]', { hasText: 'variant: main' }).first().click();
  for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowUp', 'ArrowUp', 'ArrowUp']) {
    await window.keyboard.press(key);
    steps.push(await window.locator('.crumbs').innerText());
  }
  return steps;
}

// A point inside an element of the canvas page, as a fraction of its box, in the window's coordinates: the preview
// frame is drawn scaled, so the frame's own box and scale place it.
async function pointIn(window, canvas, selector, fraction) {
  const outer = await window.evaluate(() => {
    const frame = document.querySelector('.preview-frame-wrap iframe');
    if (!(frame instanceof HTMLIFrameElement)) {
      return undefined;
    }
    const box = frame.getBoundingClientRect();
    return { left: box.left, top: box.top, scale: box.width / frame.offsetWidth };
  });
  assert.ok(outer !== undefined, 'the canvas is on screen');
  const inner = await canvas
    .locator(selector)
    .first()
    .evaluate((element, at) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width * at.x, y: rect.top + rect.height * at.y };
    }, fraction);
  return { x: outer.left + inner.x * outer.scale, y: outer.top + inner.y * outer.scale };
}

async function waitFor(check, what) {
  await waitForState({ what, read: check, until: (value) => value === true, pollCountMax: POLLS_MAX });
}
