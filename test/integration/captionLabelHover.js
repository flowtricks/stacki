// Goal: a field's caption row hovers and presses only the control under the pointer. A <label> with no `for` takes its
// first button as its control and forwards hover and presses to it, so pointing at a prop's name lit up the {} toggle
// beside it. Here, in the real app, the pointer rests on each caption's name and on its blank space, and no button in
// the row is :hover; a press on the name changes nothing; and no label anywhere in the panels holds a button it would
// control.
//
// Method: a copy of the Studio fixture's Lumos site in a temporary directory (never the owner's projects); the built
// app launched by Playwright with a mock keychain, a temporary user data directory and hidden windows
// (test/helpers/hiddenFlowPreload.js; HOME is left as it is). The Button's component canvas opens on a Button instance:
// its Settings panel (the ordinary instance panel) and the Frame settings popover are read with the real mouse, and the
// cause is shown by taking one row's `for` away again. Outside
// the gate (it starts the dev server): `node test/integration/captionLabelHover.js <screenshot directory>`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../helpers/sources.js');
const { waitFor: waitForState } = require('../helpers/waitFor.js');
const { _electron: electron } = require(repoPath('studio/node_modules/playwright'));

const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'stacki-caption-label-hover'));
const SITE = repoPath('studio/test/fixtures/site');
const WAIT_MS = 60_000;
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
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-caption-hover-')));
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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
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
    // The component canvas's Frame settings popover: its captions hold (i) hints.
    await window.locator('[data-rail-id="components"]').click();
    await window.locator('button[aria-label="Options for Button"]').first().click({ force: true });
    await window.getByRole('menuitem', { name: 'Open in canvas' }).click();
    await window.locator('[data-testid="component-canvas-panel"]').waitFor({ timeout: WAIT_MS });
    await waitFor(async () => (await window.locator('.props-field > label button.prop-expr-toggle').count()) > 0, 'the frame instance’s settings show');
    // A Button instance's Settings panel (segmented, dropdown and text rows) and the Frame settings popover (its (i)).
    results.instance = await probeCaptions(window);
    results.unboundLabels = await unboundLabels(window);
    await shot('01-instance-panel.png');
    // The cause, shown: the same row with its `for` taken away hovers its {} while the pointer is on its name.
    results.causeWithoutFor = await withoutFor(window);
  } catch (error) {
    results.error = String(error && error.stack ? error.stack : error);
    await shot('error.png').catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
  }
  const failures = [
    ...(results.error === undefined ? [] : [results.error]),
    ...(results.instance ?? []).filter((row) => row.hovered.length > 0 || row.pressedChanged).map((row) => JSON.stringify(row)),
    ...(results.unboundLabels ?? []),
    ...(results.causeWithoutFor === true ? [] : ['the cause did not reproduce: a row without `for` did not hover its {}']),
  ];
  console.log(`RESULT ${JSON.stringify(results, undefined, 2)}`);
  console.log(`Screenshots: ${SHOTS}`);
  console.log(failures.length === 0 ? 'PASS only the control under the pointer is hovered or pressed' : `FAIL\n${failures.join('\n')}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
})();

// Each caption row with a button in it, up to a bound: the pointer on its name, then on its blank space at the end of
// the row, reading which of its buttons is :hover; then a press on the name, reading whether any button's pressed state
// changed. The row's name is its `.prop-label` (or its first text).
const ROWS_MAX = 12;
async function probeCaptions(window) {
  const rows = window.locator('.props-field > label:has(button), .component-canvas-panel label:has(button)');
  const count = Math.min(await rows.count(), ROWS_MAX);
  const found = [];
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    if (box === null) {
      continue;
    }
    const name = row.locator('.prop-label').first();
    const nameBox = (await name.count()) > 0 ? await name.boundingBox() : { x: box.x + 2, y: box.y + 2, width: 4, height: box.height - 4 };
    const points = [
      { where: 'name', x: nameBox.x + Math.min(6, nameBox.width / 2), y: nameBox.y + nameBox.height / 2 },
      { where: 'blank', x: box.x + box.width - 4, y: box.y + box.height / 2 },
    ];
    const hovered = [];
    for (const point of points) {
      await window.mouse.move(point.x, point.y);
      const lit = await row.evaluate(
        (label, at) =>
          [...label.querySelectorAll('button')]
            .filter((button) => button.matches(':hover'))
            .filter((button) => {
              const rect = button.getBoundingClientRect();
              return !(at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom);
            })
            .map((button) => button.getAttribute('aria-label') ?? button.className),
        point,
      );
      hovered.push(...lit.map((button) => `${point.where}: ${button}`));
    }
    const pressedBefore = await row.evaluate((label) => [...label.querySelectorAll('button')].map((button) => button.getAttribute('aria-pressed')).join(','));
    await window.mouse.click(points[0].x, points[0].y);
    await window.keyboard.press('Escape');
    const pressedAfter = await row.evaluate((label) => [...label.querySelectorAll('button')].map((button) => button.getAttribute('aria-pressed')).join(','));
    found.push({ name: (await row.innerText()).split('\n')[0]?.slice(0, 40) ?? '', hovered, pressedChanged: pressedBefore !== pressedAfter });
  }
  return found;
}

async function withoutFor(window) {
  const row = window
    .locator('.props-field > label:has(> .prop-field-actions > button.prop-expr-toggle), .props-field > label:has(> button.prop-expr-toggle)')
    .first();
  await row.evaluate((label) => label.removeAttribute('for'));
  const name = await row.locator('.prop-label').first().boundingBox();
  await window.mouse.move(name.x + 4, name.y + name.height / 2);
  const lit = await row.evaluate((label) => label.querySelector('button.prop-expr-toggle')?.matches(':hover') === true);
  await row.evaluate((label) => label.setAttribute('for', ''));
  await window.mouse.move(0, 0);
  return lit;
}

// Labels on screen that would make a button their control: no `for`, and a button as their first labelable descendant.
async function unboundLabels(window) {
  return window.evaluate(() =>
    [...document.querySelectorAll('label:not([for])')]
      .filter((label) => label.querySelector('button, input, select, textarea, meter, output, progress')?.tagName === 'BUTTON')
      .map((label) => `label controls a button: ${(label.textContent ?? '').trim().slice(0, 60)}`),
  );
}

async function waitFor(check, what) {
  await waitForState({ what, read: check, until: (value) => value === true, pollCountMax: POLLS_MAX });
}
