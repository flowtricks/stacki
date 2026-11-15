// Goal: adding EmDash to an existing Astro project does exactly what EmDash's own guide says and no more, and never does
// it unseen. The plan names the exact command and every file that can change; a run needs the command that was shown
// (anything else is refused and nothing runs); unsaved work is first saved as one commit named "Before Adding EmDash",
// and a failed save installs nothing; the command is a fixed program with an argument array (no shell, no project or
// renderer string in it), run in the project folder with a time bound and a cancel; a failure or a cancel names the
// files that changed and reverts none; success is claimed only after detection re-reads the project; Stacki writes
// src/live.config.ts only when the project has none, and appends only the missing .gitignore lines; the key command runs
// only when there is no .env and its output is never logged; and failures read as one of the named reasons.
// Method: a copy of test/fixtures/emdash/site with the EmDash pieces removed, in a temporary folder (never a real
// project), and an injected fake runner, commit and git state in place of processes, so every call's program, arguments,
// working folder and options can be asserted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');
const { addArguments, cancelEmDashInstall, installCommandText, planEmDashInstall, runEmDashInstall } = require('#dist/electron/handlers/emdashInstall.js');
const shared = require('#dist/shared/properties/emdashInstall.js');
const { detectEmDash } = require('#dist/electron/content/emdashProject.js');
const { RUN_CANCELLED } = require('#dist/electron/project/starter.js');

const FIXTURE = repoPath('test/fixtures/emdash/site');

// An Astro 6 project with no EmDash in it, in a folder of its own.
function plainProject(extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-emdash-install-')));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'site', dependencies: { astro: '^6.0.0' }, ...extra }, null, 2));
  fs.writeFileSync(path.join(root, 'astro.config.mjs'), 'import { defineConfig } from "astro/config";\nexport default defineConfig({});\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  return root;
}

// A runner that records what it was asked and, for the package command, performs what the real one would on disk.
function fakes(root, options = {}) {
  const calls = [];
  const commits = [];
  const deps = {
    runCommand: async (program, args, cwd, onLog, runOptions) => {
      calls.push({ program, args: [...args], cwd, options: runOptions });
      onLog(`ran ${program}\n`);
      if (options.fail !== undefined && args[0] !== 'emdash') {
        throw new Error(options.fail);
      }
      if (options.wait !== undefined && args[0] !== 'emdash') {
        await new Promise((resolve, reject) => {
          options.wait.release = resolve;
          runOptions.signal.addEventListener('abort', () => reject(new Error(RUN_CANCELLED)), { once: true });
        });
      }
      if (args[0] === 'install' || args[0] === 'add') {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        manifest.dependencies = { ...manifest.dependencies, emdash: '^1.5.0' };
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2));
      }
      if (args[0] === 'emdash') {
        if (options.keyFails === true) {
          throw new Error('no key');
        }
        fs.writeFileSync(path.join(root, '.env'), 'EMDASH_ENCRYPTION_KEY=generated-by-emdash\n');
      }
      return '';
    },
    gitDirty: async () => options.dirty,
    commitAll: async (cwd, message) => {
      commits.push({ cwd, message });
      if (options.commitFails === true) {
        throw new Error('Author identity unknown');
      }
    },
    detect: detectEmDash,
  };
  return { deps, calls, commits };
}

const run = (root, deps, logs = [], command = undefined) =>
  runEmDashInstall(root, { confirmedCommand: command ?? installCommandText('npm'), deps, onLog: (text) => logs.push(text) });

test('the plan names the exact command and every file that can change, for a clean project', async () => {
  const root = plainProject();
  const plan = await planEmDashInstall(root, fakes(root).deps);
  assert.equal(plan.kind, 'ready');
  assert.equal(plan.manager, 'npm');
  assert.equal(plan.command, 'npm install emdash @astrojs/node @astrojs/react react react-dom --no-audit --no-fund');
  assert.deepEqual(plan.files, [
    { path: 'package.json', change: 'edit' },
    { path: 'package-lock.json', change: 'edit' },
    { path: 'astro.config.mjs', change: 'edit' },
    { path: 'src/live.config.ts', change: 'create' },
    { path: '.gitignore', change: 'create' },
  ]);
  assert.equal(plan.saveFirst, false, 'a clean tree needs no save');
  assert.deepEqual(shared.parseEmDashInstallPlan(plan), plan, 'the plan passes its own parser');
});

