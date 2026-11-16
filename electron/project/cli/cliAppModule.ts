// Running an app's `module` command handler: the app's own JS file, in a child process the CLI limits as far as the platform allows.
//
// What IS enforced (each has a test in test/electron/project/cli/cliAppModule.test.ts):
//   - the module runs only for an installed, enabled, trusted app (the caller, cliAppHandlers.ts, checks that before it gets here);
//   - the child is `process.execPath` with FIXED arguments and `shell: false`: nothing the app or a user typed is ever a command line;
//   - its environment is `{ STACKI_CLI_PROTOCOL: '1' }` and nothing else: no inherited variable, so no token or secret, and the project's `.env`
//     is a file the child cannot read (below). One exception: inside Electron the binary needs ELECTRON_RUN_AS_NODE=1 to run a script at all;
//     it is added only then, and carries no data;
//   - Node's permission model (`--permission`): the only readable path is the app's own folder; there is no `--allow-fs-write`, no
//     `--allow-child-process`, no `--allow-worker`, no `--allow-addons`, no `--allow-wasi`, so the module cannot read the project, write a file,
//     spawn a process or load a native addon;
//   - a wall-clock timeout kills the child (SIGKILL); stdout and stderr are bounded; stdin gets one JSON line, stdout must answer one JSON line;
//   - the module never writes: it answers config operations, which the CLI validates against what the command owns and applies atomically only
//     after `--apply`. It is also never told the role.
// What is NOT enforced, and the docs say so plainly: the permission model does not restrict the NETWORK (a module can open sockets on a platform
// where the model has no network control), nor CPU or memory use (only the wall clock), and `manifest.cli.network` is a declaration the admin
// accepts with `apps enable --network`, not a firewall. The app's folder is not re-hashed at run time (the lock digest is the archive's), so a
// folder edited by hand after trust is trusted too. Symbolic links inside the app folder are refused because the model resolves them late.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toArray, toRecord } from '../../../shared/core/record';
import { err, ok, type Result } from '../../../shared/core/result';
import { APP_LIMITS } from '../../../shared/properties/apps';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';

export const MODULE_LIMITS = {
  /** The request line sent to the handler. */
  requestBytesMax: 1_048_576,
  /** The answer line the handler may print. */
  answerBytesMax: 1_048_576,
  /** What is kept of the handler's stderr, to explain a failure. */
  stderrBytesMax: 8192,
  /** Files and folders walked when checking an app folder for links. */
  entriesMax: 2000,
  depthMax: 10,
  /** Characters of a handler's message shown to the person. */
  messageCharsMax: 400,
} as const satisfies Record<string, number>;

export interface ModuleRequest {
  readonly command: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** The current document of each file the command owns, by file id; an absent file is its empty document. */
  readonly state: Readonly<Record<string, unknown>>;
}

export type ModuleAnswer =
  | { readonly ok: true; readonly operations: readonly unknown[]; readonly result: unknown; readonly summary: string }
  | { readonly ok: false; readonly message: string };

export interface ModuleRun {
  readonly folder: string;
  /** The bundle path of the module inside `folder`. */
  readonly entry: string;
  readonly timeoutSeconds: number;
  readonly request: ModuleRequest;
}

const failed = (message: string): Result<never, CliError> => err({ code: 'refused', message });

/** The text a person sees for a handler's own words: one bounded line without control characters. */
function shown(text: string): string {
  return text
    .replace(/[\s\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(0, MODULE_LIMITS.messageCharsMax);
}

/** The first link or special file under `folder`, or undefined; bounded so a hostile folder cannot make the walk long. */
function findLink(folder: string): string | undefined {
  let seen = 0;
  const walk = (directory: string, depth: number): string | undefined => {
    if (depth > MODULE_LIMITS.depthMax) {
      return directory;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      seen += 1;
      if (seen > MODULE_LIMITS.entriesMax) {
        return directory;
      }
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        return child;
      }
      if (entry.isDirectory()) {
        const inner = walk(child, depth + 1);
        if (inner !== undefined) {
          return inner;
        }
      }
    }
    return undefined;
  };
  return walk(folder, 0);
}

/** The module's absolute path when it is a plain file inside `folder`, or why not. */
function entryPathOf(folder: string, entry: string): Result<string, CliError> {
  if (/[,*]/u.test(folder)) {
    return failed('The project path holds "," or "*", which the permission model reads as a list or a wildcard: move the project to run app modules.');
  }
  const absolute = path.join(folder, entry);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    return failed(`The module ${entry} is missing from the app folder.`);
  }
  if (stat.size > APP_LIMITS.fileBytesMax) {
    return failed(`The module ${entry} is larger than ${APP_LIMITS.fileBytesMax} bytes.`);
  }
  const link = findLink(folder);
  if (link !== undefined) {
    return failed(`The app folder holds a link or too many files (${path.relative(folder, link)}): app modules do not run from such a folder.`);
  }
  return ok(absolute);
}

