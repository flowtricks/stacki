// Goal: the release helpers stay read-only and their polling stays bounded, so a helper that
// verifies a release can never publish, tag, delete or loop forever.
// Methodology: readOnlyViolation is checked on the commands the helpers use (accepted) and on
// every way a gh, git or npm call could write (refused); the system runner is shown to crash on
// a refused request instead of running it; pollUntil runs with an instant sleeper and counts
// attempts at, below and above its bound. Nothing here reaches GitHub, npm or the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flowtricksEnvironment, pollUntil, readOnlyViolation, systemCommandRunner, type CommandRequest } from '../../../scripts/release/releaseCommands.mts';
import { fail, ok } from '../../../scripts/release/releaseResult.mts';

const gh = (...argumentsList: string[]): CommandRequest => ({ command: 'gh', argumentsList });

test('the commands the helpers use are read-only', () => {
  const accepted: readonly CommandRequest[] = [
    gh('run', 'list', '--repo', 'flowtricks/stacki', '--json', 'headSha'),
    gh('run', 'view', '1', '--json', 'jobs'),
    gh('release', 'view', 'v1.4.4', '--json', 'assets'),
    gh('api', 'repos/flowtricks/stacki/commits/abc/check-runs'),
    gh('auth', 'token', '--user', 'flowtricks'),
    { command: 'git', argumentsList: ['ls-remote', '--tags', 'origin'] },
    { command: 'npm', argumentsList: ['view', 'create-stacki', 'version'] },
    { command: 'npm', argumentsList: ['pack', 'create-stacki@1.4.4', '--dry-run', '--json'] },
  ];
  for (const request of accepted) {
    assert.equal(readOnlyViolation(request), undefined, request.argumentsList.join(' '));
  }
});

test('anything that could write is refused', () => {
  const refused: readonly CommandRequest[] = [
    gh('release', 'create', 'v1.4.4'),
    gh('release', 'edit', 'v1.4.4', '--draft=false'),
    gh('release', 'delete', 'v1.4.4'),
    gh('workflow', 'run', 'publish-create-stacki.yml'),
    gh('run', 'rerun', '1'),
    gh('api', 'repos/x/y/git/refs', '-X', 'POST'),
    gh('api', 'repos/x/y/issues', '--method', 'POST'),
    gh('api', 'repos/x/y/issues', '-f', 'title=x'),
    gh('api', 'repos/x/y/issues', '--field', 'title=x'),
    gh('auth', 'login'),
    gh(),
    { command: 'git', argumentsList: ['push', 'origin', 'main'] },
    { command: 'git', argumentsList: ['tag', 'v1.4.4'] },
    { command: 'git', argumentsList: ['commit', '-m', 'x'] },
    { command: 'git', argumentsList: [] },
    { command: 'npm', argumentsList: ['publish'] },
    { command: 'npm', argumentsList: ['pack', 'create-stacki@1.4.4'] },
    { command: 'npm', argumentsList: ['install'] },
  ];
  for (const request of refused) {
    assert.notEqual(readOnlyViolation(request), undefined, `${request.command} ${request.argumentsList.join(' ')}`);
  }
});

test('the system runner crashes on a refused request instead of running it', () => {
  const runner = systemCommandRunner({});
  assert.throws(() => runner({ command: 'git', argumentsList: ['push', 'origin', 'main'] }), /Assertion failed: release helpers are read-only/);
  assert.throws(() => runner({ command: 'git', argumentsList: ['rev-parse', 'HEAD'], timeoutMs: 0 }), /command timeout is positive/);
});

test('the system runner reports a failing command as a value', () => {
  const runner = systemCommandRunner({ PATH: process.env['PATH'] ?? '' });
  const result = runner({ command: 'git', argumentsList: ['rev-parse', '--verify', 'no-such-ref^{commit}'] });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'command-failed');
});

test('flowtricksEnvironment keeps an existing token and falls back quietly without the account', () => {
  const base = { GH_TOKEN: 'already-set' };
  assert.equal(
    flowtricksEnvironment(base, () => fail('command-failed', 'no')),
    base,
  );
  const none = {};
  assert.equal(
    flowtricksEnvironment(none, () => fail('command-failed', 'no account')),
    none,
  );
  assert.deepEqual(
    flowtricksEnvironment(none, () => ok('tok\n')),
    { GH_TOKEN: 'tok' },
  );
  assert.equal(
    flowtricksEnvironment(none, () => ok('  \n')),
    none,
  );
});

test('pollUntil stops at the first finished attempt and never exceeds its bound', async () => {
  const sleeps: number[] = [];
  const sleeper = (delayMs: number): Promise<void> => {
    sleeps.push(delayMs);
    return Promise.resolve();
  };
  const plan = { attemptsMax: 5, delayMs: 7, sleeper };
  let calls = 0;
  const finished = await pollUntil(
    plan,
    () => Promise.resolve(++calls),
    (value) => value === 3,
  );
  assert.equal(finished, 3);
  assert.deepEqual(sleeps, [7, 7]);

  calls = 0;
  sleeps.length = 0;
  const exhausted = await pollUntil(
    plan,
    () => Promise.resolve(++calls),
    () => false,
  );
  assert.equal(exhausted, 5);
  assert.equal(sleeps.length, 4, 'no sleep after the last attempt');

  calls = 0;
  const single = await pollUntil(
    { ...plan, attemptsMax: 1 },
    () => Promise.resolve(++calls),
    () => false,
  );
  assert.equal(single, 1);
});

test('pollUntil refuses unbounded or negative plans', async () => {
  const sleeper = (): Promise<void> => Promise.resolve();
  const attempt = (): Promise<number> => Promise.resolve(1);
  const done = (): boolean => true;
  await assert.rejects(pollUntil({ attemptsMax: 0, delayMs: 1, sleeper }, attempt, done), /poll attempts are bounded/);
  await assert.rejects(pollUntil({ attemptsMax: 1_000_000, delayMs: 1, sleeper }, attempt, done), /poll attempts are bounded/);
  await assert.rejects(pollUntil({ attemptsMax: 2, delayMs: -1, sleeper }, attempt, done), /poll delay is bounded/);
});
