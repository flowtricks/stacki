#!/usr/bin/env node
// Usage (check.yml's per-platform `test (<os>)` job):
//
//   node --experimental-strip-types scripts/release/checkShards.mts --os=<ubuntu-latest|macos-latest|windows-latest> --run-id=<id> --attempt=<n>
//
// check.yml runs each platform's suites as CHECK_SHARD_COUNT shard jobs. This job keeps the name
// branch protection and releaseStatus.mts have always read (`test (<os>)`), and passes only when
// every one of that platform's shards in this run attempt passed. Reading the shard results from
// the API, rather than from `needs`, is what makes the verdict per platform: `needs` only reports
// the whole matrix at once.

import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { systemReporter } from './actionsReport.mts';
import { systemCommandRunner, type CommandRunner } from './releaseCommands.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { CHECK_OPERATING_SYSTEMS, CHECK_SHARD_COUNT, parseCheckJobs, shardJobName, SOURCE_REPOSITORY, type CheckJob } from './releaseStatus.mts';

export type ShardVerdict = { readonly kind: 'green' } | { readonly kind: 'red'; readonly problems: readonly string[] };

/** Every shard of this platform present once and successful; anything else is red, with why. */
export function assessShards(os: string, jobs: readonly CheckJob[]): ShardVerdict {
  assert(CHECK_SHARD_COUNT >= 1, 'assessShards: at least one shard');
  const problems: string[] = [];
  for (let shard = 1; shard <= CHECK_SHARD_COUNT; shard += 1) {
    const name = shardJobName(os, shard);
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

export function readShardJobs(runner: CommandRunner, runId: string, attempt: string): Result<readonly CheckJob[]> {
  const text = runner({ command: 'gh', argumentsList: ['run', 'view', runId, '--attempt', attempt, '--repo', SOURCE_REPOSITORY, '--json', 'jobs'] });
  return text.ok ? parseCheckJobs(text.value) : text;
}

export function parseShardArguments(argumentsList: readonly string[]): Result<{ readonly os: string; readonly runId: string; readonly attempt: string }> {
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

function main(argumentsList: readonly string[]): number {
  const reporter = systemReporter(process.env);
  const parsed = parseShardArguments(argumentsList);
  if (!parsed.ok) {
    console.error(parsed.error.message);
    return 2;
  }
  const jobs = readShardJobs(systemCommandRunner(process.env), parsed.value.runId, parsed.value.attempt);
  if (!jobs.ok) {
    reporter.error(`could not read this run's jobs: ${jobs.error.message}`);
    return 1;
  }
  const verdict = assessShards(parsed.value.os, jobs.value);
  switch (verdict.kind) {
    case 'green':
      reporter.summary(`## test (${parsed.value.os}): all ${CHECK_SHARD_COUNT} shards passed`);
      return 0;
    case 'red':
      reporter.summary([`## test (${parsed.value.os}): failed`, '', ...verdict.problems.map((problem) => `- ${problem}`)].join('\n'));
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
