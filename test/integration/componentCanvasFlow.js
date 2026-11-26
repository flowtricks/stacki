// Goal: see the component canvas work in the real app, end to end, and keep screenshots for a person: Open in canvas
// from a component's "…" menu opens frames per variant of a Lumos button with each instance closed, listed in the
// Navigator by frame and the first one selected; the Settings panel's own-frames toggle gives the arrow direction its
// own frames (the direction prop then greyed out); preview values from the Settings panel and backgrounds from Frame
// settings land in .stacki/component-canvas.json and never in the component or the canvas page; an edit on the canvas
// page is refused; a double click goes inside an instance, where an element added reaches every frame (with undo),
// Escape steps back out, and Close canvas leaves from inside. Frame settings minimize and expand from their header. Then
// a modal with its preview switch, a card with slots, a section, a component with required props and one whose union
// is an imported TypeScript type.
//
// Method: a generated fixture project in a temporary directory (the Studio fixture's Lumos site, its installed packages
// cloned beside it, copy-on-write on macOS), never the owner's projects. The built app (`npm run build:electron`,
// `npx vite build`) is launched by Playwright with its own user data directory, a mock keychain (never the person's
// login keychain) and hidden windows (test/helpers/hiddenFlowPreload.js), opened on the fixture, and driven with real
// clicks and keys; HOME is left as it is. Files are read from disk to check what was written. Outside the gate (it starts the dev server):
// `node test/integration/componentCanvasFlow.js <screenshot directory>`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../helpers/sources.js');
const { waitFor: waitForState, waitForSteady } = require('../helpers/waitFor.js');
// Playwright is Studio's dev dependency (its browser tests); Desktop reuses it here rather than adding its own copy.
const { _electron: electron } = require(repoPath('studio/node_modules/playwright'));

const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'stacki-component-canvas-shots'));
const SITE = repoPath('studio/test/fixtures/site');
const WAIT_MS = 60_000;
// A dev server's first render of a page is the slowest step: 600 polls of 50 ms is half a minute.
const POLLS_MAX = 600;

