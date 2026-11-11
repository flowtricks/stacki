// A bounded pool for the gate's test commands. Each command runs in its own
// shell with its output captured, so parallel runs never interleave on the
// terminal: a finished command prints one line, and its full output only when
// it failed. Why not interleave: 150 commands writing at once is unreadable,
// and the failure is the part anyone needs.

import { spawn, type SpawnOptionsWithStdioTuple, type StdioNull, type StdioPipe } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface TestCommand {
  readonly name: string;
  /** A package script (run in a shell), or an executable when arguments are given. */
  readonly command: string;
  /** Arguments for a direct spawn; absent means `command` is a shell line. */
  readonly argumentsList?: readonly string[];
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
}

export const POOL_LIMITS = {
  /** More concurrent test processes than this only adds contention. */
  jobsMax: 16,
  /** Output kept per command; a failure's cause is almost always at the end. */
  outputBytesMax: 4 * 1024 * 1024,
  /**
   * The longest one test process may run. A suite that never exits (a failed assertion
   * skipping its cleanup, leaving a timer alive) hung GitHub's release jobs for hours in
   * 1.1.0 and 1.1.3; at the bound it is killed and reported failed, with its output.
   */
  commandMsMax: 10 * 60 * 1000,
} as const satisfies Record<string, number>;

const running = new Set<ReturnType<typeof spawn>>();

/** Stop every command still running (the runner calls this on SIGINT). */
export function stopTestPool(): void {
  for (const child of running) {
    child.kill('SIGTERM');
  }
}

/** Run `commands` with at most `options.jobs` at once. Outcomes come back in
 * input order; `onDone` hears each one as it finishes. */
export async function runTestPool(
  commands: readonly TestCommand[],
  options: PoolOptions,
  onDone: (outcome: TestOutcome) => void,
): Promise<readonly TestOutcome[]> {
  assertJobs(options.jobs);
  const outcomes: (TestOutcome | undefined)[] = commands.map(() => undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    // Each pass claims one index; the loop ends when the list is exhausted.
    while (next < commands.length) {
      const index = next;
      next += 1;
      const command = commands[index];
      if (command === undefined) {
        throw new Error(`Test pool index ${index} is outside the command list`);
      }
      const outcome = await runTestCommand(command, options);
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
  const output = createOutputTail(POOL_LIMITS.outputBytesMax);
  return new Promise((resolve) => {
    const spawnOptions: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe> = {
      cwd: options.cwd,
      env: options.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    // With a shell and no arguments, the command line runs as written.
    const child =
      command.argumentsList === undefined
        ? spawn(command.command, [], { ...spawnOptions, shell: true })
        : spawn(command.command, [...command.argumentsList], spawnOptions);
    running.add(child);
    const timer = setTimeout(() => {
      output.push(Buffer.from(`\nKilled after ${POOL_LIMITS.commandMsMax / 1000} s without exiting.\n`));
      child.kill('SIGKILL');
    }, POOL_LIMITS.commandMsMax);
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
    const finish = (ending: { readonly passed: boolean; readonly note: string }): void => {
      clearTimeout(timer);
      running.delete(child);
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
