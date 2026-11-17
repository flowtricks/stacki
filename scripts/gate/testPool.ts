// A bounded pool for the gate's test commands. Each command runs in its own
// shell with its output captured, so parallel runs never interleave on the
// terminal: a finished command prints one line, and its full output only when
// it failed. Why not interleave: 150 commands writing at once is unreadable,
// and the failure is the part anyone needs.
//
// Memory is bounded too: a sampler reads every running command's process-group resident memory
// once a second and kills a group past its bound. Why: one failing `assert.equal` on two
// React-rendered jsdom nodes built a diff of the whole fiber tree and passed 4 GB in five seconds,
// outside the V8 heap where `--max-old-space-size` cannot stop it (docs/memory-safety.md). With
// fifteen jobs, or several agents each running the gate, that froze a 24 GB Mac.

import { execFile, spawn, spawnSync, type SpawnOptionsWithStdioTuple, type StdioNull, type StdioPipe } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface TestCommand {
  readonly name: string;
  /** A package script (run in a shell), or an executable when arguments are given. */
  readonly command: string;
  /** Arguments for a direct spawn; absent means `command` is a shell line. */
  readonly argumentsList?: readonly string[];
  /**
   * `electron`: the command launches real Electron processes with windows. The pool runs at most
   * `PoolOptions.electronJobs` of these at once, however many jobs it has for other commands.
   */
  readonly kind?: 'electron';
  /**
   * This command's own time limit, for the few that run many suites in one process (Studio's
   * verify ran 600 s on GitHub's macOS runner and hit the default). At most `commandMsLimit`.
   */
  readonly timeoutMs?: number;
  /**
   * This command's own bound on its process group's resident memory, for the static checks that
   * legitimately run large (type-aware ESLint has a 6 GB heap). Absent means the default for its kind.
   */
  readonly rssBytesMax?: number;
}

export interface TestOutcome {
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
  /** The command's combined stdout and stderr, tail-truncated at the limit. */
  readonly output: string;
}

export interface PoolOptions {
  readonly jobs: number;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  /** At most this many `kind: 'electron'` commands at once; absent means no separate cap. */
  readonly electronJobs?: number;
}

export const POOL_LIMITS = {
  /** More concurrent test processes than this only adds contention. */
  jobsMax: 16,
  /**
   * Electron suites running at once by default. Each opens windows and a GPU process, and on a
   * loaded machine a window that waits for focus or a frame misses its timing; four sit well
   * inside what a laptop paints without contention, whatever `jobsMax` allows for the rest.
   */
  electronJobsDefault: 4,
  /** Output kept per command; a failure's cause is almost always at the end. */
  outputBytesMax: 4 * 1024 * 1024,
  /**
   * The longest one test process may run. A suite that never exits (a failed assertion
   * skipping its cleanup, leaving a timer alive) hung GitHub's release jobs for hours in
   * 1.1.0 and 1.1.3; at the bound it is killed and reported failed, with its output.
   */
  commandMsMax: 10 * 60 * 1000,
  /** The ceiling for a command's own `timeoutMs`: still a bound, never "no limit". */
  commandMsLimit: 30 * 60 * 1000,
  /**
   * Studio's verify is one command running its compiler, lint, formatting, every Studio suite in
   * batches and its build. It measured 600 s on GitHub's macOS runner (type checking 98 s, test
   * batches 101 s, 126 s and 40 s), so it gets 25 minutes: comfortably above that, still bounded.
   */
  studioVerifyMsMax: 25 * 60 * 1000,
  /**
   * Resident memory one test command's process group may hold. The heaviest suites measured well
   * under 1.5 GB (jsdom with a bundled panel about 400 MB; Electron with its helpers and an Astro dev
   * server about 2 GB), so a group past 4 GB is runaway, not work.
   */
  commandRssBytesMax: 4 * 1024 * 1024 * 1024,
  /** The same for `kind: 'electron'` commands: main, GPU, renderers and a dev server together. */
  electronRssBytesMax: 6 * 1024 * 1024 * 1024,
  /** The static checks (ESLint's 6 GB heap, Studio verify's batches): large, still bounded. */
  staticCheckRssBytesMax: 10 * 1024 * 1024 * 1024,
  /** How often the memory sampler reads the running groups; one `ps` serves every command. */
  memorySampleMs: 1000,
} as const satisfies Record<string, number>;

