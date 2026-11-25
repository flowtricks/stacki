#!/usr/bin/env node
// Usage (release.yml's `plan` job and publish-create-stacki.yml's first step):
//
//   node --experimental-strip-types scripts/release/releasePlan.mts --sha=<sha> [--wait-minutes=45] [--force-tests=true|false]
//
// Decides one thing: must this workflow run the test suite itself, or did check.yml already pass
// this exact commit on every platform? It writes `run_tests=true|false` to GITHUB_OUTPUT and the
// reason to the job summary. Every build, package, signing, install and smoke step runs either
// way; only the suites the Check run already ran on the same commit and the same three operating
// systems are skipped.
//
// Conservative by construction: the answer is `false` (skip) only for a completed, successful
// check.yml run on exactly this SHA whose required jobs and shards are all green. A run still going
// is waited for, within the bound. No run, a red run, a missing job, an API failure or a forced
// override all answer `true`, which is today's behaviour.

import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { systemReporter, type Reporter } from './actionsReport.mts';
import { flowtricksEnvironment, pollUntil, systemCommandRunner, systemSleeper, type CommandRunner, type Sleeper } from './releaseCommands.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { exactCheckProblem, readExactCheckRun, type RunEvidence } from './releaseStatus.mts';

export const PLAN_LIMITS = {
  waitMinutesMax: 60,
  // Check starts within seconds of the push that carries the commit; past this, none is coming.
  appearMinutesMax: 3,
  delayMs: 60_000,
} as const satisfies Record<string, number>;

export type PlanDecision = { readonly kind: 'skip-tests'; readonly url: string } | { readonly kind: 'run-tests'; readonly reason: string };

/** The decision for one observation of the Check run; pure, so every branch is tested. */
export function decidePlan(observation: Result<RunEvidence | undefined>): PlanDecision {
  if (!observation.ok) {
    return { kind: 'run-tests', reason: `could not read check.yml (${observation.error.message}); running the suite to be safe.` };
  }
  const problem = exactCheckProblem(observation.value);
  if (problem === undefined) {
    assert(observation.value !== undefined, 'decidePlan: a green verdict has a run');
    return { kind: 'skip-tests', url: observation.value.run.url };
  }
  return { kind: 'run-tests', reason: `${problem}; running the suite.` };
}

// Waiting is worth it only while a run exists and is unfinished, or may still appear.
function settled(observation: Result<RunEvidence | undefined>, attempt: number, appearAttempts: number): boolean {
  if (!observation.ok) {
    return false;
  }
  if (observation.value === undefined) {
    return attempt >= appearAttempts;
  }
  return observation.value.run.status === 'completed';
}

export interface PlanInput {
  readonly sha: string;
  readonly waitMinutes: number;
  readonly forceTests: 'yes' | 'no';
}

export async function planTests(input: PlanInput, runner: CommandRunner, sleeper: Sleeper): Promise<PlanDecision> {
  assert(/^[0-9a-f]{40}$/.test(input.sha), 'planTests: a full SHA');
  assert(input.waitMinutes >= 0, 'planTests: the wait is not negative');
  assert(input.waitMinutes <= PLAN_LIMITS.waitMinutesMax, 'planTests: the wait is bounded');
  if (input.forceTests === 'yes') {
    return { kind: 'run-tests', reason: 'tests were forced (force_tests input or the RELEASE_FORCE_TESTS variable).' };
  }
  const attemptsMax = 1 + Math.ceil((input.waitMinutes * 60_000) / PLAN_LIMITS.delayMs);
  const appearAttempts = 1 + Math.ceil((PLAN_LIMITS.appearMinutesMax * 60_000) / PLAN_LIMITS.delayMs);
  let attempt = 0;
  const observation = await pollUntil(
    { attemptsMax, delayMs: PLAN_LIMITS.delayMs, sleeper },
    () => {
      attempt += 1;
      return Promise.resolve(readExactCheckRun(input.sha, runner));
    },
    (result) => settled(result, attempt, appearAttempts),
  );
  return decidePlan(observation);
}

export function reportPlan(decision: PlanDecision, reporter: Reporter): void {
  switch (decision.kind) {
    case 'skip-tests':
      reporter.output('run_tests', 'false');
      reporter.notice(`Skipping the suite: Check run ${decision.url} passed this exact SHA on every platform.`);
      reporter.summary(`## Test plan: skip the suite\n\nCheck run ${decision.url} passed this exact commit on every platform. Builds, packaging, signing and install tests still run.`);
      return;
    case 'run-tests':
      reporter.output('run_tests', 'true');
      reporter.notice(`Running the suite: ${decision.reason}`);
      reporter.summary(`## Test plan: run the suite\n\n${decision.reason}`);
      return;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

export function parsePlanArguments(argumentsList: readonly string[]): Result<PlanInput> {
  let sha: string | undefined;
  let waitMinutes = 0;
  let forceTests: PlanInput['forceTests'] = 'no';
  for (const argument of argumentsList) {
    const value = argument.slice(argument.indexOf('=') + 1);
    if (argument.startsWith('--sha=')) {
      sha = value;
    } else if (argument.startsWith('--wait-minutes=')) {
      waitMinutes = Number(value);
      if (!Number.isSafeInteger(waitMinutes) || waitMinutes < 0 || waitMinutes > PLAN_LIMITS.waitMinutesMax) {
        return fail('usage', `--wait-minutes takes 0 to ${PLAN_LIMITS.waitMinutesMax}.`);
      }
    } else if (argument.startsWith('--force-tests=')) {
      // An empty value is an unset variable or input: not forced. Anything but true/false is a typo.
      if (value === 'true') {
        forceTests = 'yes';
      } else if (value !== 'false' && value !== '') {
        return fail('usage', '--force-tests takes true or false.');
      }
    } else {
      return fail('usage', `unknown argument ${argument}`);
    }
  }
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    return fail('usage', 'usage: releasePlan.mts --sha=<40-character SHA> [--wait-minutes=N] [--force-tests=true|false]');
  }
  return ok({ sha, waitMinutes, forceTests });
}

async function main(argumentsList: readonly string[]): Promise<number> {
  const reporter = systemReporter(process.env);
  const input = parsePlanArguments(argumentsList);
  if (!input.ok) {
    // A usage error is a workflow bug; still answer conservatively so a release never skips tests by accident.
    reporter.output('run_tests', 'true');
    console.error(input.error.message);
    return 2;
  }
  const runner = systemCommandRunner(flowtricksEnvironment(process.env, systemCommandRunner(process.env)));
  reportPlan(await planTests(input.value, runner, systemSleeper), reporter);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
