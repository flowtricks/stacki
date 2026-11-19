// Goal: the Electron probe launcher (test/helpers/electronProbe.js) launches again only a probe
// that never started, because Chromium could not reach the display, and returns every other
// outcome at once: a probe that printed anything, failed with another message, or failed after
// starting is never retried away. Launches are bounded.
// Method: an injected spawn replays scripted spawnSync results; the outcomes and the number of
// launches are pinned. Chromium's real stderr lines from the failing Check run are the fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROBE_LIMITS, launchNeverStarted, runElectronProbe } = require('../../helpers/electronProbe.js');

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