const running = new Set<ReturnType<typeof spawn>>();

/** Each running command's memory bound and what to do when its group passes it. */
const memoryWatches = new Map<number, { readonly rssBytesMax: number; readonly onExceeded: (rssBytes: number) => void }>();
let memorySampler: ReturnType<typeof setInterval> | undefined;
let memorySampleRunning = false;

/**
 * Watch a process group's resident memory until `memoryUnwatch`. One interval serves every running
 * command, and it stops when none is left, so an idle runner holds no timer. Windows has no process
 * groups and no `ps`, so it is not watched there; its time limit still holds.
 */
function memoryWatch(processGroup: number, rssBytesMax: number, onExceeded: (rssBytes: number) => void): void {
  if (process.platform === 'win32') {
    return;
  }
  if (rssBytesMax <= 0) {
    throw new Error(`memoryWatch: a memory bound must be positive, got ${rssBytesMax}`);
  }
  memoryWatches.set(processGroup, { rssBytesMax, onExceeded });
  memorySampler ??= setInterval(memoryWatchSample, POOL_LIMITS.memorySampleMs);
  memorySampler.unref();
}

function memoryUnwatch(processGroup: number): void {
  memoryWatches.delete(processGroup);
  if (memoryWatches.size === 0 && memorySampler !== undefined) {
    clearInterval(memorySampler);
    memorySampler = undefined;
  }
}

// One `ps` per sample for every group. A sample still running when the next tick comes is not
// doubled: a loaded machine slows `ps`, and piling samples on it would add to the load.
function memoryWatchSample(): void {
  if (memorySampleRunning) {
    return;
  }
  memorySampleRunning = true;
  execFile('ps', ['-A', '-o', 'pgid=,rss='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    memorySampleRunning = false;
    if (error !== null) {
      // A failed sample is skipped, not fatal: the next one comes in a second and the time limit holds.
      return;
    }
    const totals = memoryWatchTotals(stdout);
    for (const [processGroup, watch] of memoryWatches) {
      const rssBytes = totals.get(processGroup) ?? 0;
      if (rssBytes > watch.rssBytesMax) {
        watch.onExceeded(rssBytes);
      }
    }
  });
}

/** Resident bytes per process group from `ps -o pgid=,rss=` output (rss in kilobytes). */
export function memoryWatchTotals(psOutput: string): ReadonlyMap<number, number> {
  const totals = new Map<number, number>();
  for (const line of psOutput.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2) {
      continue;
    }
    const processGroup = Number(fields[0]);
    const rssKilobytes = Number(fields[1]);
    if (Number.isSafeInteger(processGroup) && Number.isSafeInteger(rssKilobytes)) {
      totals.set(processGroup, (totals.get(processGroup) ?? 0) + rssKilobytes * 1024);
    }
  }
  return totals;
}

/**
 * Kill a command's whole process group: the command, the Electron processes a probe started, and
 * their GPU and renderer helpers. Each command is spawned as its own group leader (see
 * `runTestCommand`), so one signal reaches every descendant, including orphans whose parent died
 * first; `child.kill` alone reaches only the direct child and left helpers running. A group with no
 * members is not an error: the command ending on its own is the normal case.
 */
