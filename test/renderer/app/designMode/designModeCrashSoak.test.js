// Goal: a crash in the middle of Design mode leaves nothing that lasts. The app is killed outright (SIGKILL) while the
// window is on the sandbox copy with its dev server running; started again, it stops whatever still runs in the copy
// and deletes the copy, with the `.env` it holds; the project is byte-identical throughout; and the app opens the
// project itself, with Design mode's fence down.
//
// Method: two real launches of the desktop app, hidden, sharing one temporary user data folder and one copy of the
// fixture project (test/helpers/e2e), with the mock keychain. The first enters Design mode by a real press, records
// the processes running inside the copy, and kills its own main process with SIGKILL. No watchdog is attached to the
// dev server, so nothing but the app stops it. The second launch waits for the copy to go. Processes are found by the
// rule the sweep itself uses (designLeftovers.ts). It presses the button with the real pointer, so it runs on macOS
// only, and skips where the fixture's Astro install or the built main process is missing; stopping a leftover server
// and deleting its copy are held on all three systems by designLeftovers.test.ts. Run it by hand with
// `node test/renderer/app/designMode/designModeCrashSoak.test.js`.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WAIT_MS_MAX = 90_000;
const POLL_MS = 200;
const RUN_MS_MAX = 150_000;
const TREE_FILES_MAX = 50_000;

/** The processes that run from the copy at `root`, this one and what started it left out. */
async function processesIn(root) {
  const { leftoverProcesses, listProcesses } = require('#dist/electron/handlers/designMode/designLeftovers.js');
  const where = { roots: [root], platform: process.platform, ownPid: process.pid, ownProgram: process.execPath };
  return leftoverProcesses(await listProcesses(), where).map((found) => ({ pid: found.pid, command: found.commandLine.slice(0, 200) }));
}

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

