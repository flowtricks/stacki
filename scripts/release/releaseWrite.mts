// The only commands the release scripts may run that change anything: the bump commit, the
// release tag, one push, the GitHub API writes of the remote bump and tag (releaseBump.mts), and
// the dispatches and reruns of named workflows. Every write goes through
// writeViolation, an allowlist, so a script bug cannot force-push, move or delete a tag, skip a hook
// or dispatch a workflow nobody listed. A refusal is a programmer error and crashes (AGENTS.md §3).
//
// The read-only helpers keep their own runner (releaseCommands.mts), which refuses all of these.

import { spawnSync } from 'node:child_process';
import { assert } from '../policy/assert.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { RELEASE_BUMP_PATHS } from './versionManifest.mts';

export const WRITE_LIMITS = {
  timeoutMsDefault: 120_000,
  // A local push runs the pre-push hook, whose full gate can take half an hour on a laptop.
  pushTimeoutMsMax: 90 * 60 * 1_000,
  outputBytesMax: 8 * 1024 * 1024,
} as const satisfies Record<string, number>;

export interface WriteRequest {
  readonly command: 'git' | 'gh';
  readonly argumentsList: readonly string[];
  readonly timeoutMs?: number;
  // `inherit` streams to the terminal, for a push whose hook prints a long gate run.
  readonly output: 'capture' | 'inherit';
}

export type WriteRunner = (request: WriteRequest) => Result<string>;

/** The workflows a release may dispatch, by repository. */
export const DISPATCHABLE_WORKFLOWS: ReadonlyMap<string, readonly string[]> = new Map([
  ['flowtricks/stacki', ['publish-create-stacki.yml', 'release-post.yml']],
  ['flowtricks/stacki-marketing-site', ['deploy.yml']],
]);

const RELEASE_TAG = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const CREDENTIAL_PREFIX = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] as const;
// Anything that could bypass a hook, rewrite history or delete a ref.
const FORBIDDEN_FLAGS = ['--no-verify', '-n', '--force', '-f', '--force-with-lease', '--force-if-includes', '--delete', '-d', '--mirror', '--all', '--tags', '--amend', '-a'];

/** Why this write is not on the allowlist, or undefined when it is. */
export function writeViolation(request: WriteRequest): string | undefined {
  switch (request.command) {
    case 'git': {
      // Git only: gh's `-f key=value` is a workflow input, not a force.
      const forbidden = request.argumentsList.find((argument) => FORBIDDEN_FLAGS.includes(argument) || argument.startsWith('--force'));
      if (forbidden !== undefined) {
        return `git: ${forbidden} is never allowed`;
      }
      return gitViolation(request.argumentsList);
    }
    case 'gh':
      return ghViolation(request.argumentsList);
    default: {
      const exhaustive: never = request.command;
      return exhaustive;
    }
  }
}

function gitViolation(argumentsList: readonly string[]): string | undefined {
  const withoutCredentials = startsWith(argumentsList, CREDENTIAL_PREFIX) ? argumentsList.slice(CREDENTIAL_PREFIX.length) : argumentsList;
  const [subcommand, ...rest] = withoutCredentials;
  if (subcommand === undefined) {
    return 'git: no subcommand';
  }
  switch (subcommand) {
    case 'add': {
      if (rest[0] !== '--') {
        return 'git add takes `--` before its paths';
      }
      const paths = rest.slice(1);
      const outside = paths.find((path) => !RELEASE_BUMP_PATHS.includes(path));
      if (paths.length === 0) {
        return 'git add needs at least one path';
      }
      return outside === undefined ? undefined : `git add ${outside}: not a release bump file`;
    }
    case 'commit': {
      // Exactly `commit -m <subject> -m <body>`: no paths, no `-a`, no amend.
      const shape = rest.length === 4 && rest[0] === '-m' && rest[2] === '-m';
      return shape ? undefined : 'git commit takes exactly -m <subject> -m <body>';
    }
    case 'tag': {
      const [name, target, ...extra] = rest;
      if (extra.length > 0 || name === undefined || target === undefined) {
        return 'git tag takes exactly <vX.Y.Z> <sha>';
      }
      if (!RELEASE_TAG.test(name)) {
        return `git tag ${name}: not a release tag`;
      }
      return FULL_SHA.test(target) ? undefined : `git tag ${name} ${target}: the target must be a full SHA`;
    }
    case 'push':
      return pushViolation(rest);
    default:
      return `git ${subcommand} is not a release write`;
  }
}

