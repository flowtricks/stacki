// Every process and network call the release helpers make goes through here, behind injectable
// types, so tests never touch GitHub, npm or the network and so the helpers stay read-only.
//
// Read-only is enforced, not promised: readOnlyViolation refuses anything that could write (a gh
// call that is not a GET, a git command that changes refs, an npm publish). A refusal is a
// programmer error, so the system runner asserts instead of returning a failure.

import { spawnSync } from 'node:child_process';
import { assert } from '../policy/assert.mts';
import { fail, ok, type Result } from './releaseResult.mts';

export const COMMAND_LIMITS = {
  timeoutMsDefault: 60_000,
  outputBytesMax: 8 * 1024 * 1024,
  bodyCharsMax: 2 * 1024 * 1024,
  httpTimeoutMs: 20_000,
  // Thirty minutes of 30-second retries is 61 attempts (verifyRelease.mts).
  pollAttemptsMax: 70,
  pollDelayMsMax: 120_000,
} as const satisfies Record<string, number>;

export type CommandName = 'gh' | 'git' | 'npm';

export interface CommandRequest {
  readonly command: CommandName;
  readonly argumentsList: readonly string[];
  readonly timeoutMs?: number;
}

/** Runs one command and returns its standard output, or the failure as a value. */
export type CommandRunner = (request: CommandRequest) => Result<string>;

export interface HttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'HEAD';
  // Redirects are the thing under test for the admin page (it must answer 302), so the caller chooses.
  readonly redirect: 'follow' | 'manual';
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly location: string | undefined;
}

export type HttpFetcher = (request: HttpRequest) => Promise<Result<HttpResponse>>;
export type Sleeper = (delayMs: number) => Promise<void>;

const GH_READ_COMMANDS: readonly (readonly string[])[] = [['run', 'list'], ['run', 'view'], ['release', 'view'], ['api'], ['auth', 'token']];
const GH_WRITE_FLAGS = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'];
const GIT_READ_COMMANDS = ['rev-parse', 'rev-list', 'ls-remote', 'status', 'diff', 'show', 'merge-base', 'log'];
const NPM_READ_COMMANDS = ['view', 'pack'];

/** Why this request could write, or undefined when it is read-only. */
export function readOnlyViolation(request: CommandRequest): string | undefined {
  const [first, second] = request.argumentsList;
  if (first === undefined) {
    return `${request.command}: no subcommand`;
  }
  switch (request.command) {
    case 'gh': {
      const known = GH_READ_COMMANDS.some((prefix) => prefix[0] === first && (prefix[1] === undefined || prefix[1] === second));
      if (!known) {
        return `gh ${first} ${second ?? ''} is not on the read-only list`;
      }
      const writeFlag = request.argumentsList.find((argument) => GH_WRITE_FLAGS.includes(argument));
      return writeFlag === undefined ? undefined : `gh ${first}: ${writeFlag} can write`;
    }
    case 'git':
      return GIT_READ_COMMANDS.includes(first) ? undefined : `git ${first} is not on the read-only list`;
    case 'npm': {
      if (!NPM_READ_COMMANDS.includes(first)) {
        return `npm ${first} is not on the read-only list`;
      }
      // Pack only ever lists: a real tarball would be a file written into the working tree.
      if (first === 'pack' && !request.argumentsList.includes('--dry-run')) {
        return 'npm pack must be --dry-run';
      }
      return undefined;
    }
    default: {
      const exhaustive: never = request.command;
      return exhaustive;
    }
  }
}

export function systemCommandRunner(environment: NodeJS.ProcessEnv): CommandRunner {
  return (request) => {
    const violation = readOnlyViolation(request);
    assert(violation === undefined, `release helpers are read-only: ${violation ?? ''}`);
    const timeoutMs = request.timeoutMs ?? COMMAND_LIMITS.timeoutMsDefault;
    assert(timeoutMs > 0, 'command timeout is positive');
    assert(timeoutMs <= 10 * 60 * 1_000, 'command timeout is bounded');
    const result = spawnSync(request.command, [...request.argumentsList], {
      encoding: 'utf8',
      env: environment,
      timeout: timeoutMs,
      maxBuffer: COMMAND_LIMITS.outputBytesMax,
      shell: false,
      windowsHide: true,
    });
    if (result.error !== undefined) {
      return fail('command-spawn', `${request.command} ${request.argumentsList.join(' ')}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = result.stderr.trim().slice(0, 400);
      return fail('command-failed', `${request.command} ${request.argumentsList.join(' ')} exited ${String(result.status)}: ${detail}`);
    }
    return ok(result.stdout);
  };
}

/**
 * The environment for gh: pushes, tags and gh calls on the flowtricks repositories use the
 * flowtricks account, without switching the active gh account. The token goes only into the
 * child environment and is never printed. Without that account, gh falls back to its active one.
 */
export function flowtricksEnvironment(base: NodeJS.ProcessEnv, runner: CommandRunner): NodeJS.ProcessEnv {
  if (base['GH_TOKEN'] !== undefined && base['GH_TOKEN'].length > 0) {
    return base;
  }
  const token = runner({ command: 'gh', argumentsList: ['auth', 'token', '--user', 'flowtricks'], timeoutMs: 15_000 });
  if (token.ok && token.value.trim().length > 0) {
    return { ...base, GH_TOKEN: token.value.trim() };
  }
  return base;
}

export function systemHttpFetcher(): HttpFetcher {
  return async (request) => {
    try {
      const response = await fetch(request.url, {
        method: request.method,
        redirect: request.redirect,
        signal: AbortSignal.timeout(COMMAND_LIMITS.httpTimeoutMs),
      });
      const text = request.method === 'GET' ? await response.text() : '';
      if (text.length > COMMAND_LIMITS.bodyCharsMax) {
        return fail('http-too-large', `${request.url}: body exceeds ${COMMAND_LIMITS.bodyCharsMax} characters.`);
      }
      return ok({ status: response.status, body: text, location: response.headers.get('location') ?? undefined });
    } catch (error: unknown) {
      return fail('http-failed', `${request.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

export const systemSleeper: Sleeper = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export interface PollPlan {
  readonly attemptsMax: number;
  readonly delayMs: number;
  readonly sleeper: Sleeper;
}

/**
 * Tries until `isDone` accepts an attempt's value or the attempts run out, waiting between tries,
 * and returns the last value. Registry and CDN lag are expected, so an unfinished attempt is
 * retried; the bound makes a real failure loud instead of endless. Tests pass an instant sleeper.
 */
export async function pollUntil<T>(plan: PollPlan, attempt: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
  assert(plan.attemptsMax >= 1, 'poll attempts are bounded: at least one');
  assert(plan.attemptsMax <= COMMAND_LIMITS.pollAttemptsMax, 'poll attempts are bounded: at most the limit');
  assert(plan.delayMs >= 0, 'poll delay is bounded: not negative');
  assert(plan.delayMs <= COMMAND_LIMITS.pollDelayMsMax, 'poll delay is bounded: at most the limit');
  let last = await attempt();
  for (let tries = 1; tries < plan.attemptsMax && !isDone(last); tries += 1) {
    await plan.sleeper(plan.delayMs);
    last = await attempt();
  }
  return last;
}
