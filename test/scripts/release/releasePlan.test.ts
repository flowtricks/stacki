// Goal: release.yml and the npm publish skip the test suite only on proof: a completed, green
// check.yml run on exactly the commit, with every platform and every shard green. Anything else (no
// run, a run that never finishes within the bound, a red run, a missing job or shard, an API
// failure, a forced run, a usage error) runs the tests, which is the old behaviour.
// Methodology: decidePlan is pure and gets each observation; planTests runs against a scripted gh
// with an instant sleeper, including a run that finishes on a later poll and one that never does;
// the argument parser gets good and bad flags.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandRunner } from '../../../scripts/release/releaseCommands.mts';
import { decidePlan, parsePlanArguments, planTests } from '../../../scripts/release/releasePlan.mts';
import { fail, ok } from '../../../scripts/release/releaseResult.mts';
import { REQUIRED_CHECK_JOBS, shardJobName, staticJobName, studioJobName, type CheckJob, type RunEvidence } from '../../../scripts/release/releaseStatus.mts';

const SHA = 'a'.repeat(40);
const green: readonly CheckJob[] = REQUIRED_CHECK_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));

function evidence(status: string, conclusion: string | undefined, jobs: readonly CheckJob[] = green): RunEvidence {
  return { run: { id: 1, headSha: SHA, status, conclusion, url: 'https://example.test/run/1' }, jobs };
}

test('only a completed green run with every job skips the suite', () => {
  assert.deepEqual(decidePlan(ok(evidence('completed', 'success'))), { kind: 'skip-tests', url: 'https://example.test/run/1' });
  const shards = ['ubuntu-latest', 'macos-latest', 'windows-latest'].flatMap((os) => [
    { name: staticJobName(os), status: 'completed', conclusion: 'success' },
    { name: studioJobName(os), status: 'completed', conclusion: 'success' },
    ...[1, 2, 3, 4].map((shard) => ({ name: shardJobName(os, shard), status: 'completed', conclusion: 'success' })),
  ]);
  assert.equal(decidePlan(ok(evidence('completed', 'success', [...green, ...shards]))).kind, 'skip-tests');
  const runTests = [
    ok(undefined),
    ok(evidence('in_progress', undefined)),
    ok(evidence('completed', 'failure')),
    ok(evidence('completed', 'success', green.slice(1))),
    ok(evidence('completed', 'success', [...green, { name: shardJobName('ubuntu-latest', 1), status: 'completed', conclusion: 'failure' }, ...shards.slice(1)])),
    ok(evidence('completed', 'success', [...green, ...shards.slice(1)])),
    fail('command-failed', 'gh is down'),
  ];
  for (const observation of runTests) {
    assert.equal(decidePlan(observation).kind, 'run-tests');
  }
});

function scripted(answers: readonly string[]): { readonly runner: CommandRunner; readonly calls: string[] } {
  const calls: string[] = [];
  let listed = 0;
  const runner: CommandRunner = (request) => {
    calls.push(request.argumentsList.join(' '));
    if (request.argumentsList[1] === 'list') {
      const answer = answers[Math.min(listed, answers.length - 1)] ?? '[]';
      listed += 1;
      return ok(answer);
    }
    return ok(JSON.stringify({ jobs: green }));
  };
  return { runner, calls };
}

const run = (status: string, conclusion: string) => JSON.stringify([{ databaseId: 1, headSha: SHA, status, conclusion, url: 'u' }]);

test('a run still going is waited for, and its green result skips the suite', async () => {
  const { runner, calls } = scripted([run('in_progress', ''), run('in_progress', ''), run('completed', 'success')]);
  const decision = await planTests({ sha: SHA, waitMinutes: 10, forceTests: 'no' }, runner, () => Promise.resolve());
  assert.equal(decision.kind, 'skip-tests');
  assert.ok(calls.some((call) => call.includes(`--commit ${SHA}`)), 'looked up by exact SHA');
});

test('a run that never finishes within the bound runs the suite', async () => {
  const { runner, calls } = scripted([run('in_progress', '')]);
  const decision = await planTests({ sha: SHA, waitMinutes: 3, forceTests: 'no' }, runner, () => Promise.resolve());
  assert.equal(decision.kind, 'run-tests');
  assert.ok(calls.filter((call) => call.startsWith('run list')).length <= 4, 'the wait is bounded');
});

test('no run within the appearance window runs the suite without waiting the whole bound', async () => {
  const { runner, calls } = scripted(['[]']);
  const decision = await planTests({ sha: SHA, waitMinutes: 45, forceTests: 'no' }, runner, () => Promise.resolve());
  assert.equal(decision.kind, 'run-tests');
  assert.ok(calls.length <= 5);
});

test('a forced run never asks GitHub', async () => {
  const { runner, calls } = scripted([run('completed', 'success')]);
  assert.equal((await planTests({ sha: SHA, waitMinutes: 0, forceTests: 'yes' }, runner, () => Promise.resolve())).kind, 'run-tests');
  assert.deepEqual(calls, []);
});

test('arguments: an empty force value is not forced; anything malformed is refused', () => {
  const parsed = parsePlanArguments([`--sha=${SHA}`, '--wait-minutes=45', '--force-tests=']);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.forceTests, 'no');
  const forced = parsePlanArguments([`--sha=${SHA}`, '--force-tests=true']);
  assert.ok(forced.ok);
  assert.equal(forced.value.forceTests, 'yes');
  for (const bad of [[], ['--sha=abc'], [`--sha=${SHA}`, '--wait-minutes=61'], [`--sha=${SHA}`, '--force-tests=yes'], [`--sha=${SHA}`, '--other']]) {
    assert.ok(!parsePlanArguments(bad).ok, bad.join(' '));
  }
});
