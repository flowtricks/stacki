// Goal: each `test (<os>)` aggregate in check.yml is green only when all four of its platform's
// shards are present once and green, so a red, missing or duplicated shard can never read as a
// green platform; releaseStatus applies the same rule to any run that has shard jobs.
// Methodology: assessShards and checkJobProblems get built job lists: all green, then each single
// defect, and a run from before sharding (no shard jobs) that must still be judged as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessShards, parseShardArguments } from '../../../scripts/release/checkShards.mts';
import { CHECK_OPERATING_SYSTEMS, CHECK_SHARD_COUNT, checkJobProblems, REQUIRED_CHECK_JOBS, shardJobName, type CheckJob } from '../../../scripts/release/releaseStatus.mts';

const job = (name: string, conclusion = 'success'): CheckJob => ({ name, status: 'completed', conclusion });
const shardsFor = (os: string): readonly CheckJob[] => Array.from({ length: CHECK_SHARD_COUNT }, (_, index) => job(shardJobName(os, index + 1)));
const allShards = CHECK_OPERATING_SYSTEMS.flatMap(shardsFor);

test('a platform is green only with every shard present once and green', () => {
  assert.equal(shardJobName('ubuntu-latest', 2), 'test shard (ubuntu-latest, 2/4)');
  assert.deepEqual(assessShards('ubuntu-latest', allShards), { kind: 'green' });
  const red = allShards.map((candidate) => (candidate.name === shardJobName('ubuntu-latest', 3) ? job(candidate.name, 'failure') : candidate));
  assert.equal(assessShards('ubuntu-latest', red).kind, 'red');
  assert.deepEqual(assessShards('macos-latest', red), { kind: 'green' }, 'a red Linux shard does not fail macOS');
  const missing = allShards.filter((candidate) => candidate.name !== shardJobName('windows-latest', 4));
  const verdict = assessShards('windows-latest', missing);
  assert.ok(verdict.kind === 'red' && verdict.problems[0] === 'test shard (windows-latest, 4/4): missing from the run');
  assert.equal(assessShards('ubuntu-latest', [...allShards, job(shardJobName('ubuntu-latest', 1))]).kind, 'red');
});

test('releaseStatus requires every shard too, and still accepts a run from before sharding', () => {
  const aggregates = REQUIRED_CHECK_JOBS.map((name) => job(name));
  assert.deepEqual(checkJobProblems(aggregates), [], 'an unsharded run is judged by its aggregates');
  assert.deepEqual(checkJobProblems([...aggregates, ...allShards]), []);
  const red = [...aggregates, ...allShards.map((candidate) => (candidate.name === shardJobName('macos-latest', 1) ? job(candidate.name, 'cancelled') : candidate))];
  assert.deepEqual(checkJobProblems(red), ['test shard (macos-latest, 1/4): cancelled']);
  const partial = [...aggregates, ...allShards.filter((candidate) => candidate.name !== shardJobName('ubuntu-latest', 2))];
  assert.deepEqual(checkJobProblems(partial), ['test shard (ubuntu-latest, 2/4): missing from the run']);
  const stray = [...aggregates, ...allShards, job('test shard (ubuntu-latest, 5/4)')];
  assert.deepEqual(checkJobProblems(stray), ['test shard (ubuntu-latest, 5/4): not one of the 4 shards']);
});

test('arguments name a known platform, a run and an attempt', () => {
  assert.ok(parseShardArguments(['--os=ubuntu-latest', '--run-id=123', '--attempt=1']).ok);
  for (const bad of [['--os=freebsd', '--run-id=1', '--attempt=1'], ['--os=ubuntu-latest', '--run-id=x', '--attempt=1'], ['--os=ubuntu-latest', '--run-id=1']]) {
    assert.ok(!parseShardArguments(bad).ok, bad.join(' '));
  }
});
