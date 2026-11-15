// Goal: the style-panel soak (stylePanelSoak.test.js) never leaves a process behind. Its
// cleanup layers live in test/helpers/e2e/soakProcesses.js (stop, registry, reaper) and
// soakWatchdog.js (children exit when the runner dies); this suite holds each one.
// Method: the pure parts (ps parsing, the run-directory match, the stale decision) with fake
// pids and fake tables, including the negative space: a live runner is never reaped, a young
// process without a registry is left alone. Then real processes: Node children that sleep with
// a fake run directory on their command line, reaped when the registry names a dead runner
// and stopped by `stopRun`; and a child carrying the watchdog, which must exit on its own once
// the pid it watches is gone. Every wait is bounded; every spawned process is killed in `after`.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const soak = require('../../helpers/e2e/soakProcesses.js');

const WAIT_MS_MAX = 10000;
// This suite's own folder for fake runs: the reaper is pointed at it, never at the temp folder
// where real soak runs (anyone's) live.
const WITHIN = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'stacki-soak-reaper-test-'));
const POLL_MS = 100;
const spawned = [];

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition) {
  for (let waitedMs = 0; waitedMs < WAIT_MS_MAX; waitedMs += POLL_MS) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return condition();
}

// A fake run directory with a registry naming `runnerPid`.
function fakeRun(runnerPid) {
  const directory = fs.mkdtempSync(path.join(WITHIN, soak.RUN_DIRECTORY_PREFIX));
  fs.writeFileSync(path.join(directory, soak.REGISTRY_FILE), JSON.stringify({ runnerPid, startedAt: Date.now() }));
  return directory;
}

// A Node child that sleeps, with `directory` on its command line like a soak child's.
function sleeper(directory, env = {}) {
  const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `${directory}/project/node_modules/astro/bin/astro.mjs`], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  spawned.push(child.pid);
  return child;
}

// The pid of a process that has already exited.
function deadPid() {
  const finished = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const pid = Number(finished.stdout);
  assert.ok(Number.isSafeInteger(pid));
  assert.equal(alive(pid), false, 'the pid is gone');
  return pid;
}

after(() => {
  fs.rmSync(WITHIN, { recursive: true, force: true });
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

test('ps elapsed times and rows parse, and junk does not', () => {
  assert.equal(soak.parseElapsed('05:07'), 307000);
  assert.equal(soak.parseElapsed('01:02:03'), 3723000);
  assert.equal(soak.parseElapsed('2-00:00:01'), 172801000);
  assert.equal(soak.parseElapsed('soon'), undefined);
  const rows = soak.parseProcessTable(['  101     1   10:00 node /tmp/stacki-style-soak-AbC123/project/x.mjs dev', 'garbage', ' 7 1 00:01 sh'].join('\n'));
  assert.deepEqual(rows, [
    { pid: 101, ppid: 1, ageMs: 600000, command: 'node /tmp/stacki-style-soak-AbC123/project/x.mjs dev' },
    { pid: 7, ppid: 1, ageMs: 1000, command: 'sh' },
  ]);
});

test('the run directory is read from a command line, and only a soak one', () => {
  assert.equal(soak.runDirectoryOf('node /private/var/T/stacki-style-soak-Xy9/project/a.mjs'), '/private/var/T/stacki-style-soak-Xy9');
  assert.equal(soak.runDirectoryOf('electron entry.js --soak-run=/tmp/stacki-style-soak-Q1'), '/tmp/stacki-style-soak-Q1');
  assert.equal(soak.runDirectoryOf('node /tmp/some-other-dir/a.mjs'), undefined);
});

test('stale means a dead runner, or no registry and older than the bound', () => {
  const young = { pid: 5, ppid: 1, ageMs: 1000, command: '' };
  const old = { pid: 6, ppid: 1, ageMs: 3600000, command: '' };
  assert.equal(soak.isStale({ process: young, registry: { runnerPid: 9 }, runnerAlive: false, olderThanMs: 600000 }), true);
  assert.equal(soak.isStale({ process: old, registry: { runnerPid: 9 }, runnerAlive: true, olderThanMs: 600000 }), false, 'a live run is never reaped');
  assert.equal(soak.isStale({ process: young, registry: undefined, runnerAlive: false, olderThanMs: 600000 }), false);
  assert.equal(soak.isStale({ process: old, registry: undefined, runnerAlive: false, olderThanMs: 600000 }), true);
});

test('the reaper kills a real soak process whose runner is dead and spares a live run', async () => {
  const orphanRun = fakeRun(deadPid());
  const liveRun = fakeRun(process.pid);
  const orphan = sleeper(orphanRun);
  const kept = sleeper(liveRun);
  assert.ok(await waitUntil(() => soak.processesOfRun(orphanRun).length > 0), 'the orphan is listed');
  const reaped = await soak.reapStaleSoakServers({ olderThanMs: 24 * 3600 * 1000, within: WITHIN });
  assert.ok(reaped.includes(orphan.pid), `reaped ${reaped.join(', ')}`);
  assert.ok(await waitUntil(() => !alive(orphan.pid)), 'the orphan is gone');
  assert.equal(alive(kept.pid), true, 'the live run is untouched');
  assert.deepEqual(await soak.stopRun(liveRun), [], 'stopRun leaves nothing');
  assert.ok(await waitUntil(() => !alive(kept.pid)));
  assert.deepEqual(soak.processesOfRun(liveRun), []);
  fs.rmSync(orphanRun, { recursive: true, force: true });
  fs.rmSync(liveRun, { recursive: true, force: true });
});

test('a child carrying the watchdog exits once its runner is gone', async () => {
  // The "runner" is a sleeping process this test kills; the child watches it.
  const runner = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  spawned.push(runner.pid);
  const run = fakeRun(runner.pid);
  const child = sleeper(run, { STACKI_SOAK_RUNNER_PID: String(runner.pid), NODE_OPTIONS: soak.watchdogOptions(undefined) });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(alive(child.pid), true, 'it keeps running while the runner lives');
  runner.kill('SIGKILL');
  assert.ok(await waitUntil(() => !alive(child.pid)), 'it exits after the runner dies');
  fs.rmSync(run, { recursive: true, force: true });
});

test('the reaper removes a stale run directory and keeps a live one', async () => {
  const stale = fakeRun(deadPid());
  const live = fakeRun(process.pid);
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(stale, hourAgo, hourAgo);
  fs.utimesSync(live, hourAgo, hourAgo);
  await soak.reapStaleSoakServers({ olderThanMs: 60 * 1000, within: WITHIN });
  assert.equal(fs.existsSync(stale), false, 'the dead run directory is gone');
  assert.equal(fs.existsSync(live), true, 'the live run directory stays');
  fs.rmSync(live, { recursive: true, force: true });
});
