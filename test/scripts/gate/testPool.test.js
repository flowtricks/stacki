// Goal: the gate's test pool never runs more commands at once than asked,
// reports every outcome in input order, keeps a failure's output, bounds what it
// keeps, and rejects job counts outside its limits.
// It also holds the Electron cap (windowed suites never exceed their own limit while other
// suites keep running), the sweep that leaves no process of a finished command behind, and
// the Dock preload's inertness outside Electron.
// Method: run tiny `node -e` commands through the real pool. Each command marks
// itself running with a file in a shared directory and records how many marks
// it saw, so the highest count observed is the concurrency actually reached.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');
const { parseElectronJobs, parseJobs, runTestPool, withDockPreload, POOL_LIMITS } = require('#dist/scripts/gate/testPool.js');

const node = JSON.stringify(process.execPath);
const options = (jobs) => ({ jobs, cwd: process.cwd(), environment: process.env });

test('the pool never exceeds its job count and keeps input order', async () => {
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-pool-'));
  try {
    const script = [
      "const fs = require('fs'); const path = require('path');",
      `const dir = ${JSON.stringify(marks)}; const me = path.join(dir, String(process.pid));`,
      "fs.writeFileSync(me, '');",
      "const seen = fs.readdirSync(dir).filter((n) => !n.endsWith('.seen')).length;",
      "fs.writeFileSync(me + '.seen', String(seen));",
      'setTimeout(() => fs.rmSync(me), 150);',
    ].join(' ');
    const commands = Array.from({ length: 8 }, (_, index) => ({
      name: `mark-${index}`,
      command: `${node} -e ${JSON.stringify(script)}`,
    }));
    const heard = [];
    const outcomes = await runTestPool(commands, options(3), (outcome) => heard.push(outcome.name));
    const names = commands.map((command) => command.name);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.name),
      names,
    );
    assert.equal(heard.length, 8);
    assert.ok(outcomes.every((outcome) => outcome.passed));
    const seen = fs
      .readdirSync(marks)
      .filter((name) => name.endsWith('.seen'))
      .map((name) => Number(fs.readFileSync(path.join(marks, name), 'utf8')));
    assert.equal(seen.length, 8);
    assert.ok(Math.max(...seen) <= 3, `saw ${Math.max(...seen)} running at once`);
    assert.ok(Math.max(...seen) >= 2, 'the pool actually ran commands side by side');
  } finally {
    fs.rmSync(marks, { recursive: true, force: true });
  }
});

test('a failing command reports failure with its output; arguments skip the shell', async () => {
  const [failing, direct] = await runTestPool(
    [
      { name: 'fails', command: `${node} -e "console.log('why'); process.exit(3)"` },
      { name: 'direct', command: process.execPath, argumentsList: ['-e', 'console.log("a b")'] },
    ],
    options(2),
    () => {},
  );
  assert.equal(failing.passed, false);
  assert.match(failing.output, /why/);
  assert.equal(direct.passed, true);
  assert.equal(direct.output, 'a b\n');
});

test('kept output is bounded to the tail', async () => {
  const size = POOL_LIMITS.outputBytesMax + 1024 * 1024;
  const [outcome] = await runTestPool(
    [
      {
        name: 'loud',
        command: process.execPath,
        argumentsList: ['-e', `process.stdout.write('x'.repeat(${size})); console.log('END')`],
      },
    ],
    options(1),
    () => {},
  );
  assert.equal(outcome.passed, true);
  assert.match(outcome.output, /^\[… \d+ earlier bytes dropped …\]\n/);
  assert.match(outcome.output, /END\n$/);
  assert.ok(Buffer.byteLength(outcome.output) <= POOL_LIMITS.outputBytesMax + 128 * 1024);
});

test('job counts default to one fewer than the CPUs and are bounded', () => {
  assert.equal(parseJobs(undefined, 8), 7);
  assert.equal(parseJobs(undefined, 1), 1);
  assert.equal(parseJobs(undefined, 64), POOL_LIMITS.jobsMax);
  assert.equal(parseJobs('4', 8), 4);
  assert.throws(() => parseJobs('0', 8), /--jobs must be at least 1, got 0/);
  assert.throws(() => parseJobs('17', 8), /--jobs must be at most 16, got 17/);
  assert.throws(() => parseJobs('two', 8), /--jobs expects a whole number/);
  assert.throws(() => parseJobs('1.5', 8), /--jobs expects a whole number/);
});

