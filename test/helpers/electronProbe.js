// Runs an Electron probe script and tells a probe that never started from one that ran and failed.
//
// Why: on GitHub's Linux runner every Electron suite shares one Xvfb display, and a Chromium that
// cannot open its X connection at launch exits at once with "Missing X server or $DISPLAY" and
// "The platform failed to initialize" (Check on 20293df9: appUiKitElements failed in 0.3 s while
// the Electron suites before and after it in the same shard passed). Nothing of the test ran, so
// the failure says nothing about the code under test. Such a launch is tried again, at most
// PROBE_LIMITS.launchAttemptsMax times in all; any other outcome, a failing probe included, is
// returned at once, so a real failure is never retried away.

const { spawnSync } = require('node:child_process');

const PROBE_LIMITS = Object.freeze({
  // Three launches: the display refusals seen were single, transient ones.
  launchAttemptsMax: 3,
  // Two minutes per launch, as the suites gave spawnSync before.
  launchTimeoutMs: 120000,
});

// What Chromium prints when it exits before opening a window because the display is unreachable.
const DISPLAY_UNREACHABLE_PATTERN = /Missing X server or \$DISPLAY|The platform failed to initialize/;

/**
 * Whether a finished launch is one that never started: no line of output from the probe, and
 * Chromium's display-unreachable message on stderr. Exported for its test.
 */
function launchNeverStarted(run) {
  if (typeof run !== 'object' || run === null) {
    throw new Error('Assertion failed: launchNeverStarted takes a spawnSync result');
  }
  const stdout = typeof run.stdout === 'string' ? run.stdout : '';
  const stderr = typeof run.stderr === 'string' ? run.stderr : '';
  if (stdout.trim().length > 0) {
    return false;
  }
  return DISPLAY_UNREACHABLE_PATTERN.test(stderr);
}

/**
 * Runs `electronPath probe ...args` with spawnSync and returns its result, plus `launchAttempts`.
 * `spawn` is injectable for the helper's own test.
 */
function runElectronProbe(electronPath, argumentsList, options = {}) {
  if (typeof electronPath !== 'string' || electronPath.length === 0) {
    throw new Error('Assertion failed: runElectronProbe needs the Electron binary path');
  }
  if (!Array.isArray(argumentsList) || argumentsList.length === 0) {
    throw new Error('Assertion failed: runElectronProbe needs the probe script among its arguments');
  }
  const spawn = options.spawn ?? spawnSync;
  let run;
  for (let attempt = 1; attempt <= PROBE_LIMITS.launchAttemptsMax; attempt += 1) {
    run = spawn(electronPath, argumentsList, { encoding: 'utf8', timeout: options.timeoutMs ?? PROBE_LIMITS.launchTimeoutMs, env: options.env ?? process.env });
    if (!launchNeverStarted(run)) {
      return { ...run, launchAttempts: attempt };
    }
    process.stderr.write(`electronProbe: launch ${attempt} of ${PROBE_LIMITS.launchAttemptsMax} could not reach the display; trying again\n`);
  }
  return { ...run, launchAttempts: PROBE_LIMITS.launchAttemptsMax };
}

module.exports = { DISPLAY_UNREACHABLE_PATTERN, PROBE_LIMITS, launchNeverStarted, runElectronProbe };