// One atomic push of the bump commit to main and the release tag, never anything else.
function pushViolation(rest: readonly string[]): string | undefined {
  const [atomic, remote, ...refspecs] = rest;
  if (atomic !== '--atomic' || remote !== 'origin') {
    return 'git push takes exactly --atomic origin <refspecs>';
  }
  if (refspecs.length === 0 || refspecs.length > 2) {
    return 'git push takes one or two refspecs';
  }
  for (const refspec of refspecs) {
    if (refspec.startsWith('+') || refspec.startsWith(':')) {
      return `git push ${refspec}: forcing or deleting is never allowed`;
    }
    const [source, target] = refspec.split(':');
    if (target === 'refs/heads/main') {
      if (source !== 'HEAD' && !FULL_SHA.test(source ?? '')) {
        return `git push ${refspec}: main is pushed from HEAD or a full SHA`;
      }
      continue;
    }
    const tag = /^refs\/tags\/(v\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(target ?? '');
    if (tag === null || source !== target) {
      return `git push ${refspec}: only refs/heads/main and refs/tags/vX.Y.Z (as itself) may be pushed`;
    }
  }
  return undefined;
}

function ghViolation(argumentsList: readonly string[]): string | undefined {
  const [first, second, third, ...rest] = argumentsList;
  if (first === 'workflow' && second === 'run') {
    const repositoryIndex = rest.indexOf('--repo');
    const repository = repositoryIndex >= 0 ? rest[repositoryIndex + 1] : undefined;
    if (repository === undefined) {
      return 'gh workflow run needs --repo';
    }
    const allowed = DISPATCHABLE_WORKFLOWS.get(repository) ?? [];
    return third !== undefined && allowed.includes(third) ? undefined : `gh workflow run ${String(third)} --repo ${repository}: not a release workflow`;
  }
  if (first === 'run' && second === 'rerun') {
    const shape = third !== undefined && /^\d{1,20}$/.test(third) && rest.length === 3 && rest[0] === '--failed' && rest[1] === '--repo' && rest[2] === 'flowtricks/stacki';
    return shape ? undefined : 'gh run rerun takes exactly <id> --failed --repo flowtricks/stacki';
  }
  if (first === 'api') {
    return apiViolation(argumentsList.slice(1));
  }
  return `gh ${String(first)} ${String(second)} is not a release write`;
}

// The GitHub API writes of the remote bump (releaseBump.mts), each in one exact shape: the three
// git-data creations read their body from a file the bump wrote into its own temporary folder; main
// moves only with force=false (GitHub then accepts a fast-forward only); a tag is only created.
const BUMP_INPUT = /^.*[\\/]stacki-release-bump-[A-Za-z0-9]{1,12}[\\/](blobs|trees|commits)\.json$/;

function apiViolation(rest: readonly string[]): string | undefined {
  const [methodFlag, method, endpoint, ...tail] = rest;
  if (methodFlag !== '--method') {
    return 'gh api writes name --method first';
  }
  const git = `repos/flowtricks/stacki/git/`;
  if (method === 'POST' && endpoint !== undefined && /^repos\/flowtricks\/stacki\/git\/(blobs|trees|commits)$/.test(endpoint)) {
    const kind = endpoint.slice(git.length);
    const [inputFlag, input, ...extra] = tail;
    const match = BUMP_INPUT.exec(input ?? '');
    const shape = inputFlag === '--input' && extra.length === 0 && match !== null && match[1] === kind;
    return shape ? undefined : `gh api POST ${endpoint} takes exactly --input <bump folder>/${kind}.json`;
  }
  if (method === 'PATCH' && endpoint === `${git}refs/heads/main`) {
    const shape = tail.length === 4 && tail[0] === '-f' && FULL_SHA.test((tail[1] ?? '').replace(/^sha=/, '')) && (tail[1] ?? '').startsWith('sha=') && tail[2] === '-F' && tail[3] === 'force=false';
    return shape ? undefined : 'gh api PATCH main takes exactly -f sha=<full SHA> -F force=false';
  }
  if (method === 'POST' && endpoint === `${git}refs`) {
    const ref = /^ref=refs\/tags\/(v\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(tail[1] ?? '');
    const sha = (tail[3] ?? '').replace(/^sha=/, '');
    const shape = tail.length === 4 && tail[0] === '-f' && ref !== null && tail[2] === '-f' && (tail[3] ?? '').startsWith('sha=') && FULL_SHA.test(sha);
    return shape ? undefined : 'gh api POST refs creates only refs/tags/vX.Y.Z at a full SHA';
  }
  return `gh api --method ${String(method)} ${String(endpoint)} is not a release write`;
}

function startsWith(list: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((value, index) => list[index] === value);
}

export function systemWriteRunner(environment: NodeJS.ProcessEnv): WriteRunner {
  return (request) => {
    const violation = writeViolation(request);
    assert(violation === undefined, `release writes are allowlisted: ${violation ?? ''}`);
    const timeoutMs = request.timeoutMs ?? WRITE_LIMITS.timeoutMsDefault;
    assert(timeoutMs > 0, 'write timeout is positive');
    assert(timeoutMs <= WRITE_LIMITS.pushTimeoutMsMax, 'write timeout is bounded');
    const result = spawnSync(request.command, [...request.argumentsList], {
      encoding: 'utf8',
      env: environment,
      timeout: timeoutMs,
      maxBuffer: WRITE_LIMITS.outputBytesMax,
      shell: false,
      stdio: request.output === 'inherit' ? 'inherit' : 'pipe',
      windowsHide: true,
    });
    const shown = request.argumentsList.filter((argument) => !argument.startsWith('credential.helper')).join(' ');
    if (result.error !== undefined) {
      return fail('command-spawn', `${request.command} ${shown}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = typeof result.stderr === 'string' ? result.stderr.trim().slice(0, 400) : '';
      return fail('command-failed', `${request.command} ${shown} exited ${String(result.status)}${detail === '' ? '' : `: ${detail}`}`);
    }
    return ok(typeof result.stdout === 'string' ? result.stdout : '');
  };
}