/** Runs the handler once and returns its answer. Never throws: every failure is a refusal that says what happened. */
export async function runModule(run: ModuleRun): Promise<Result<ModuleAnswer, CliError>> {
  const entry = entryPathOf(run.folder, run.entry);
  if (!entry.ok) {
    return entry;
  }
  const line = `${JSON.stringify({ protocol: 1, phase: 'plan', command: run.request.command, input: run.request.input, state: run.request.state })}\n`;
  if (Buffer.byteLength(line) > MODULE_LIMITS.requestBytesMax) {
    return failed(`The state this command works on is larger than ${MODULE_LIMITS.requestBytesMax} bytes.`);
  }
  const environment: Record<string, string> = { STACKI_CLI_PROTOCOL: '1' };
  if (process.versions['electron'] !== undefined) {
    environment['ELECTRON_RUN_AS_NODE'] = '1';
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${run.folder}`, entry.value], {
      cwd: run.folder,
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), tooLong: false, timedOut: false, settled: false };
    const settle = (result: Result<ModuleAnswer, CliError>): void => {
      if (!output.settled) {
        output.settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      output.timedOut = true;
      child.kill('SIGKILL');
    }, run.timeoutSeconds * 1000);
    child.stdout.on('data', (chunk: Buffer) => {
      output.stdout = Buffer.concat([output.stdout, chunk]);
      if (output.stdout.length > MODULE_LIMITS.answerBytesMax) {
        output.tooLong = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output.stderr = Buffer.concat([output.stderr, chunk]).subarray(0, MODULE_LIMITS.stderrBytesMax);
    });
    // The child may exit before it reads its input: that is its answer, read from the close event, not a crash here.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => settle(failed(`The module could not start: ${shown(error.message)}`)));
    child.on('close', (code) => {
      if (output.timedOut) {
        settle(failed(`The module did not answer within ${run.timeoutSeconds} seconds and was stopped. Nothing was changed.`));
      } else if (output.tooLong) {
        settle(failed(`The module printed more than ${MODULE_LIMITS.answerBytesMax} bytes and was stopped. Nothing was changed.`));
      } else if (code !== 0) {
        settle(failed(`The module failed (exit ${String(code)}): ${shown(output.stderr.toString('utf8')) || 'no message'}. Nothing was changed.`));
      } else {
        settle(readAnswer(output.stdout.toString('utf8')));
      }
    });
    child.stdin.end(line);
  });
}

/** One JSON line read as an answer: `{ ok: true, operations?, result?, summary }` or `{ ok: false, message }`. */
export function readAnswer(text: string): Result<ModuleAnswer, CliError> {
  const lines = text.split('\n').filter((entry) => entry.trim() !== '');
  if (lines.length !== 1) {
    return failed(`The module must answer with exactly one JSON line; it printed ${lines.length}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0] ?? '');
  } catch {
    return failed('The module answer is not JSON.');
  }
  const answer = toRecord(parsed);
  if (answer === undefined || typeof answer['ok'] !== 'boolean') {
    return failed('The module answer must be an object with ok true or false.');
  }
  if (!answer['ok']) {
    return ok({
      ok: false,
      message:
        typeof answer['message'] === 'string' ? shown(answer['message']) || 'The module refused without a message.' : 'The module refused without a message.',
    });
  }
  const operations = answer['operations'] === undefined ? [] : toArray(answer['operations']);
  const summary = answer['summary'];
  if (operations === undefined || typeof summary !== 'string' || summary.trim() === '') {
    return failed('The module answer needs "operations" (a list, optional) and a "summary" (text).');
  }
  return ok({ ok: true, operations, result: answer['result'], summary: shown(summary) });
}