test('each package manager gets its own add command, from fixed package names', () => {
  assert.deepEqual(addArguments('npm').slice(0, 6), ['install', ...shared.EMDASH_PACKAGES]);
  assert.equal(addArguments('pnpm')[0], 'add');
  assert.equal(addArguments('yarn')[0], 'add');
  assert.equal(addArguments('bun')[0], 'add');
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
    for (const argument of addArguments(manager)) {
      assert.doesNotMatch(argument, /[\s;&|`$<>"']/, `${manager}: no shell syntax in ${argument}`);
    }
  }
});

test('a project that is not ready is refused with the reason, and nothing is planned', async () => {
  const noManifest = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-emdash-install-')));
  assert.deepEqual(await planEmDashInstall(noManifest, fakes(noManifest).deps), { kind: 'unavailable', reason: 'noPackageJson' });
  const notAstro = plainProject({ dependencies: { vite: '^6.0.0' } });
  assert.deepEqual(await planEmDashInstall(notAstro, fakes(notAstro).deps), { kind: 'unavailable', reason: 'notAstro' });
  const old = plainProject({ dependencies: { astro: '^5.2.0' } });
  assert.deepEqual(await planEmDashInstall(old, fakes(old).deps), { kind: 'unavailable', reason: 'astroTooOld' });
  const has = plainProject({ dependencies: { astro: '^6.0.0', emdash: '^1.0.0' } });
  assert.deepEqual(await planEmDashInstall(has, fakes(has).deps), { kind: 'unavailable', reason: 'alreadyInstalled' });
});

test('an existing live config is never overwritten, and the step is named; an existing adapter is warned about', async () => {
  const root = plainProject();
  fs.writeFileSync(path.join(root, 'src', 'live.config.ts'), 'export const collections = {};\n');
  fs.writeFileSync(path.join(root, 'astro.config.mjs'), 'export default { adapter: vercel() };\n');
  const plan = await planEmDashInstall(root, fakes(root).deps);
  assert.ok(!plan.files.some((file) => file.path === 'src/live.config.ts'), 'not in the files that change');
  assert.deepEqual(plan.warnings, ['otherAdapter']);
});

test('a project with no Astro config gets the guide’s complete one; a different adapter is left alone and named', async () => {
  const bare = plainProject();
  fs.rmSync(path.join(bare, 'astro.config.mjs'));
  const created = await run(bare, fakes(bare).deps);
  assert.equal(created.config, 'created');
  assert.equal(fs.readFileSync(path.join(bare, 'astro.config.mjs'), 'utf8'), require('#dist/electron/parse/emdashConfig.js').newEmDashConfig());
  assert.equal(created.complete, true);
  const other = plainProject();
  const original = 'import vercel from "@astrojs/vercel";\nexport default { adapter: vercel() };\n';
  fs.writeFileSync(path.join(other, 'astro.config.mjs'), original);
  const kept = await run(other, fakes(other).deps);
  assert.equal(kept.config, 'otherAdapter');
  assert.equal(fs.readFileSync(path.join(other, 'astro.config.mjs'), 'utf8'), original, 'byte for byte as it was');
  assert.equal(kept.complete, false, 'not claimed done');
  assert.ok(kept.manual.includes('astroConfig'), 'the one remaining step is named');
  const odd = plainProject();
  fs.writeFileSync(path.join(odd, 'astro.config.mjs'), 'export default makeConfig();\n');
  assert.equal((await run(odd, fakes(odd).deps)).config, 'unusualShape');
});

test('nothing runs without the command that was shown: a different or empty confirmation is refused', async () => {
  const root = plainProject();
  const { deps, calls, commits } = fakes(root, { dirty: true });
  assert.deepEqual(await run(root, deps, [], 'npm install something-else'), { kind: 'refused', reason: 'notConfirmed' });
  assert.deepEqual(await run(root, deps, [], ''), { kind: 'refused', reason: 'notConfirmed' });
  assert.equal(calls.length, 0);
  assert.equal(commits.length, 0, 'not even the save runs');
});

test('a clean project: one install run, in the project folder, no shell, bounded in time, then detection, and no commit', async () => {
  const root = plainProject();
  const { deps, calls, commits } = fakes(root, { dirty: false });
  const logs = [];
  const result = await run(root, deps, logs);
  assert.equal(commits.length, 0);
  assert.equal(calls[0].cwd, root);
  assert.equal(calls[0].program, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  assert.deepEqual(calls[0].args, [...addArguments('npm')]);
  assert.equal(calls[0].options.timeoutMs, shared.EMDASH_INSTALL_LIMITS.runMsMax);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.kind, 'installed');
  assert.equal(result.saved, false);
  assert.equal(result.config, 'merged', 'the config is edited for the person');
  assert.equal(result.onDemand, true, 'and the site now renders on request');
  assert.equal(result.complete, true, 'claimed only because detection found it wired');
  assert.deepEqual(result.manual, []);
  assert.equal(result.project.kind, 'present');
  assert.ok(!result.project.problems.includes('noIntegration'));
  assert.ok(
    logs.some((text) => text.includes('npm install emdash')),
    'the command is the first line of the log',
  );
  assert.deepEqual(shared.parseEmDashInstallResult(result), result);
});

test('what Stacki writes itself: the live config when there is none, the missing ignore lines only, and the key once', async () => {
  const root = plainProject();
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n.env');
  const { deps, calls } = fakes(root);
  const result = await run(root, deps);
  assert.equal(fs.readFileSync(path.join(root, 'src/live.config.ts'), 'utf8'), shared.EMDASH_LIVE_CONFIG_TEXT);
  assert.equal(
    fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
    'node_modules\n.env\ndata.db\nuploads/\n',
    'appended on its own line, .env not repeated',
  );
  assert.deepEqual(result.changedFiles.sort(), ['.env', '.gitignore', 'astro.config.mjs', 'package.json', 'src/live.config.ts']);
  const key = calls[1];
  assert.equal(key.program, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  assert.deepEqual(key.args, [...shared.EMDASH_SECRETS_ARGUMENTS]);
  assert.equal(key.cwd, root);
  assert.equal(result.keyGenerated, true);
  assert.ok(!result.changedFiles.includes('package-lock.json'));
});

test('the key command is skipped when a .env exists, never logged, and a failure of it does not fail the install', async () => {
  const withEnv = plainProject();
  fs.writeFileSync(path.join(withEnv, '.env'), 'EXISTING=1\n');
  const first = fakes(withEnv);
  const done = await run(withEnv, first.deps);
  assert.equal(first.calls.length, 1, 'only the package command');
  assert.equal(done.keyGenerated, false);
  assert.equal(fs.readFileSync(path.join(withEnv, '.env'), 'utf8'), 'EXISTING=1\n', 'the existing .env is untouched');
  const root = plainProject();
  const second = fakes(root, { keyFails: true });
  const logs = [];
  const result = await run(root, second.deps, logs);
  assert.equal(result.kind, 'installed');
  assert.equal(result.keyGenerated, false);
  assert.ok(!logs.some((text) => /generated|KEY|ran npx/.test(text)), 'the key command writes no log');
});

test('unsaved work is saved first as one commit named exactly "Before Adding EmDash", then the install runs', async () => {
  const root = plainProject();
  const order = [];
  const { deps, calls, commits } = fakes(root, { dirty: true });
  const commitAll = deps.commitAll;
  deps.commitAll = async (cwd, message) => {
    order.push('commit');
    await commitAll(cwd, message);
  };
  const runCommand = deps.runCommand;
  deps.runCommand = async (...args) => {
    order.push('run');
    return runCommand(...args);
  };
  const plan = await planEmDashInstall(root, deps);
  assert.equal(plan.saveFirst, true);
  const result = await run(root, deps);
  assert.deepEqual(commits, [{ cwd: root, message: 'Before Adding EmDash' }]);
  assert.equal(shared.EMDASH_SAVE_MESSAGE, 'Before Adding EmDash');
  assert.deepEqual(order.slice(0, 2), ['commit', 'run']);
  assert.equal(calls.length >= 1, true);
  assert.equal(result.saved, true);
});

test('when the save fails nothing is installed and no file changes', async () => {
  const root = plainProject();
  const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const { deps, calls } = fakes(root, { dirty: true, commitFails: true });
  const result = await run(root, deps);
  assert.deepEqual(result, { kind: 'failed', reason: 'saveFailed', changedFiles: [] });
  assert.equal(calls.length, 0, 'never installs on a failed save');
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  // And a project outside git (the answer is unknown) is simply not saved.
  const outside = fakes(root, { dirty: undefined });
  assert.equal((await planEmDashInstall(root, outside.deps)).saveFirst, false);
});

test('a failure names its reason, lists the changed files and reverts none; the next run is allowed', async () => {
  const root = plainProject();
  const { deps } = fakes(root, { fail: 'npm error code ERESOLVE\nnpm error unable to resolve dependency tree' });
  const result = await run(root, deps);
  assert.equal(result.kind, 'failed');
  assert.equal(result.reason, 'peerConflict');
  assert.deepEqual(result.changedFiles, []);
  const again = fakes(root);
  assert.equal((await run(root, again.deps)).kind, 'installed', 'the busy flag was cleared');
});

test('cancel stops the run through its abort signal, says what changed, and clears the busy state', async () => {
  const root = plainProject();
  const wait = {};
  const { deps } = fakes(root, { wait });
  const pending = run(root, deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await run(root, fakes(root).deps), { kind: 'refused', reason: 'busy' }, 'one run at a time');
  cancelEmDashInstall(root);
  const result = await pending;
  assert.deepEqual(result, { kind: 'cancelled', changedFiles: [] });
  cancelEmDashInstall(root); // Idempotent: nothing is running.
});

test('the failure reasons are read from what the command printed', () => {
  const cases = [
    ['npm error code ENOTFOUND registry.npmjs.org', 'noNetwork'],
    ['getaddrinfo EAI_AGAIN', 'noNetwork'],
    ['npm ERR! ERESOLVE could not resolve', 'peerConflict'],
    ['npm warn EBADENGINE Unsupported engine', 'engineMismatch'],
    ['EACCES: permission denied, open package.json', 'permission'],
    ['npm could not be found. Install Node.js', 'managerMissing'],
    ['npm install took over 10 minutes and was stopped.', 'timeout'],
    ['something nobody expected', 'other'],
    ['', 'other'],
  ];
  for (const [output, reason] of cases) {
    assert.equal(shared.classifyInstallFailure(output), reason, output);
  }
});

test('the log is bounded: older text is dropped from the front', () => {
  let log = '';
  for (let index = 0; index < 50; index += 1) {
    log = shared.appendInstallLog(log, 'x'.repeat(2000));
  }
  assert.equal(log.length, shared.EMDASH_INSTALL_LIMITS.logCharsMax);
  assert.equal(shared.appendInstallLog('abc', 'def'), 'abcdef');
});

test('the contract parsers accept what main sends and refuse the rest', () => {
  assert.throws(() => shared.parseEmDashInstallPlan({ kind: 'ready' }), /unknown package manager/);
  assert.throws(() => shared.parseEmDashInstallPlan({ kind: 'unavailable', reason: 'because' }), /unknown refusal/);
  assert.throws(() => shared.parseEmDashInstallResult({ kind: 'failed', reason: 'because', changedFiles: [] }), /unknown failure/);
  assert.throws(() => shared.parseEmDashInstallResult({ kind: 'done' }), /unknown result/);
  assert.throws(() => shared.parseEmDashInstallResult('installed'), /Expected/);
  assert.throws(() => shared.parseEmDashInstallResult({ kind: 'cancelled', changedFiles: Array.from({ length: 40 }, (_, index) => `f${index}`) }), /too many/);
  assert.deepEqual(shared.parseEmDashInstallResult({ kind: 'cancelled', changedFiles: ['package.json'] }), {
    kind: 'cancelled',
    changedFiles: ['package.json'],
  });
  assert.ok(fs.existsSync(FIXTURE));
});
