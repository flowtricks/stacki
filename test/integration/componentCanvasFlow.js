// Goal: see the component canvas work in the real app, end to end, and keep screenshots for a person: Open canvas from a
// component's "…" menu, frames per variant of a Lumos button, giving the arrow direction its own frames (the direction
// prop then greyed out), preview values and backgrounds that land in .stacki/component-canvas.json and never in the
// component, a frame size, an element added inside a frame reaching every frame with undo, and Close canvas returning
// to the page. Then a modal with its preview switch, a card with slots, a section, a component with required props
// and one whose union is an imported TypeScript type.
//
// Method: a generated fixture project in a temporary directory (the Studio fixture's Lumos site, its installed packages
// cloned beside it, copy-on-write on macOS), never the owner's projects. The built app (`npm run build:electron`,
// `npx vite build`) is launched by Playwright with its own user data directory, opened on the fixture, and driven with
// real clicks and keys. Files are read from disk to check what was written. Outside the gate (it starts the dev server):
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
    args: [repoPath('dist/electron/main.js'), `--user-data-dir=${path.join(root, 'user-data')}`, project],
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

    // Open canvas on the Lumos button: one frame per variant.
    await openCanvas(window, 'Button');
    await canvas.locator('stacki-frame').nth(4).waitFor({ timeout: WAIT_MS });
    await canvas.locator('stacki-frame .button_wrap').first().waitFor({ timeout: WAIT_MS });
    await window.waitForSelector('[data-testid="component-canvas-panel"]', { timeout: WAIT_MS });
    results.buttonFrames = await labels(canvas);
    await settled(canvas);
    await shot(window, '01-button-canvas.png');

    // The arrow direction gets its own frames; in an arrow frame the direction prop is greyed out.
    await window.getByRole('switch', { name: 'Give each value of direction its own frame' }).click();
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) === 6, 'the arrow frames split by direction');
    results.splitFrames = await labels(canvas);
    await press(canvas.locator('stacki-frame[data-frame="direction=back&variant=arrow"] stacki-frame-label'));
    await waitFor(async () => (await window.locator('.component-canvas-prop.is-disabled', { hasText: 'direction' }).count()) === 1, 'direction is disabled');
    results.directionDisabled = true;
    await waitForFile(
      () => read('.stacki/component-canvas.json'),
      (text) => text.includes('"direction"'),
    );
    await settled(canvas);
    await shot(window, '02-split-direction.png');

    // A preview value for this frame only, then a background for every frame.
    await pick(window, 'emphasis', 'secondary');
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

    // Select an element inside a frame: the ordinary panel; add a line break to the component, in every frame.
    await press(canvas.locator('stacki-frame[data-frame="variant=main"] .button_wrap'));
    await settled(canvas);
    await shot(window, '04-element-selected.png');
    await window.locator('[data-rail-id="elements"]').click();
    await window.locator('.add-elements-tile', { hasText: 'Line break' }).first().click();
    await waitForFile(
      () => read('src/components/Button.astro'),
      (text) => text !== buttonBefore,
    );
    const afterInsert = read('src/components/Button.astro');
    results.inserted = /<br\s*\/?>/.test(afterInsert);
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

    // Close canvas: back on the page, and the canvas page is gone.
    await window.getByRole('button', { name: 'Close Button canvas' }).click();
    await waitFor(async () => (await window.locator('[data-testid="component-canvas-panel"]').count()) === 0, 'the canvas closed');
    results.canvasPagesLeft = fs.existsSync(path.join(project, '.stacki/canvas')) ? fs.readdirSync(path.join(project, '.stacki/canvas')).length : 0;
    await settled(canvas);
    await shot(window, '06-closed.png');

    // Reopening remembers the split and the values.
    await openCanvas(window, 'Button');
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) === 6, 'the split is remembered');
    results.reopened = await labels(canvas);
    await settled(canvas);
    await shot(window, '07-reopened.png');
    await window.getByRole('button', { name: 'Close Button canvas' }).click();
    await waitFor(async () => (await window.locator('[data-testid="component-canvas-panel"]').count()) === 0, 'the canvas closed again');

    // A modal: its preview switch on for every frame, so it shows in a window-sized frame.
    await openCanvas(window, 'Modal');
    await canvas.locator('stacki-frame').first().waitFor({ timeout: WAIT_MS });
    await pick(window, 'Apply to', 'All frames');
    await window.getByRole('switch', { name: 'preview', exact: true }).click();
    await waitFor(async () => (await canvas.locator('stacki-frame .modal_wrap.preview').count()) >= 1, 'the modal previews');
    results.modalFrames = await labels(canvas);
    results.modalFallback = await canvas.locator('stacki-frame-body[data-fallback]').count();
    await settled(canvas);
    await shot(window, '08-modal.png');
    await window.getByRole('button', { name: 'Close Modal canvas' }).click();
    await waitFor(async () => (await window.locator('[data-testid="component-canvas-panel"]').count()) === 0, 'the modal canvas closed');

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
      await waitFor(async () => (await window.locator('[data-testid="component-canvas-panel"]').count()) === 0, `the ${name} canvas closed`);
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
    await waitFor(async () => (await window.locator('[data-testid="component-canvas-panel"]').count()) === 0, 'the Section canvas closed');

    // Consistency views: the menu, many frames zoomed out, a narrow window, a frame tooltip, and Arabic.
    await window.locator('[data-rail-id="components"]').click();
    await window.locator('button[aria-label="Options for Button"]').first().click({ force: true });
    await window.getByRole('menuitem', { name: 'Open in canvas' }).waitFor({ timeout: WAIT_MS });
    await shot(window, '13-menu.png');
    await window.getByRole('menuitem', { name: 'Open in canvas' }).click();
    await window.waitForSelector('[data-testid="component-canvas-panel"]', { timeout: WAIT_MS });
    await window.getByRole('switch', { name: 'Give each value of emphasis its own frame' }).click();
    await waitFor(async () => (await canvas.locator('stacki-frame').count()) > 6, 'emphasis splits the frames');
    results.manyFrames = await canvas.locator('stacki-frame').count();
    await settled(canvas);
    await shot(window, '14-many-frames.png');
    await press(canvas.locator('stacki-frame[data-frame="direction=forward&emphasis=primary&variant=arrow"] stacki-frame-label'));
    await window.locator('.component-canvas-prop.is-disabled', { hasText: 'direction' }).locator('.component-canvas-disabled').hover();
    await window.waitForSelector('.rail-tooltip', { timeout: WAIT_MS });
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
  await window.waitForSelector('[data-testid="component-canvas-panel"]', { timeout: WAIT_MS });
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

async function labels(canvas) {
  return canvas.locator('stacki-frame-label').allTextContents();
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
        .locator('stacki-canvas-world')
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