test('electron commands respect their own cap while other commands keep running', async () => {
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-pool-electron-'));
  try {
    const script = [
      "const fs = require('fs'); const path = require('path');",
      `const dir = ${JSON.stringify(marks)}; const me = path.join(dir, process.argv[1] + '-' + process.pid);`,
      "fs.writeFileSync(me, '');",
      "const seen = fs.readdirSync(dir).filter((n) => n.startsWith('windowed-') && !n.endsWith('.seen')).length;",
      "fs.writeFileSync(me + '.seen', String(seen));",
      'setTimeout(() => fs.rmSync(me), 200);',
    ].join(' ');
    const make = (name, kind) => ({
      name: `${kind}-${name}`,
      command: process.execPath,
      argumentsList: ['-e', script, kind === 'electron' ? 'windowed' : 'plain'],
      ...(kind === 'electron' ? { kind } : {}),
    });
    const commands = [...Array.from({ length: 6 }, (_, index) => make(index, 'electron')), ...Array.from({ length: 4 }, (_, index) => make(index, 'plain'))];
    const outcomes = await runTestPool(commands, { ...options(6), electronJobs: 2 }, () => {});
    assert.ok(outcomes.every((outcome) => outcome.passed));
    const windowed = fs
      .readdirSync(marks)
      .filter((name) => name.startsWith('windowed-') && name.endsWith('.seen'))
      .map((name) => Number(fs.readFileSync(path.join(marks, name), 'utf8')));
    assert.equal(windowed.length, 6);
    assert.ok(Math.max(...windowed) <= 2, `saw ${Math.max(...windowed)} windowed commands at once`);
    assert.equal(fs.readdirSync(marks).filter((name) => name.startsWith('plain-') && name.endsWith('.seen')).length, 4);
  } finally {
    fs.rmSync(marks, { recursive: true, force: true });
  }
});

test('electron job counts default to four, never exceed the jobs, and are bounded', () => {
  assert.equal(parseElectronJobs(undefined, 15), POOL_LIMITS.electronJobsDefault);
  assert.equal(POOL_LIMITS.electronJobsDefault, 4);
  assert.equal(parseElectronJobs(undefined, 2), 2);
  assert.equal(parseElectronJobs('3', 8), 3);
  assert.throws(() => parseElectronJobs('0', 8), /Electron jobs must be at least 1, got 0/);
  assert.throws(() => parseElectronJobs('99', 8), /Electron jobs must be at most 16, got 99/);
  assert.throws(() => parseElectronJobs('x', 8), /--electron-jobs expects a whole number/);
});

test('a finished command leaves no process behind, even one it detached and orphaned', { skip: process.platform === 'win32' }, async () => {
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-pool-orphan-'));
  const pidFile = path.join(marks, 'orphan.pid');
  try {
    // The command starts a long sleeper, records its pid, and exits at once: the orphan the
    // pool's sweep has to find by process group, since its parent is already gone.
    const script = [
      "const { spawn } = require('child_process'); const fs = require('fs');",
      "const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(orphan.pid));`,
      'process.exit(0);',
    ].join(' ');
    const [outcome] = await runTestPool([{ name: 'orphan', command: process.execPath, argumentsList: ['-e', script] }], options(1), () => {});
    assert.equal(outcome.passed, true);
    const orphanPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(orphanPid) && orphanPid > 1);
    // Delivery of SIGKILL is asynchronous; give the kernel a moment before asking whether it is gone.
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try {
        process.kill(orphanPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the orphan outlived its command');
  } finally {
    fs.rmSync(marks, { recursive: true, force: true });
  }
});

test('the Dock preload is added to NODE_OPTIONS with its path quoted, and does nothing outside Electron', () => {
  assert.equal(withDockPreload(undefined, '/a b/hide.js'), '--require "/a b/hide.js"');
  assert.equal(withDockPreload('', '/x.js'), '--require "/x.js"');
  assert.equal(withDockPreload('--max-old-space-size=512', '/x.js'), '--max-old-space-size=512 --require "/x.js"');
  const preload = repoPath('test/helpers/hideDockPreload.js');
  const run = childProcess.spawnSync(process.execPath, ['-e', 'console.log("ran")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: withDockPreload(undefined, preload) },
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, 'ran\n');
  assert.equal(run.stderr, '');
});