async function orchestrate() {
  const { cloneModules, copySite, removeWithRetries, soakUnavailableReason, startRendererServer } = require('../../../helpers/e2e/soakLaunch.js');
  const { RUN_DIRECTORY_PREFIX, stopRun, writeRegistry } = require('../../../helpers/e2e/soakProcesses.js');
  // It drives the real pointer, so like every pointer probe it runs on macOS only (docs/release-runbook.md).
  const unavailable = process.platform === 'darwin' ? soakUnavailableReason() : 'a pointer probe, macOS only';
  if (unavailable !== undefined) {
    console.log(`# skip designModeCrashSoak: ${unavailable}`);
    return;
  }
  const { ROOT, repoPath } = require('../../../helpers/sources.js');
  const { pollUntil } = require('../../../helpers/waitFor.js');
  const failures = [];
  let checked = 0;
  const check = (what, condition, detail) => {
    checked += 1;
    console.log(`CHECK ${condition ? 'pass' : 'FAIL'} ${what}${condition ? '' : ` ${String(detail).slice(0, 400)}`}`);
    if (!condition) {
      failures.push(what);
    }
  };
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), RUN_DIRECTORY_PREFIX));
  writeRegistry(directory);
  const project = path.join(directory, 'project');
  const userData = path.join(directory, 'user-data');
  const note = path.join(directory, 'crash-note.json');
  let server;
  try {
    fs.mkdirSync(userData, { recursive: true });
    copySite(project);
    cloneModules(project);
    fs.writeFileSync(path.join(project, '.env'), 'SECRET=kept-in-the-project\n');
    const renderer = await startRendererServer(ROOT, directory, { preTransformRequests: true });
    server = renderer.server;
    const launch = (phase) => {
      const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };
      delete env.ELECTRON_RUN_AS_NODE;
      env.VITE_DEV_SERVER_URL = renderer.url;
      env.STACKI_SOAK_PROJECT = project;
      env.STACKI_SOAK_USER_DATA = userData;
      env.STACKI_SOAK_SCENARIO = __filename;
      env.STACKI_SOAK_OPTIONS = JSON.stringify({ phase, note });
      env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ''}`;
      return new Promise((resolve) => {
        const child = childProcess.spawn(require('electron'), [repoPath('test/helpers/e2e/electronEntry.js'), `--soak-run=${directory}`], {
          cwd: ROOT,
          env,
          stdio: 'inherit',
          detached: true,
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), RUN_MS_MAX);
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });
    };
    const before = treeDigest(project);
    const crashed = await launch('crash');
    check('the app was killed outright, mid session', crashed.signal === 'SIGKILL' && fs.existsSync(note), JSON.stringify(crashed));
    const kept = JSON.parse(fs.readFileSync(note, 'utf8'));
    const sandboxes = path.join(userData, 'design-sandboxes');
    // Up to three seconds for what the app started to end with it: the number is a note, the checks come after the restart.
    const { value: orphans } = await pollUntil({
      read: () => processesIn(kept.sandboxRoot),
      until: (found) => found.length === 0,
      what: 'the processes of the copy to end',
      pollIntervalMs: 100,
      pollCountMax: 30,
    });
    console.log(`NOTE running in the copy before the crash ${kept.running.length}, still running after up to 3 s ${orphans.length}`);
    check('the crash left the copy behind, which is what the next start must clean up', fs.readdirSync(sandboxes).length === 1);
    check('the project is byte-identical after the crash', treeDigest(project) === before);
    const after = await launch('after');
    check('the app starts again and finds the copy gone', after.code === 0, JSON.stringify(after));
    check('no copy and no .env of it is left', !fs.existsSync(sandboxes) || fs.readdirSync(sandboxes).length === 0);
    const left = await processesIn(kept.sandboxRoot);
    check('nothing still runs in the deleted copy', left.length === 0, JSON.stringify(left));
    const allDead = kept.running.every((pid) => !left.some((found) => found.pid === pid));
    check('every process seen in the copy is gone', allDead);
    check('the project is byte-identical after everything, with its .env', treeDigest(project) === before);
  } finally {
    const leftovers = await stopRun(directory);
    if (server !== undefined) {
      await server.close();
    }
    await removeWithRetries(directory);
    check('the run left no process behind', leftovers.length === 0, leftovers.join(', '));
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(`ok - ${checked} checks: a crash in Design mode leaves nothing behind after the next start`);
  }
}

async function runInElectron({ window, project, options }) {
  const { app } = require('electron');
  const { createDriver } = require('../../../helpers/e2e/soakDriver.js');
  const { installRecorder } = require('../../../helpers/e2e/panelRecorder.js');
  const { waitFor } = require('../../../helpers/waitFor.js');
  const { designFenceState } = require('#dist/electron/lib/designMode/designFence.js');
  const driver = createDriver(window, project);
  const until = (what, read) => waitFor({ what, read, until: Boolean, pollIntervalMs: POLL_MS, pollCountMax: WAIT_MS_MAX / POLL_MS });
  const evaluate = (source) => driver.evaluate(source).catch(() => undefined);
  await driver.waitForApp();
  await driver.setPageFocus('focused');
  await installRecorder(driver.contents);
  if (options.phase === 'after') {
    const sandboxes = path.join(app.getPath('userData'), 'design-sandboxes');
    await until('the copy swept', async () => !fs.existsSync(sandboxes) || fs.readdirSync(sandboxes).length === 0);
    if (designFenceState().kind !== 'off') {
      return 1;
    }
    const mode = await evaluate(`!!document.querySelector('.dm-bar')`);
    return mode === false ? 0 : 1;
  }
  await driver.settle();
  await evaluate(
    `document.querySelector('.ai-mode-button') ? 0 : ([...document.querySelectorAll('.rail button')].find((b) => /AI/.test(b.getAttribute('aria-label') || ''))?.click(), 0)`,
  );
  const button = await until('the Design mode button', () =>
    evaluate(
      `(() => { const b = [...document.querySelectorAll('.ai-header .ai-mode-button')].find((x) => /design mode/i.test(x.getAttribute('aria-label') || '')); if (!b) return undefined; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    ),
  );
  await driver.pointerPress(button);
  await until('the canvas on the copy', () => evaluate(`!!document.querySelector('.dm-bar') && !document.querySelector('.dm-status')`));
  await driver.waitForApp();
  await until('the copy’s page live', () => driver.canvasEvaluate(`!!document.querySelector('#soak-plain')`).catch(() => false));
  const fence = designFenceState();
  const running = (await processesIn(fence.sandboxRoot)).map((found) => found.pid);
  fs.writeFileSync(options.note, JSON.stringify({ sandboxRoot: fence.sandboxRoot, running }));
  process.kill(process.pid, 'SIGKILL');
  return 1;
}

module.exports = { runInElectron };

if (process.versions.electron === undefined) {
  orchestrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
