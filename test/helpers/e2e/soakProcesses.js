// Goal: a soak run leaves no process behind, however it ends: finished, failed, interrupted,
// or killed outright by the gate's spawn timeout. The app starts the fixture's Astro dev server
// in its own process group (and Astro 7 may run it as a daemon), so the server outlives
// Electron unless something stops it; every run used to leave one or more behind.
//
// Method, in three layers:
// - Stop: `stopRun(directory)` finds every process whose command line names the run's temp
//   directory (the project's node_modules/astro, Electron with its entry, any helper), sends
//   SIGTERM to each process and its group, waits (bounded), then SIGKILLs what remains.
// - Registry: each run writes `soak-run.json` (runner pid, start time) into its temp directory.
//   `reapStaleSoakServers()` (run at the start of every soak run, and exported) kills soak
//   processes whose runner is dead, or that have no registry and are older than a bound.
// - Watchdog: soakWatchdog.js rides into every Node child through NODE_OPTIONS and exits the
//   process within a poll when the runner pid is gone, so even a SIGKILLed runner leaves
//   nothing for long.
// Process lists come from `ps` (POSIX) or Win32_Process (Windows), parsed into plain records;
// the decisions are pure functions of those records, so they are unit-tested with fake pids.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RUN_DIRECTORY_PREFIX = 'stacki-style-soak-';
const REGISTRY_FILE = 'soak-run.json';
const PROCESSES_MAX = 20000;
const RUN_DIRECTORIES_MAX = 500;
const STALE_MS_DEFAULT = 10 * 60 * 1000;
const TERM_WAIT_MS_MAX = 5000;
const TERM_POLL_MS = 100;
const RUN_DIRECTORY_PATTERN = new RegExp(`([^\\s"'=]*${RUN_DIRECTORY_PREFIX}[A-Za-z0-9]+)`);

/** "[[dd-]hh:]mm:ss" (ps etime) in milliseconds; undefined when it is not one. */
function parseElapsed(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map((part) => Number.parseInt(part ?? '0', 10));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** `ps -axo pid=,ppid=,etime=,command=` output as records. */
function parseProcessTable(text) {
  const processes = [];
  for (const line of text.split('\n').slice(0, PROCESSES_MAX)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const ageMs = parseElapsed(match[3]);
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), ageMs: ageMs ?? 0, command: match[4] });
  }
  return processes;
}

function listProcesses() {
  if (process.platform === 'win32') {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1} {2} {3}" -f $_.ProcessId, $_.ParentProcessId, ' +
      '[int]((Get-Date) - $_.CreationDate).TotalSeconds, $_.CommandLine }';
    const listed = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return (listed.stdout ?? '')
      .split('\n')
      .slice(0, PROCESSES_MAX)
      .map((line) => /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), ageMs: Number(match[3]) * 1000, command: match[4] }));
  }
  const listed = childProcess.spawnSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return parseProcessTable(listed.stdout ?? '');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is someone else's.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** The run directory a command line names, or undefined. */
function runDirectoryOf(command) {
  const match = RUN_DIRECTORY_PATTERN.exec(command);
  return match === null ? undefined : match[1];
}

function writeRegistry(directory) {
  fs.writeFileSync(path.join(directory, REGISTRY_FILE), JSON.stringify({ runnerPid: process.pid, startedAt: Date.now() }));
}

function readRegistry(directory) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, REGISTRY_FILE), 'utf8'));
    return Number.isSafeInteger(parsed?.runnerPid) ? { runnerPid: parsed.runnerPid } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a soak process is stale: its run's runner is dead (registry), or it has no registry
 * and is older than `olderThanMs`. Pure: the caller supplies what the system says.
 */
function isStale({ process: candidate, registry, runnerAlive, olderThanMs }) {
  if (registry !== undefined) {
    return !runnerAlive;
  }
  return candidate.ageMs >= olderThanMs;
}