function writeFixture(project) {
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(SITE, 'src'), path.join(project, 'src'), { recursive: true });
  fs.cpSync(path.join(SITE, 'public'), path.join(project, 'public'), { recursive: true });
  for (const file of ['package.json', 'astro.config.mjs', 'tsconfig.json']) {
    fs.copyFileSync(path.join(SITE, file), path.join(project, file));
  }
  const cloned = childProcess.spawnSync('cp', ['-c', '-R', path.join(SITE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'inherit' });
  assert.equal(cloned.status, 0, 'the fixture packages were cloned');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), text);
  };
  // Required props: nothing gives them a value, so the canvas must.
  write(
    'src/components/Badge.astro',
    '---\ninterface Props {\n  label: string;\n  tone: "info" | "warning" | "danger";\n  count: number;\n}\nconst { label, tone, count } = Astro.props;\n---\n<span class:list={["badge", tone]}>{label} ({count})</span>\n<style is:global>\n  .badge { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 0.25rem; background: #ddd; }\n  .badge.warning { background: #fd5; }\n  .badge.danger { background: #f77; }\n</style>\n',
  );
  // Component defaults (Set component defaults): every frame starts from these, nested recipes included.
  write(
    '.stacki/components.json',
    `${JSON.stringify(
      {
        version: 1,
        components: {
          'src/components/Button.astro': { text: 'Get started' },
          'src/components/item/Card.astro': { props: { heading: 'Card from defaults', text: 'Body from the component defaults.', buttonLabel: 'Open' } },
          'src/components/wrapper/ButtonWrapper.astro': {
            children: [
              { component: 'src/components/Button.astro' },
              { component: 'src/components/Button.astro', props: { emphasis: 'secondary' }, text: 'Second' },
            ],
          },
        },
      },
      undefined,
      2,
    )}\n`,
  );
  // A union declared in another file and imported as a type.
  write('src/types/tone.ts', 'export type Size = "small" | "medium" | "large";\n');
  write(
    'src/components/Tag.astro',
    '---\nimport type { Size } from "../types/tone";\ninterface Props {\n  size?: Size;\n  outlined?: boolean;\n}\nconst { size = "medium", outlined = false } = Astro.props;\n---\n<span class:list={["tag", size, outlined && "outlined"]}><slot /></span>\n<style is:global>\n  .tag { display: inline-block; padding: 0.2rem 0.6rem; background: #cde; }\n  .tag.small { font-size: 0.75rem; }\n  .tag.large { font-size: 1.5rem; }\n  .tag.outlined { background: none; box-shadow: inset 0 0 0 1px currentColor; }\n</style>\n',
  );
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-component-canvas-')));
  const project = path.join(root, 'site');
  writeFixture(project);
  const read = (file) => (fs.existsSync(path.join(project, file)) ? fs.readFileSync(path.join(project, file), 'utf8') : '');
  const buttonBefore = read('src/components/Button.astro');
  const app = await electron.launch({
    // A mock keychain (never the person's login keychain) and hidden windows; HOME is left as it is.
    args: [
      '-r',
      repoPath('test/helpers/hiddenFlowPreload.js'),
      repoPath('dist/electron/main.js'),
      '--use-mock-keychain',
      `--user-data-dir=${path.join(root, 'user-data')}`,
      project,
    ],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const results = {};
  // Captured by main (capturePage), which never waits on the page: a window behind others still answers.
  const shot = async (_window, name) => {
    console.log(`shot ${name}`);
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible()) ?? BrowserWindow.getAllWindows()[0];
      return target === undefined ? '' : (await target.capturePage()).toPNG().toString('base64');
    });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(png, 'base64'));
  };
  try {
    const window = await app.firstWindow();
    console.log('window open');
    // The window's own size, set by main: a viewport emulation on an Electron window can wait for a paint that never comes.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
    console.log('sized');
    await shot(window, '00-start.png');
    const canvas = window.frameLocator('.preview-frame-wrap iframe').first();
    await canvas.locator('body').waitFor({ timeout: WAIT_MS });
    await settled(canvas);
    await shot(window, '00-page.png');

    // Open in canvas on the Lumos button: one frame per variant, every instance closed, the first one selected.
    await openCanvas(window, 'Button');
    await canvas.locator('stacki-frame').nth(4).waitFor({ timeout: WAIT_MS });
    await canvas.locator('stacki-frame .button_wrap').first().waitFor({ timeout: WAIT_MS });
    results.buttonFrames = await labels(canvas);
    await waitFor(
      // html, then per frame its div (named by its caption) holding its closed instance.
      async () => (await navigatorRows(window)).length === results.buttonFrames.length * 2 + 1,
      'the Navigator lists the canvas root, a div per frame and its instance',
    );
    results.navigatorRows = await navigatorRows(window);
    results.stackOnOpen = await window.locator('.titlebar .comp-back').allInnerTexts();
    results.firstSelected = await window
      .locator('.tree-row.selected, [data-node-id].selected')
      .first()
      .innerText()
      .catch(() => '');
    await settled(canvas);
    await shot(window, '01-button-canvas.png');

    // An arrow frame's instance, from its Navigator row: the Settings panel shows its props, and the own-frames toggle
    // beside direction's {} splits the arrow frames by direction.
    await window.locator('[data-node-id]', { hasText: 'arrow' }).first().click();
    const directionToggle = window.locator('button.prop-field-extra[aria-label^="Give each value of direction"]');
    await directionToggle.waitFor({ timeout: WAIT_MS });
    await shot(window, '02a-settings-panel.png');
    await directionToggle.click();
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) === 6, 'the arrow frames split by direction');
    results.splitFrames = await labels(canvas);
    await press(canvas.locator('stacki-frame[data-frame="direction=back&variant=arrow"]'));
    await waitFor(async () => (await window.locator('.prop-field-locked', { hasText: 'direction' }).count()) === 1, 'direction is locked in its frames');
    results.directionLocked = true;
    results.toggleOn = await window.locator('button.prop-field-extra.on[aria-label="Show direction in one frame"]').getAttribute('aria-pressed');
    await waitForFile(
      () => read('.stacki/component-canvas.json'),
      (text) => text.includes('"direction"'),
    );
    await settled(canvas);
    await shot(window, '02-split-direction.png');

    // A preview value for this frame only, from the ordinary prop field; then a background for every frame.
    const pagePath = await window.evaluate(() => document.querySelector('.preview-frame-wrap iframe')?.getAttribute('src') ?? '');
    results.canvasPageSrc = pagePath;
    await window
      .locator('.right-panel .props-field, .props-field', { hasText: 'emphasis' })
      .first()
      .locator('button, [role="radio"]', { hasText: 'secondary' })
      .first()
      .click();
    await pick(window, 'Apply to', 'All frames');
    const background = window.locator('.component-canvas-color input');
    await background.fill('#fff4d6');
    await background.press('Enter');
    await waitForFile(
      () => read('.stacki/component-canvas.json'),
      (text) => text.includes('"background": "#fff4d6"') && text.includes('"emphasis": "secondary"'),
    );
    results.settings = JSON.parse(read('.stacki/component-canvas.json'));
    results.componentUntouched = read('src/components/Button.astro') === buttonBefore;
    await settled(canvas);
    await shot(window, '03-preview-values.png');
    // The background's variable circle, the Style panel's own, at every Apply to level: a frame's, then the canvas
    // root's (its html row), whose background is the surface every frame sits on.
    for (const [scope, file] of [
      ['All frames', '03a-circle-all-frames.png'],
      ['This frame', '03a-circle-this-frame.png'],
      ['All components', '03a-circle-all-components.png'],
    ]) {
      if (scope === 'All components') {
        await window.locator('[data-node-id]', { hasText: 'html' }).first().click();
        await waitFor(async () => (await window.locator('.component-canvas-section[aria-label="Canvas"]').count()) === 1, 'the root settings show');
      }
      await pick(window, 'Apply to', scope);
      await window.locator('.component-canvas-color .embed-editor_varconnect').hover();
      await waitFor(
        async () => (await window.locator('.component-canvas-color .embed-editor_varconnect-dot').evaluate((dot) => getComputedStyle(dot).opacity)) === '1',
        `the variable circle shows at ${scope}`,
      );
      results[`circle ${scope}`] = true;
      await shot(window, file);
    }
    // Bound to a variable: the chip, and a swatch resolved on the canvas page's root with nothing selected inside.
    await window.locator('.component-canvas-color .embed-editor_varconnect-dot').click();
    await window.locator('text=#ebebeb >> visible=true').first().click();
    await waitForFile(
      () => read('.stacki/component-canvas.json'),
      (text) => text.includes('var(--'),
    );
    results.swatchFill = await window.locator('.component-canvas-color .u-color-swatch-fill').evaluate((fill) => fill.style.background);
    await shot(window, '03a-bound-variable.png');
    await window.locator('[data-node-id]', { hasText: 'direction: back' }).first().click();
    await pick(window, 'Apply to', 'All frames');

    // An edit on the canvas page itself (delete the selected instance) is refused with a toast; nothing is written.
    const canvasFiles = () => fs.readdirSync(path.join(project, '.stacki/canvas')).filter((file) => file.endsWith('.astro'));
    const pageBefore = read(`.stacki/canvas/${canvasFiles()[0]}`);
    await window.locator('[data-node-id]', { hasText: 'main' }).first().click();
    await window.keyboard.press('Backspace');
    await window.locator('.toast', { hasText: 'Double-click a frame' }).first().waitFor({ timeout: WAIT_MS });
    results.pageEditRefused = read(`.stacki/canvas/${canvasFiles()[0]}`) === pageBefore;
    await shot(window, '03b-page-edit-refused.png');

    // Frame settings minimize to their header, and expand again from it: they are never gone.
    await window.getByRole('button', { name: 'Minimize frame settings' }).click();
    await waitFor(async () => (await window.locator('[data-testid="component-canvas-panel"]').count()) === 0, 'frame settings minimized');
    const toggle = window.locator('.component-canvas-popup-toggle');
    results.toggleClosed = await toggle.getAttribute('aria-expanded');
    await shot(window, '03c-frame-settings-minimized.png');
    await window.getByRole('button', { name: 'Expand frame settings' }).click();
    await window.waitForSelector('[data-testid="component-canvas-panel"]', { timeout: WAIT_MS });
    results.toggleOpen = await toggle.getAttribute('aria-expanded');

    // A double click goes inside the main frame's instance: add a line break, in every frame, then undo.
    const mainBody = canvas.locator('stacki-frame[data-frame="variant=main"] .button_wrap').first();
    // The instance's row, under its frame's div (the first frame is variant: main).
    await window
      .locator('[data-node-id]', { hasText: /^Button$/ })
      .first()
      .dblclick();
    await waitFor(async () => (await window.locator('.titlebar .comp-back').count()) === 2, 'inside the instance: Back and Close canvas');
    results.stackInside = await window.locator('.titlebar .comp-back').allInnerTexts();
    await press(canvas.locator('stacki-frame[data-frame="variant=main"] .button_wrap').first());
    await settled(canvas);
    await shot(window, '04-inside-instance.png');
    await window.locator('[data-rail-id="elements"]').click();
    await window.locator('.add-elements-tile', { hasText: 'Line break' }).first().click();
    await waitForFile(
      () => read('src/components/Button.astro'),
      (text) => text !== buttonBefore,
    );
    results.inserted = /<br\s*\/?>/.test(read('src/components/Button.astro'));
    await waitFor(async () => (await canvas.locator('stacki-frame br').count()) >= 2, 'the break shows in more than one frame');
    results.framesWithBreak = await canvas.locator('stacki-frame br').count();
    await settled(canvas);
    await shot(window, '05-inserted.png');
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await waitForFile(
      () => read('src/components/Button.astro'),
      (text) => text === buttonBefore,
    );
    results.undo = true;

    // Escape steps back out one level, as anywhere: the canvas page again, the canvas still open.
    await window.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await window.keyboard.press('Escape');
    await waitFor(async () => (await window.locator('.titlebar .comp-back').count()) === 1, 'back on the canvas page');
    results.backedOut = (await canvas.locator('stacki-frame').count()) === 6;

    // Close canvas from inside an instance: back on the page, and the canvas page is gone.
    await realDoubleClick(window, 'stacki-frame[data-frame="variant=main"] .button_wrap');
    await waitFor(async () => (await window.locator('.titlebar .comp-back').count()) === 2, 'inside the instance again, by a double click on the canvas').catch(
      async (error) => {
        results.canvasDoubleClickToasts = await window.locator('.toast').allInnerTexts();
        throw error;
      },
    );
    await window.getByRole('button', { name: 'Close Button canvas' }).click();
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) === 0, 'the canvas closed');
    results.canvasPagesLeft = fs.existsSync(path.join(project, '.stacki/canvas')) ? canvasFiles().length : 0;
    await settled(canvas);
    await shot(window, '06-closed.png');

    // Reopening remembers the split and the values.
    await openCanvas(window, 'Button');
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) === 6, 'the split is remembered');
    results.reopened = await labels(canvas);
    await settled(canvas);
    await shot(window, '07-reopened.png');
    await window.getByRole('button', { name: 'Close Button canvas' }).click();
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) === 0, 'the canvas closed again');

    // A modal: its preview switch on for every frame, so it shows in a window-sized frame.
    await openCanvas(window, 'Modal');
    await canvas.locator('stacki-frame').first().waitFor({ timeout: WAIT_MS });
    await pick(window, 'Apply to', 'All frames');
    await window.locator('.props-field', { hasText: 'preview' }).first().locator('button, [role="radio"]', { hasText: 'True' }).first().click();
    await waitFor(async () => (await canvas.locator('stacki-frame .modal_wrap.preview').count()) >= 1, 'the modal previews');
    results.modalFrames = await labels(canvas);
    results.modalFallback = await canvas.locator('stacki-frame[data-fallback]').count();
    await settled(canvas);
    await shot(window, '08-modal.png');
    await window.getByRole('button', { name: 'Close Modal canvas' }).click();
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) === 0, 'the modal canvas closed');

    for (const [name, file] of [
      ['Card', '09-card.png'],
      ['Button Wrapper', '09b-button-wrapper-defaults.png'],
      ['Section', '10-section.png'],
      ['Badge', '11-badge-required.png'],
      ['Tag', '12-tag-imported-type.png'],
    ]) {
      await openCanvas(window, name);
      await canvas.locator('stacki-frame').first().waitFor({ timeout: WAIT_MS });
      results[name] = await labels(canvas);
      await settled(canvas);
      await shot(window, file);
      await window.getByRole('button', { name: `Close ${name} canvas` }).click();
      await waitFor(async () => (await canvas.locator('stacki-frame').count()) === 0, `the ${name} canvas closed`);
    }
    results.finalSettings = JSON.parse(read('.stacki/component-canvas.json'));

    // Open in canvas from the navigator's right-click menu, second under Open component.
    // The rail toggles its panel: open the navigator only when it is not showing already.
    if ((await window.locator('[data-node-id]').count()) === 0) {
      await window.locator('[data-rail-id="navigator"]').click();
    }
    await window.locator('[data-node-id]', { hasText: 'Section' }).first().click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Open in canvas' }).waitFor({ timeout: WAIT_MS });
    results.contextMenu = await window.locator('.ctx-menu [role="menuitem"]').allInnerTexts();
    await shot(window, '12b-context-menu.png');
    await window.getByRole('menuitem', { name: 'Open in canvas' }).click();
    await window.waitForSelector('[data-testid="component-canvas-panel"]', { timeout: WAIT_MS });
    await settled(canvas);
    await shot(window, '12c-section-from-context-menu.png');
    await window.getByRole('button', { name: 'Close Section canvas' }).click();
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) === 0, 'the Section canvas closed');

    // Consistency views: the menu, many frames zoomed out, a narrow window, a frame tooltip, and Arabic.
    await window.locator('[data-rail-id="components"]').click();
    await window.locator('button[aria-label="Options for Button"]').first().click({ force: true });
    await window.getByRole('menuitem', { name: 'Open in canvas' }).waitFor({ timeout: WAIT_MS });
    await shot(window, '13-menu.png');
    await window.getByRole('menuitem', { name: 'Open in canvas' }).click();
    await window.waitForSelector('[data-testid="component-canvas-panel"]', { timeout: WAIT_MS });
    await window.locator('[data-node-id]', { hasText: 'variant: main' }).first().click();
    await window.locator('button.prop-field-extra[aria-label^="Give each value of emphasis"]').click();
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) > 6, 'emphasis splits the frames');
    results.manyFrames = await canvas.locator('stacki-frame').count();
    await settled(canvas);
    await shot(window, '14-many-frames.png');
    await press(canvas.locator('stacki-frame[data-frame="direction=forward&emphasis=primary&variant=arrow"]'));
    await window.locator('button.prop-field-extra.on').first().hover();
    await window.locator('[role="tooltip"]', { hasText: 'in one frame' }).waitFor({ timeout: WAIT_MS });
    await shot(window, '15-disabled-tooltip.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1100, 760));
    await settled(canvas);
    await shot(window, '16-narrow.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
    await window.evaluate(() => localStorage.setItem('stacki.locale', 'ar'));
    await window.reload();
    // A reload lands on the start screen: the fixture is its recent project.
    await window.getByText('site', { exact: true }).first().click();
    await window.waitForSelector('[data-testid="component-canvas-panel"], [data-rail-id="components"]', { timeout: WAIT_MS });
    await window.locator('[data-rail-id="components"]').click();
    await window.locator('.palette-row-menu').first().waitFor({ timeout: WAIT_MS });
    const buttonRow = window.locator('.palette-item', { hasText: 'Button' }).first().locator('.palette-row-menu');
    await buttonRow.click({ force: true });
    const arabicOpen =
      /'componentCanvas\.menu\.open': '([^']+)'/.exec(fs.readFileSync(repoPath('shared/properties/i18n/messages/ar/componentCanvas.ts'), 'utf8'))?.[1] ?? '';
    await window.getByRole('menuitem', { name: arabicOpen }).waitFor({ timeout: WAIT_MS });
    await shot(window, '17-arabic-menu.png');
    await window.getByRole('menuitem', { name: arabicOpen }).click();
    await window.waitForSelector('[data-testid="component-canvas-panel"]', { timeout: WAIT_MS });
    await settled(canvas);
    await shot(window, '18-arabic-canvas.png');
    await window.evaluate(() => localStorage.removeItem('stacki.locale'));
  } catch (error) {
    results.error = String(error && error.stack ? error.stack : error);
    console.log(`error ${results.error}`);
    await shot(undefined, 'error.png').catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
    fs.writeFileSync(path.join(SHOTS, 'component-canvas.json'), read('.stacki/component-canvas.json'));
  }
  console.log(`RESULT ${JSON.stringify(results, undefined, 2)}`);
  console.log(`Screenshots: ${SHOTS}`);
  console.log(`Fixture: ${project}`);
})();