function killProcessGroup(child: ReturnType<typeof spawn>): void {
  const processId = child.pid;
  if (processId === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    // Windows has no process groups; taskkill walks the tree instead.
    spawnSync('taskkill', ['/pid', String(processId), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-processId, 'SIGKILL');
  } catch {
    // ESRCH: no process is left in the group, which is what we want.
  }
}

/** Stop every command still running (the runner calls this on SIGINT). */
export function stopTestPool(): void {
  for (const child of running) {
    killProcessGroup(child);
  }
}

// The runner can leave through `process.exit` with commands still running; the exit handler runs
// synchronously, so the sweep still happens and no Electron process outlives the gate.
process.once('exit', stopTestPool);

/** Run `commands` with at most `options.jobs` at once. Outcomes come back in
 * input order; `onDone` hears each one as it finishes. */
export async function runTestPool(
  commands: readonly TestCommand[],
  options: PoolOptions,
  onDone: (outcome: TestOutcome) => void,
): Promise<readonly TestOutcome[]> {
  assertJobs(options.jobs);
  const electronJobs = options.electronJobs ?? options.jobs;
  assertElectronJobs(electronJobs);
  const outcomes: (TestOutcome | undefined)[] = commands.map(() => undefined);
  const pending = commands.map((_, index) => index);
  let electronRunning = 0;
  // The first pending command that may start now: an Electron command waits while its cap is
  // full, and a later command of another kind goes first. A worker that finds none ends; the
  // workers running Electron commands are still alive and take the rest as they finish.
  const claim = (): number | undefined => {
    for (const [position, index] of pending.entries()) {
      if (commands[index]?.kind === 'electron' && electronRunning >= electronJobs) {
        continue;
      }
      pending.splice(position, 1);
      return index;
    }
    return undefined;
  };
  const worker = async (): Promise<void> => {
    // Each pass claims one index; the loop ends when nothing can start.
    for (let index = claim(); index !== undefined; index = claim()) {
      const command = commands[index];
      if (command === undefined) {
        throw new Error(`Test pool index ${index} is outside the command list`);
      }
      const isElectron = command.kind === 'electron';
      electronRunning += isElectron ? 1 : 0;
      const outcome = await runTestCommand(command, options);
      electronRunning -= isElectron ? 1 : 0;
      outcomes[index] = outcome;
      onDone(outcome);
    }
  };
  const workers = Math.min(options.jobs, commands.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return outcomes.map((outcome, index) => {
    if (outcome === undefined) {
      throw new Error(`Test pool finished without an outcome for ${commands[index]?.name}`);
    }
    return outcome;
  });
}

export function runTestCommand(command: TestCommand, options: PoolOptions): Promise<TestOutcome> {
  // A monotonic clock: the wall clock can step backwards (WSL2 resyncs it), and
  // a duration measured across the step came out negative.
  const startedMs = performance.now();
  // Checked before anything is spawned, so a bad limit never leaves a process running.
  const limitMs = command.timeoutMs ?? POOL_LIMITS.commandMsMax;
  if (limitMs <= 0 || limitMs > POOL_LIMITS.commandMsLimit) {
    throw new Error(`runTestCommand: ${command.name}'s limit of ${limitMs} ms is outside 1 to ${POOL_LIMITS.commandMsLimit}`);
  }
  const rssBytesMax = command.rssBytesMax ?? (command.kind === 'electron' ? POOL_LIMITS.electronRssBytesMax : POOL_LIMITS.commandRssBytesMax);
  if (rssBytesMax <= 0 || rssBytesMax > POOL_LIMITS.staticCheckRssBytesMax) {
    throw new Error(`runTestCommand: ${command.name}'s memory bound of ${rssBytesMax} bytes is outside 1 to ${POOL_LIMITS.staticCheckRssBytesMax}`);
  }
  const output = createOutputTail(POOL_LIMITS.outputBytesMax);
  return new Promise((resolve) => {
    const spawnOptions: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe> = {
      cwd: options.cwd,
      env: options.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so the whole tree can be killed at once (`killProcessGroup`).
      detached: process.platform !== 'win32',
    };
    // With a shell and no arguments, the command line runs as written.
    const child =
      command.argumentsList === undefined
        ? spawn(command.command, [], { ...spawnOptions, shell: true })
        : spawn(command.command, [...command.argumentsList], spawnOptions);
    running.add(child);
    const processGroup = child.pid;
    if (processGroup !== undefined) {
      memoryWatch(processGroup, rssBytesMax, (rssBytes) => {
        memoryUnwatch(processGroup);
        const gigabytes = (bytes: number): string => (bytes / 1024 / 1024 / 1024).toFixed(1);
        output.push(
          Buffer.from(
            `\nKilled: its processes held ${gigabytes(rssBytes)} GB, past the ${gigabytes(rssBytesMax)} GB bound. ` +
              'A failing assert.equal on DOM nodes is the usual cause; see docs/memory-safety.md.\n',
          ),
        );
        killProcessGroup(child);
      });
    }
    const timer = setTimeout(() => {
      output.push(Buffer.from(`\nKilled after ${limitMs / 1000} s without exiting.\n`));
      killProcessGroup(child);
    }, limitMs);
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
    const finish = (ending: { readonly passed: boolean; readonly note: string }): void => {
      clearTimeout(timer);
      running.delete(child);
      if (processGroup !== undefined) {
        memoryUnwatch(processGroup);
      }
      // A command that passed or failed has no business leaving processes behind: sweep what it
      // started (an Electron helper that outlived its probe is the usual straggler). Windows has
      // no group to sweep, and its tree is already gone when the command exits on its own.
      if (process.platform !== 'win32') {
        killProcessGroup(child);
      }
      if (ending.note !== '') {
        output.push(Buffer.from(`\n${ending.note}\n`));
      }
      const durationMs = Math.round(performance.now() - startedMs);
      const passed = ending.passed;
      resolve({ name: command.name, passed, durationMs, output: output.text() });
    };
    child.on('error', (error) => finish({ passed: false, note: error.message }));
    child.on('close', (code, signal) => {
      finish({ passed: code === 0, note: signal === null ? '' : `terminated by ${signal}` });
    });
  });
}

/** Parse a job count from `--jobs=<n>`; absent means one fewer than the CPUs. */
export function parseJobs(flag: string | undefined, cpus: number): number {
  if (flag === undefined) {
    return Math.max(1, Math.min(cpus - 1, POOL_LIMITS.jobsMax));
  }
  const jobs = Number(flag);
  if (!Number.isSafeInteger(jobs)) {
    throw new Error(`--jobs expects a whole number, got ${JSON.stringify(flag)}`);
  }
  assertJobs(jobs);
  return jobs;
}

/** Parse `--electron-jobs=<n>`; absent means the default, never more than `jobs`. */
export function parseElectronJobs(flag: string | undefined, jobs: number): number {
  if (flag === undefined) {
    return Math.min(POOL_LIMITS.electronJobsDefault, jobs);
  }
  const electronJobs = Number(flag);
  if (!Number.isSafeInteger(electronJobs)) {
    throw new Error(`--electron-jobs expects a whole number, got ${JSON.stringify(flag)}`);
  }
  assertElectronJobs(electronJobs);
  return electronJobs;
}

/**
 * NODE_OPTIONS with the Dock preload added. The path is quoted because NODE_OPTIONS splits on
 * spaces, and a checkout under a folder with a space in its name must still load the file.
 */
export function withDockPreload(existing: string | undefined, preloadPath: string): string {
  const preload = `--require ${JSON.stringify(preloadPath)}`;
  return existing === undefined || existing === '' ? preload : `${existing} ${preload}`;
}

function assertElectronJobs(electronJobs: number): void {
  if (electronJobs < 1) {
    throw new Error(`Electron jobs must be at least 1, got ${electronJobs}`);
  }
  if (electronJobs > POOL_LIMITS.jobsMax) {
    throw new Error(`Electron jobs must be at most ${POOL_LIMITS.jobsMax}, got ${electronJobs}`);
  }
}

function assertJobs(jobs: number): void {
  if (jobs < 1) {
    throw new Error(`--jobs must be at least 1, got ${jobs}`);
  }
  if (jobs > POOL_LIMITS.jobsMax) {
    throw new Error(`--jobs must be at most ${POOL_LIMITS.jobsMax}, got ${jobs}`);
  }
}

// Keeps the last `bytesMax` bytes of a stream and says how much it dropped.
function createOutputTail(bytesMax: number): {
  push(chunk: Buffer): void;
  text(): string;
} {
  const chunks: Buffer[] = [];
  let kept = 0;
  let dropped = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      kept += chunk.length;
      while (kept > bytesMax && chunks.length > 1) {
        const first = chunks.shift();
        if (first === undefined) {
          break;
        }
        kept -= first.length;
        dropped += first.length;
      }
    },
    text() {
      const body = Buffer.concat(chunks).toString('utf8');
      return dropped > 0 ? `[… ${dropped} earlier bytes dropped …]\n${body}` : body;
    },
  };
}