function signal(pid, name) {
  if (process.platform === 'win32') {
    childProcess.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // The group first (the app starts Astro as a group leader), then the process itself.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, name);
    } catch {
      // Gone already, or not a group leader.
    }
  }
}

/** SIGTERM, a bounded wait, then SIGKILL; resolves with the pids that survived both. */
async function terminate(pids) {
  for (const pid of pids) {
    signal(pid, 'SIGTERM');
  }
  for (let waitedMs = 0; waitedMs < TERM_WAIT_MS_MAX && pids.some(alive); waitedMs += TERM_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, TERM_POLL_MS));
  }
  for (const pid of pids.filter(alive)) {
    signal(pid, 'SIGKILL');
  }
  await new Promise((resolve) => setTimeout(resolve, TERM_POLL_MS));
  return pids.filter(alive);
}

/** Every process (not this one) whose command line names `directory`. */
function processesOfRun(directory) {
  const name = path.basename(directory);
  return listProcesses().filter((entry) => entry.pid !== process.pid && entry.command.includes(name));
}

/** Stops everything the run started; resolves with the pids that would not stop. */
async function stopRun(directory) {
  return terminate(processesOfRun(directory).map((entry) => entry.pid));
}

/** The synchronous last resort for a runner being torn down by a signal: SIGKILL at once. */
function stopRunNow(directory) {
  for (const entry of processesOfRun(directory)) {
    signal(entry.pid, 'SIGKILL');
  }
}

/**
 * Kills soak processes left by earlier runs whose runner is gone and removes their directories;
 * resolves with the pids. `within` is the folder runs live in (the temp folder; a test passes
 * its own, so it never touches anyone's real runs).
 */
async function reapStaleSoakServers({ olderThanMs = STALE_MS_DEFAULT, within = fs.realpathSync(os.tmpdir()) } = {}) {
  const stale = [];
  const runnerAliveByDirectory = new Map();
  for (const entry of listProcesses()) {
    const directory = runDirectoryOf(entry.command);
    if (directory === undefined || entry.pid === process.pid || path.dirname(directory) !== within) {
      continue;
    }
    const registry = readRegistry(directory);
    if (!runnerAliveByDirectory.has(directory)) {
      runnerAliveByDirectory.set(directory, registry !== undefined && alive(registry.runnerPid));
    }
    if (isStale({ process: entry, registry, runnerAlive: runnerAliveByDirectory.get(directory), olderThanMs })) {
      stale.push(entry.pid);
    }
  }
  await terminate(stale);
  removeStaleRunDirectories(olderThanMs, within);
  return stale;
}

// Run directories in the temp folder that no live run owns and that are older than the bound:
// left by a runner killed before its own cleanup. Bounded by RUN_DIRECTORIES_MAX.
function removeStaleRunDirectories(olderThanMs, temporary) {
  const names = fs
    .readdirSync(temporary)
    .filter((name) => name.startsWith(RUN_DIRECTORY_PREFIX))
    .slice(0, RUN_DIRECTORIES_MAX);
  for (const name of names) {
    const directory = path.join(temporary, name);
    const registry = readRegistry(directory);
    if (registry !== undefined && alive(registry.runnerPid)) {
      continue;
    }
    try {
      if (Date.now() - fs.statSync(directory).mtimeMs >= olderThanMs && processesOfRun(directory).length === 0) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    } catch {
      // Removed meanwhile, or busy (Windows): the next run tries again.
    }
  }
}

/** NODE_OPTIONS that load the watchdog into every Node child of the run. */
function watchdogOptions(existing) {
  const watchdog = path.join(__dirname, 'soakWatchdog.js');
  return `${existing ?? ''} --require ${JSON.stringify(watchdog)}`.trim();
}

module.exports = {
  RUN_DIRECTORY_PREFIX,
  REGISTRY_FILE,
  isStale,
  listProcesses,
  parseElapsed,
  parseProcessTable,
  processesOfRun,
  reapStaleSoakServers,
  runDirectoryOf,
  stopRun,
  stopRunNow,
  terminate,
  watchdogOptions,
  writeRegistry,
};
