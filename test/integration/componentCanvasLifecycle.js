// Goal: leaving the component canvas never leaves the preview pointing at the canvas's temporary page. After Close
// canvas (right after an edit, while the page reloads, with project files changing meanwhile), after leaving by the page
// switcher, and after reopening, the page on screen renders, no "Failed to load url /.stacki/canvas/…" appears in any
// frame, and no error toast is raised.
// Method: a copy of the Studio fixture's Lumos site in a temporary directory (never the owner's projects); the built
// app launched by Playwright; after each way of leaving, every preview frame's text and the app's toasts are polled
// for the error for a bounded time. Outside the gate (it starts the dev server):
// `node test/integration/componentCanvasLifecycle.js <screenshot directory>`.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../helpers/sources.js');
const { waitFor: waitForState } = require('../helpers/waitFor.js');
const { _electron: electron } = require(repoPath('studio/node_modules/playwright'));

const SHOTS = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'stacki-component-canvas-lifecycle'));
const SITE = repoPath('studio/test/fixtures/site');
const WAIT_MS = 60_000;
// The error, when it comes, follows the removal within a dev-server round trip: 120 polls of 50 ms watch six seconds.
const WATCH_POLLS = 120;
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-canvas-lifecycle-')));
  const project = path.join(root, 'site');
  writeFixture(project);
  const app = await electron.launch({
    args: [repoPath('dist/electron/main.js'), `--user-data-dir=${path.join(root, 'user-data')}`, project],
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
    const canvasFiles = () => (fs.existsSync(path.join(project, '.stacki/canvas')) ? fs.readdirSync(path.join(project, '.stacki/canvas')) : []);
    // Every frame's text and every toast, for the error a removed canvas page would raise.
    const failure = async () => {
      const texts = await window.evaluate(() =>
        [...document.querySelectorAll('.preview-frame-wrap iframe')].map((frame) => {
          try {
            return frame.contentDocument?.body?.innerText ?? '';
          } catch {
            return '';
          }
        }),
      );
      const toasts = await window.locator('[role="alert"], .error-toast, .toast').allInnerTexts();
      return [...texts, ...toasts].find((text) => /Failed to load url|\.stacki\/canvas\/|can.t be shown/i.test(text));
    };
    // Watches for the error for a bounded time; a wait that runs out without it is the pass.
    const watch = async (scenario) => {
      const found = await waitForState({
        what: `${scenario}: an error appears`,
        read: failure,
        until: (text) => text !== undefined,
        pollCountMax: WATCH_POLLS,
      }).then(
        () => failure(),
        () => undefined,
      );
      results[scenario] = found === undefined ? 'ok' : `error: ${found.slice(0, 300)}`;
      await shot(found === undefined ? `${scenario}.png` : `${scenario}-error.png`);
    };
    const open = async () => {
      await window.locator('[data-rail-id="components"]').click();
      await window.locator('button[aria-label="Options for Button"]').first().click({ force: true });
      await window.getByRole('menuitem', { name: 'Open in canvas' }).click();
      await canvas.locator('stacki-frame').first().waitFor({ timeout: WAIT_MS });
    };
    const close = async () => {
      await window.getByRole('button', { name: 'Close Button canvas' }).click();
      await waitForState({
        what: 'the canvas closed',
        read: () => window.locator('.component-canvas-popup, [data-testid="component-canvas-panel"]').count(),
        until: (count) => count === 0,
        pollCountMax: POLLS_MAX,
      });
    };

    // 1. Open and close.
    await open();
    await close();
    await watch('1-close');
    // 2. Close right after an edit (a split switch rewrites the page) and while it reloads.
    await open();
    await window.getByRole('switch', { name: 'Give each value of emphasis its own frame' }).click();
    await close();
    await watch('2-close-after-edit');
    // 3. Project files change while the canvas is open, then close.
    await open();
    fs.appendFileSync(path.join(project, 'src/styles/global.css'), '\n/* changed while the canvas is open */\n');
    fs.writeFileSync(path.join(project, 'src/components/Extra.astro'), '<p class="extra">Extra</p>\n');
    await close();
    await watch('3-close-with-file-changes');
    // 4. Leave by opening another page from the Pages panel instead of Close.
    await open();
    await window.locator('[data-rail-id="pages"]').click();
    await window.locator('.panel-section .list-item', { hasText: 'Example Components' }).first().click();
    await waitForState({
      what: 'the canvas closed by navigating away',
      read: () => window.getByRole('button', { name: 'Close Button canvas' }).count(),
      until: (count) => count === 0,
      pollCountMax: POLLS_MAX,
    });
    await watch('4-leave-by-pages-panel');
    // 5. Reopen after all of that, then close.
    await open();
    results.reopenFrames = await canvas.locator('stacki-frame').count();
    await close();
    await watch('5-reopen-close');
    results.canvasFilesLeft = canvasFiles();
    // 6. A component the closed canvas showed changes afterwards (an editor, an AI agent): its HMR update must not reach
    // the closed canvas's page.
    const touch = () => fs.appendFileSync(path.join(project, 'src/components/Button.astro'), '\n<!-- touched -->\n');
    await open();
    await close();
    touch();
    await watch('6-component-changes-after-close');
    // 7. The next canvas deletes the retired pages; a component changing after that must not reach them either.
    await open();
    await close();
    touch();
    await watch('7-component-changes-after-sweep');
    // 8. Last, what closing used to do: delete the page at once, then a component it showed changes. The reported error.
    await open();
    await close();
    for (const name of canvasFiles()) {
      fs.rmSync(path.join(project, '.stacki/canvas', name));
    }
    touch();
    await watch('8-old-delete-then-component-changes');
  } catch (error) {
    results.error = String(error && error.stack ? error.stack : error);
    await shot('error.png').catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
  }
  console.log(`RESULT ${JSON.stringify(results, undefined, 2)}`);
  console.log(`Screenshots: ${SHOTS}`);
})();
