// Goal: the component canvas's own-frames toggle sits in a prop's label row exactly as the {} button beside it does:
// the same box, the same vertical centre (and the ? before them shares it), the same icon size and the same gap, off
// and pressed, hovered and focused, refused at the limit, with and without a ? button, beside the purple variable
// circle, on long prop names, on segmented and dropdown rows, and right to left.
//
// Method: a copy of the Studio fixture's Lumos site in a temporary directory (never the owner's projects), the built
// app launched by Playwright with a mock keychain, a temporary user data directory and hidden windows
// (test/helpers/hiddenFlowPreload.js; HOME is left as it is). The Button's canvas is opened and a frame's instance
// selected; in every label row with the toggle, the boxes of the ?, the {} and the toggle are read in each state and
// compared to within half a pixel. Outside the gate (it starts the dev server):
// `node test/integration/propActionAlignment.js <screenshot directory>`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../helpers/sources.js');
const { waitFor: waitForState } = require('../helpers/waitFor.js');
const { _electron: electron } = require(repoPath('studio/node_modules/playwright'));

const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'stacki-prop-action-alignment'));
const SITE = repoPath('studio/test/fixtures/site');
const WAIT_MS = 60_000;
const POLLS_MAX = 600;
// Half a device pixel at 2x: a box that differs by less is drawn on the same pixels.
const TOLERANCE_PX = 0.5;

function writeFixture(project) {
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(SITE, 'src'), path.join(project, 'src'), { recursive: true });
  fs.cpSync(path.join(SITE, 'public'), path.join(project, 'public'), { recursive: true });
  for (const file of ['package.json', 'astro.config.mjs', 'tsconfig.json']) {
    fs.copyFileSync(path.join(SITE, file), path.join(project, file));
  }
  const cloned = childProcess.spawnSync('cp', ['-c', '-R', path.join(SITE, 'node_modules'), path.join(project, 'node_modules')], { stdio: 'inherit' });
  assert.equal(cloned.status, 0, 'the fixture packages were cloned');
  // A long prop name, to see the row wrap or clip without moving the toggle off the {}'s line.
  const button = path.join(project, 'src/components/Button.astro');
  const source = fs.readFileSync(button, 'utf8');
  const longer = source.replace('type Props = {\n', 'type Props = {\n  emphasisForTheVeryLongPropertyNameCase?: "one" | "two";\n');
  assert.notEqual(longer, source, 'the long prop was added');
  fs.writeFileSync(button, longer);
}

// Deleted, not emptied: Electron runs as plain Node when the name is set at all.
function electronEnvironment() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-prop-action-')));
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
  const shot = async (name, clip) => {
    const png = await app.evaluate(async ({ BrowserWindow }, area) => {
      const target = BrowserWindow.getAllWindows()[0];
      return target === undefined ? '' : (await target.capturePage(area)).toPNG().toString('base64');
    }, clip);
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
    // An arrow frame: its direction row has the toggle beside a segmented control, variant beside a dropdown.
    await window.locator('[data-node-id]', { hasText: 'arrow' }).first().click();
    await window.locator('button.prop-field-extra').first().waitFor({ timeout: WAIT_MS });
    results.off = await measureRows(window);
    await shot('01-off.png');
    // Pressed: direction gets its own frames, so its row is the locked one with the toggle on.
    await window.locator('button.prop-field-extra[aria-label^="Give each value of direction"]').click();
    await waitFor(async () => (await window.locator('button.prop-field-extra.on').count()) >= 2, 'direction is split');
    await window.locator('[data-node-id]', { hasText: 'direction: back' }).first().click();
    await waitFor(async () => (await window.locator('.prop-field-locked').count()) >= 1, 'the split rows are locked');
    results.on = await measureRows(window);
    const pressed = window.locator('button.prop-field-extra.on').last();
    await pressed.hover();
    await window.locator('[role="tooltip"]', { hasText: 'in one frame' }).waitFor({ timeout: WAIT_MS });
    results.hovered = await measureRows(window);
    await shot('02-on-hover.png');
    const row = await pressed.evaluate((button) => {
      const box = button.closest('.props-field').getBoundingClientRect();
      return { x: Math.round(box.left - 8), y: Math.round(box.top - 6), width: Math.round(box.width + 16), height: 64 };
    });
    await shot('03-zoomed-row.png', row);
    await pressed.focus();
    results.focused = await measureRows(window);
    // The purple variable circle shows on the row's hover; the toggle keeps its place beside it.
    await window.locator('.props-field', { hasText: 'emphasis' }).first().hover();
    results.circle = await measureRows(window);
    await shot('04-circle.png');
    // Right to left.
    await window.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
    results.rtl = await measureRows(window);
    await shot('05-rtl.png');
    await window.evaluate(() => document.documentElement.removeAttribute('dir'));
    results.failures = Object.entries(results).flatMap(([state, rows]) =>
      Array.isArray(rows) ? rows.flatMap((measured) => misalignments(measured).map((text) => `${state} ${measured.name}: ${text}`)) : [],
    );
    results.rowsMeasured = Object.values(results).reduce((total, rows) => total + (Array.isArray(rows) ? rows.length : 0), 0);
  } catch (error) {
    results.error = String(error && error.stack ? error.stack : error);
    await shot('error.png').catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
  }
  console.log(`RESULT ${JSON.stringify(results, undefined, 2)}`);
  console.log(`Screenshots: ${SHOTS}`);
  const passed = results.error === undefined && results.failures.length === 0 && results.rowsMeasured > 0;
  console.log(passed ? 'PASS the toggle sits as the {} does in every state' : 'FAIL');
  process.exitCode = passed ? 0 : 1;
})();

