#!/usr/bin/env node
// Usage (check.yml's per-platform `test (<os>)` job):
//
//   node --experimental-strip-types scripts/release/checkShards.mts --os=<ubuntu-latest|macos-latest|windows-latest> --run-id=<id> --attempt=<n>
//
// GitHub Actions supplies GITHUB_REPOSITORY, the repository that owns the run ID.
//
// check.yml runs each platform's suites as CHECK_SHARD_COUNT shard jobs and its static checks as
// two more jobs (the desktop checks and Studio's verify). This job keeps the name branch protection and releaseStatus.mts have always read
// (`test (<os>)`), and passes only when all of that platform's jobs in this run attempt passed. Reading the shard results from
// the API, rather than from `needs`, is what makes the verdict per platform: `needs` only reports
// the whole matrix at once.

import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { systemReporter, type Reporter } from './actionsReport.mts';
import { systemCommandRunner, type CommandRunner } from './releaseCommands.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { CHECK_OPERATING_SYSTEMS, CHECK_SHARD_COUNT, parseCheckJobs, shardJobName, staticJobsFor, studioJobName, type CheckJob } from './releaseStatus.mts';

export type ShardVerdict = { readonly kind: 'green' } | { readonly kind: 'red'; readonly problems: readonly string[] };

interface ShardArguments {
  readonly os: string;
  readonly runId: string;
  readonly attempt: string;
}

// Bound both GitHub name segments and reject path segments such as `.` and `..`.
const REPOSITORY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/(?!(?:\.|\.\.)$)[a-zA-Z0-9_.-]{1,100}$/;

/** The platform's static-checks job (Linux only), Studio job and every shard present once and successful; anything else is red. */
export function assessShards(os: string, jobs: readonly CheckJob[]): ShardVerdict {
  assert(CHECK_SHARD_COUNT >= 1, 'assessShards: at least one shard');
  const problems: string[] = [];
  const names = [...staticJobsFor(os), studioJobName(os), ...Array.from({ length: CHECK_SHARD_COUNT }, (_, index) => shardJobName(os, index + 1))];
  for (const name of names) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length === 0) {
      problems.push(`${name}: missing from the run`);
    } else if (matches.length > 1) {
      problems.push(`${name}: listed ${matches.length} times`);
    } else if (matches[0]?.conclusion !== 'success') {
      problems.push(`${name}: ${matches[0]?.conclusion ?? matches[0]?.status ?? 'unknown'}`);
    }
  }
  return problems.length === 0 ? { kind: 'green' } : { kind: 'red', problems };
}

export function parseShardArguments(argumentsList: readonly string[]): Result<ShardArguments> {
  const value = (name: string): string | undefined => argumentsList.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const os = value('os');
  const runId = value('run-id');
  const attempt = value('attempt');
  const known: readonly string[] = CHECK_OPERATING_SYSTEMS;
  if (os === undefined || !known.includes(os)) {
    return fail('usage', `--os takes one of ${CHECK_OPERATING_SYSTEMS.join(', ')}.`);
  }
  if (runId === undefined || !/^\d{1,20}$/.test(runId) || attempt === undefined || !/^\d{1,4}$/.test(attempt)) {
    return fail('usage', '--run-id and --attempt take the workflow run id and attempt number.');
  }
  return ok({ os, runId, attempt });
}

export function runShardCheck(input: ShardArguments, environment: NodeJS.ProcessEnv, runner: CommandRunner, reporter: Reporter): number {
  const repository = environment['GITHUB_REPOSITORY'] ?? '';
  if (!REPOSITORY_NAME.test(repository)) {
    reporter.error('GITHUB_REPOSITORY must name the workflow repository as owner/name.');
    return 2;
  }
  const jobs = readShardJobs(runner, input, repository);
  if (!jobs.ok) {
    reporter.error(`could not read this run's jobs: ${jobs.error.message}`);
    return 1;
  }
  const verdict = assessShards(input.os, jobs.value);
  switch (verdict.kind) {
    case 'green':
      reporter.summary(`## test (${input.os}): the static checks and all ${CHECK_SHARD_COUNT} shards passed`);
      return 0;
    case 'red':
      reporter.summary([`## test (${input.os}): failed`, '', ...verdict.problems.map((problem) => `- ${problem}`)].join('\n'));
      for (const problem of verdict.problems) {
        reporter.error(problem);
      }
      return 1;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function readShardJobs(runner: CommandRunner, input: Pick<ShardArguments, 'runId' | 'attempt'>, repository: string): Result<readonly CheckJob[]> {
  const text = runner({ command: 'gh', argumentsList: ['run', 'view', input.runId, '--attempt', input.attempt, '--repo', repository, '--json', 'jobs'] });
  return text.ok ? parseCheckJobs(text.value) : text;
}

function main(argumentsList: readonly string[]): number {
  const parsed = parseShardArguments(argumentsList);
  if (!parsed.ok) {
    console.error(parsed.error.message);
    return 2;
  }
  return runShardCheck(parsed.value, process.env, systemCommandRunner(process.env), systemReporter(process.env));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