async function openCanvas(window, name) {
  await window.locator('[data-rail-id="components"]').click();
  const row = window.locator(`button[aria-label="Options for ${name}"]`).first();
  await row.waitFor({ timeout: WAIT_MS });
  await row.click({ force: true });
  await window.getByRole('menuitem', { name: 'Open in canvas' }).click();
  await window.frameLocator('.preview-frame-wrap iframe').first().locator('stacki-frame').first().waitFor({ timeout: WAIT_MS });
}

// Picks an option in the app's own dropdown, named by its trigger's label.
async function pick(window, label, option) {
  const trigger = window.locator(`button.dd-trigger[aria-label="${label}"]`).first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await window.locator('.dd-option', { hasText: option }).first().click();
}

// A press and a click inside the preview frame, sent to the element: Playwright refuses pointer clicks inside a frame the
// editor draws scaled (a fixed-width Desktop), and the editor reads both from the element they land on.
async function press(locator) {
  await locator.dispatchEvent('pointerdown', { button: 0, bubbles: true });
  await locator.dispatchEvent('click', { button: 0, bubbles: true });
}

// A double click with the real mouse at an element inside the preview frame: the frame is drawn scaled, so the point is
// worked out from the element's box in the frame, the frame's box in the window and the scale between them.
async function realDoubleClick(window, selector) {
  const outer = await window.evaluate(() => {
    const frame = document.querySelector('.preview-frame-wrap iframe');
    if (!(frame instanceof HTMLIFrameElement)) {
      return undefined;
    }
    const box = frame.getBoundingClientRect();
    return { left: box.left, top: box.top, scale: box.width / frame.offsetWidth };
  });
  assert.ok(outer !== undefined, 'the canvas is on screen');
  const box = await window
    .frameLocator('.preview-frame-wrap iframe')
    .first()
    .locator(selector)
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
  await window.mouse.dblclick(outer.left + box.x * outer.scale, outer.top + box.y * outer.scale);
}

// The Navigator's rows: on the canvas page, one per frame, named as the frame.
async function navigatorRows(window) {
  return window.locator('[data-node-id]').allInnerTexts();
}

async function labels(canvas) {
  // A frame's caption is its own (data-label), drawn by the frame: not an element.
  return canvas.locator('stacki-frame').evaluateAll((frames) => frames.map((frame) => frame.getAttribute('data-label') ?? ''));
}

// Polls a condition the app should reach, within a bound.
async function waitFor(check, what) {
  await waitForState({ what, read: check, until: (value) => value === true, pollCountMax: POLLS_MAX });
}

// Waits until the canvas world stops moving (fitting, loading images) so a screenshot shows where it settled.
async function settled(canvas) {
  await waitForSteady({
    what: 'the canvas world settles',
    read: () =>
      canvas
        .locator('body')
        .evaluate((world) => `${world.style.transform}|${world.offsetWidth}|${world.offsetHeight}`)
        .catch(() => 'none'),
    until: () => true,
    pollCountMax: POLLS_MAX,
  });
}

// Polls a file for what an action should have written, within a bound.
async function waitForFile(read, until) {
  await waitFor(async () => until(read()), `the file showed the edit:\n${read()}`);
}