// Every label row holding the toggle: the boxes of its ?, {} and toggle, and the toggle's icon.
async function measureRows(window) {
  return window.locator('.props-field > label:has(button.prop-field-extra)').evaluateAll((labels) =>
    labels.map((label) => {
      const box = (element) => {
        if (element === null || element === undefined) {
          return undefined;
        }
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height, centre: rect.top + rect.height / 2 };
      };
      const braces = label.querySelector('.prop-expr-toggle:not(.prop-field-extra):not(.conditional-computed-toggle)');
      const toggle = label.querySelector('.prop-field-extra');
      return {
        name: label.textContent.trim().slice(0, 40),
        tip: box(label.querySelector('.prop-tip-icon')),
        braces: box(braces),
        toggle: box(toggle),
        bracesIcon: box(braces === null ? undefined : (braces.querySelector('svg') ?? undefined)),
        toggleIcon: box(toggle === null ? undefined : (toggle.querySelector('svg') ?? undefined)),
        gap: braces === null || toggle === null ? undefined : Math.abs(box(toggle).left - box(braces).right),
        bracesMargin: braces === null ? undefined : getComputedStyle(braces).marginInlineStart,
        toggleMargin: toggle === null ? undefined : getComputedStyle(toggle).marginInlineStart,
      };
    }),
  );
}

function misalignments(row) {
  const near = (measured, expected) => Math.abs(measured - expected) <= TOLERANCE_PX;
  const found = [];
  if (row.braces === undefined || row.toggle === undefined) {
    return row.toggle === undefined ? ['no toggle'] : [];
  }
  if (!near(row.toggle.centre, row.braces.centre)) {
    found.push(`centre ${row.toggle.centre} vs {} ${row.braces.centre}`);
  }
  if (row.tip !== undefined && !near(row.tip.centre, row.braces.centre)) {
    found.push(`? centre ${row.tip.centre} vs {} ${row.braces.centre}`);
  }
  if (!near(row.toggle.width, row.braces.width) || !near(row.toggle.height, row.braces.height)) {
    found.push(`box ${row.toggle.width}x${row.toggle.height} vs {} ${row.braces.width}x${row.braces.height}`);
  }
  if (!near(row.toggleIcon.width, row.bracesIcon.width) || !near(row.toggleIcon.centre, row.bracesIcon.centre)) {
    found.push(`icon ${row.toggleIcon.width} at ${row.toggleIcon.centre} vs {} ${row.bracesIcon.width} at ${row.bracesIcon.centre}`);
  }
  if (row.toggleMargin !== row.bracesMargin) {
    found.push(`gap ${row.toggleMargin} vs {} ${row.bracesMargin}`);
  }
  return found;
}

async function waitFor(check, what) {
  await waitForState({ what, read: check, until: (value) => value === true, pollCountMax: POLLS_MAX });
}
