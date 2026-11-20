// Goal: the Electron probe launcher (test/helpers/electronProbe.js) launches again only a probe
// that never started, because Chromium could not reach the display, and returns every other
// outcome at once: a probe that printed anything, failed with another message, or failed after
// starting is never retried away. Launches are bounded.
// Side by side (runElectronProbesTogether), the probes run at the same time, come back in the order given,
// and each is bounded and retried on its own.
// Method: an injected spawn replays scripted spawnSync results; the outcomes and the number of
// launches are pinned. Chromium's real stderr lines from the failing Check run are the fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROBE_LIMITS, launchNeverStarted, runElectronProbe, runElectronProbesTogether } = require('../../helpers/electronProbe.js');

const UNREACHABLE = {
  status: 1,
  stdout: '',
  stderr:
    '[6113:1119/005453.089479:ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc:257] Missing X server or $DISPLAY\n' +
    '[6113:1119/005453.089516:ERROR:ui/aura/env.cc:246] The platform failed to initialize.  Exiting.\n',
};
const RESULT = { status: 0, stdout: '{"rest":{}}\n', stderr: '' };

const scripted = (results) => {
  const launches = [];
  const spawn = (command, argumentsList, options) => {
    launches.push({ command, argumentsList, options });
    const next = results[Math.min(launches.length - 1, results.length - 1)];
    return next;
  };
  return { launches, spawn };
};

test('a launch that could not reach the display is tried again, and the next result is returned', () => {
  const { launches, spawn } = scripted([UNREACHABLE, RESULT]);
  const run = runElectronProbe('/electron', ['/probe.js'], { spawn });
  assert.equal(run.stdout, RESULT.stdout);
  assert.equal(run.launchAttempts, 2);
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0].argumentsList, ['/probe.js']);
  assert.equal(launches[0].options.encoding, 'utf8');
});

test('launches are bounded: a display that never answers ends with its own message', () => {
  const { launches, spawn } = scripted([UNREACHABLE]);
  const run = runElectronProbe('/electron', ['/probe.js'], { spawn });
  assert.equal(launches.length, PROBE_LIMITS.launchAttemptsMax);
  assert.equal(run.launchAttempts, PROBE_LIMITS.launchAttemptsMax);
  assert.match(run.stderr, /Missing X server/);
});

test('every other outcome is returned at once: a probe that ran is never launched again', () => {
  const ranAndFailed = { status: 1, stdout: '', stderr: 'probe failed: TypeError: x is undefined' };
  const printedThenDied = { status: 1, stdout: '{"partial":true}\n', stderr: UNREACHABLE.stderr };
  for (const outcome of [RESULT, ranAndFailed, printedThenDied, { status: undefined, stdout: '', stderr: '', error: new Error('ETIMEDOUT') }]) {
    const { launches, spawn } = scripted([outcome]);
    const run = runElectronProbe('/electron', ['/probe.js'], { spawn });
    assert.equal(launches.length, 1, JSON.stringify(outcome));
    assert.equal(run.launchAttempts, 1);
  }
  assert.equal(launchNeverStarted(UNREACHABLE), true);
  assert.equal(launchNeverStarted(printedThenDied), false, 'output means the probe started');
  assert.equal(launchNeverStarted(ranAndFailed), false);
});

test('misuse is refused', () => {
  assert.throws(() => runElectronProbe('', ['/probe.js']), /needs the Electron binary path/);
  assert.throws(() => runElectronProbe('/electron', []), /needs the probe script/);
  assert.throws(() => launchNeverStarted(undefined), /takes a spawnSync result/);
});

test('probes run side by side, results come back in order, and each is retried on its own', async () => {
  const launched = [];
  let running = 0;
  let runningMax = 0;
  const attempts = new Map();
  const launch = async (command, argumentsList) => {
    launched.push({ command, argumentsList });
    running += 1;
    runningMax = Math.max(runningMax, running);
    // Yield, so that probes started together are all running before any ends.
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    const name = argumentsList[0];
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    if (name === '/second.js' && attempt === 1) {
      return UNREACHABLE;
    }
    return { status: 0, stdout: `RESULT ${name}\n`, stderr: '' };
  };
  const runs = await runElectronProbesTogether('/electron', [['/first.js'], ['/second.js'], ['/third.js']], { launch });
  assert.equal(runningMax, 3, 'all three were running at once');
  assert.deepEqual(
    runs.map((run) => run.stdout),
    ['RESULT /first.js\n', 'RESULT /second.js\n', 'RESULT /third.js\n'],
  );
  assert.deepEqual(
    runs.map((run) => run.launchAttempts),
    [1, 2, 1],
  );
  assert.equal(launched.length, 4);
});

test('side by side: a probe that ran and failed is returned at once, and the others still finish', async () => {
  const launch = async (command, argumentsList) =>
    argumentsList[0] === '/bad.js' ? { status: 1, stdout: '', stderr: 'probe failed' } : { status: 0, stdout: 'ok', stderr: '' };
  const runs = await runElectronProbesTogether('/electron', [['/bad.js'], ['/good.js']], { launch });
  assert.equal(runs[0].status, 1);
  assert.equal(runs[0].launchAttempts, 1);
  assert.equal(runs[1].stdout, 'ok');
});

test('side by side: misuse and too many probes are refused', async () => {
  await assert.rejects(runElectronProbesTogether('', [['/p.js']]), /needs the Electron binary path/);
  await assert.rejects(runElectronProbesTogether('/electron', []), /needs at least one probe/);
  await assert.rejects(runElectronProbesTogether('/electron', [[]], { launch: async () => RESULT }), /needs its script/);
  const many = Array.from({ length: PROBE_LIMITS.probesTogetherMax + 1 }, (_, index) => [`/p${index}.js`]);
  await assert.rejects(runElectronProbesTogether('/electron', many, { launch: async () => RESULT }), /bounded by/);
});

test('side by side: the real launcher reports a timeout as an error and a missing binary as an error', async () => {
  const node = process.execPath;
  const slow = await runElectronProbesTogether(node, [['-e', 'setTimeout(() => {}, 60000)']], { timeoutMs: 300 });
  assert.match(String(slow[0].error && slow[0].error.message), /ETIMEDOUT/);
  const missing = await runElectronProbesTogether('/no/such/electron', [['/p.js']], { timeoutMs: 5000 });
  assert.ok(missing[0].error instanceof Error);
  const printed = await runElectronProbesTogether(node, [['-e', 'console.log("RESULT {}")']], { timeoutMs: 20000 });
  assert.equal(printed[0].status, 0);
  assert.equal(printed[0].stdout.trim(), 'RESULT {}');
});
