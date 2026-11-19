// Goal: the post-release chain acts only on a finished Release run for a vX.Y.Z tag push whose tag
// on origin names the run's commit; it publishes create-stacki once (reusing a run already going,
// or nothing when npm has the version), treats a missing site token as a warning, and on failure
// applies the rerun policy: at most one rerun, then hands the green run back to itself.
// Methodology: classifyRun is pure; publishNpm, deploySite and applyRerunPolicy run against a
// scripted gh, git and npm with recorded writes, a fixed clock and an instant sleeper.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordingReporter } from '../../../scripts/release/actionsReport.mts';
import type { CommandRequest } from '../../../scripts/release/releaseCommands.mts';
import { applyRerunPolicy, classifyRun, deploySite, parsePostArguments, publishNpm, renderFinalSummary, type PostDependencies, POST_VERIFY_GROUPS } from '../../../scripts/release/releasePost.mts';
import { fail, ok, type Result } from '../../../scripts/release/releaseResult.mts';
import type { WorkflowRun } from '../../../scripts/release/releaseRuns.mts';
import type { WriteRequest } from '../../../scripts/release/releaseWrite.mts';

const SHA = 'c'.repeat(40);
const NOW = Date.parse('2026-11-15T10:00:00Z');

function workflowRun(overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    databaseId: 9,
    workflowName: 'Release',
    event: 'push',
    headBranch: 'v1.4.4',
    headSha: SHA,
    status: 'completed',
    conclusion: 'success',
    attempt: 1,
    createdAt: '2026-11-15T10:00:05Z',
    url: 'https://example.test/runs/9',
    ...overrides,
  };
}

function asRun(record: Readonly<Record<string, unknown>>): WorkflowRun {
  return {
    id: Number(record['databaseId']),
    workflowName: String(record['workflowName']),
    event: String(record['event']),
    headBranch: String(record['headBranch']),
    headSha: String(record['headSha']),
    status: String(record['status']),
    conclusion: typeof record['conclusion'] === 'string' ? record['conclusion'] : undefined,
    attempt: Number(record['attempt']),
    createdAt: String(record['createdAt']),
    url: String(record['url']),
  };
}

interface Script {
  readonly answer: (request: CommandRequest) => Result<string>;
  readonly writes: WriteRequest[];
}

function dependencies(script: Script): PostDependencies {
  const { reporter } = recordingReporter();
  return {
    runner: script.answer,
    writer: (request) => {
      script.writes.push(request);
      return ok('');
    },
    reporter,
    sleeper: () => Promise.resolve(),
    now: () => NOW,
  };
}

test('only a finished Release tag push whose tag names its commit is acted on', () => {
  assert.equal(classifyRun(asRun(workflowRun({})), SHA).kind, 'publish');
  assert.equal(classifyRun(asRun(workflowRun({ conclusion: 'failure' })), SHA).kind, 'rerun-policy');
  const ignored = [
    [workflowRun({ workflowName: 'Check' }), SHA],
    [workflowRun({ event: 'workflow_dispatch' }), SHA],
    [workflowRun({ headBranch: 'main' }), SHA],
    [workflowRun({}), 'd'.repeat(40)],
    [workflowRun({}), undefined],
    [workflowRun({ status: 'in_progress', conclusion: '' }), SHA],
    [workflowRun({ conclusion: 'cancelled' }), SHA],
  ] as const;
  for (const [record, tagSha] of ignored) {
    assert.equal(classifyRun(asRun(record), tagSha).kind, 'ignore', JSON.stringify(record));
  }
});

test('publishing dispatches once, finds its run, and waits for it', async () => {
  let listed = 0;
  const script: Script = {
    writes: [],
    answer: (request) => {
      const [first, second] = request.argumentsList;
      if (request.command === 'npm') {
        return fail('command-failed', 'E404');
      }
      if (first === 'run' && second === 'list') {
        listed += 1;
        return ok(listed === 1 ? '[]' : JSON.stringify([workflowRun({ workflowName: 'Publish create-stacki', event: 'workflow_dispatch', status: 'queued', conclusion: '' })]));
      }
      if (first === 'run' && second === 'view') {
        return ok(JSON.stringify(workflowRun({ workflowName: 'Publish create-stacki', event: 'workflow_dispatch' })));
      }
      return fail('command-failed', 'unscripted');
    },
  };
  const result = await publishNpm('1.4.4', SHA, dependencies(script));
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(script.writes.length, 1);
  assert.deepEqual(script.writes[0]?.argumentsList, ['workflow', 'run', 'publish-create-stacki.yml', '--repo', 'flowtricks/stacki', '--ref', 'v1.4.4']);
});

test('publishing is idempotent: npm already has it, or a run is already going', async () => {
  const onNpm: Script = { writes: [], answer: (request) => (request.command === 'npm' ? ok('1.4.4\n') : fail('command-failed', 'unscripted')) };
  assert.ok((await publishNpm('1.4.4', SHA, dependencies(onNpm))).ok);
  assert.deepEqual(onNpm.writes, []);
  const going: Script = {
    writes: [],
    answer: (request) => {
      if (request.command === 'npm') {
        return fail('command-failed', 'E404');
      }
      if (request.argumentsList[1] === 'list') {
        return ok(JSON.stringify([workflowRun({ status: 'in_progress', conclusion: '' })]));
      }
      return ok(JSON.stringify(workflowRun({})));
    },
  };
  assert.ok((await publishNpm('1.4.4', SHA, dependencies(going))).ok);
  assert.deepEqual(going.writes, [], 'a run already going is waited for, not duplicated');
});

test('a failed publish is reported with the trusted-publisher hint', async () => {
  const script: Script = {
    writes: [],
    answer: (request) => {
      if (request.command === 'npm') {
        return fail('command-failed', 'E404');
      }
      if (request.argumentsList[1] === 'list') {
        return ok(JSON.stringify([workflowRun({ status: 'in_progress', conclusion: '' })]));
      }
      return ok(JSON.stringify(workflowRun({ conclusion: 'failure' })));
    },
  };
  const result = await publishNpm('1.4.4', SHA, dependencies(script));
  assert.ok(!result.ok);
  assert.match(result.error.message, /trusted publisher/);
});

test('the site deploy is skipped with a warning without its token, and the final verify still checks the site', async () => {
  const skipped = await deploySite('no', dependencies({ writes: [], answer: () => fail('command-failed', 'unused') }));
  assert.equal(skipped.kind, 'skipped');
  assert.ok(skipped.kind === 'skipped' && skipped.reason.includes('still checks the site'));
  assert.deepEqual(POST_VERIFY_GROUPS.split(','), ['release', 'npm', 'site'], 'the site rows are never left out (1.4.7, 1.4.8)');
  const broken = await deploySite('yes', dependencies({ writes: [], answer: () => fail('command-failed', 'HTTP 403') }));
  assert.equal(broken.kind, 'failed');
});

test('the rerun policy reruns a known flake once, then hands the green run back', async () => {
  let viewed = 0;
  const script: Script = {
    writes: [],
    answer: (request) => {
      const argumentsList = request.argumentsList;
      if (argumentsList.includes('--log-failed')) {
        return ok('build-windows\tRun npm test\t2026-11-15T10:00:00.0000000Z Error: EBUSY: resource busy or locked, rmdir \'D:\\x\'');
      }
      if (argumentsList.includes('jobs')) {
        return ok(JSON.stringify({ jobs: [{ databaseId: 3, name: 'build-windows', conclusion: 'failure' }, { databaseId: 4, name: 'build-mac', conclusion: 'success' }] }));
      }
      if (argumentsList[0] === 'api') {
        return ok('[]');
      }
      viewed += 1;
      return ok(JSON.stringify(workflowRun(viewed < 2 ? { attempt: 2, status: 'in_progress', conclusion: '' } : { attempt: 2 })));
    },
  };
  const result = await applyRerunPolicy(9, 1, dependencies(script));
  assert.equal(result.kind, 'rerun-passed');
  assert.deepEqual(
    script.writes.map((write) => write.argumentsList.slice(0, 3).join(' ')),
    ['run rerun 9', 'workflow run release-post.yml'],
  );
});

test('the rerun policy stops on a real failure without writing anything', async () => {
  const script: Script = {
    writes: [],
    answer: (request) => {
      if (request.argumentsList.includes('--log-failed')) {
        return ok('build-mac\tRun npm test\t2026-11-15T10:00:00.0000000Z AssertionError: expected 1 to equal 2');
      }
      if (request.argumentsList.includes('jobs')) {
        return ok(JSON.stringify({ jobs: [{ databaseId: 3, name: 'build-mac', conclusion: 'failure' }] }));
      }
      return ok('[]');
    },
  };
  const result = await applyRerunPolicy(9, 1, dependencies(script));
  assert.equal(result.kind, 'stopped');
  assert.deepEqual(script.writes, []);
});

test('the summary names every stage and the links; arguments are strict', () => {
  const summary = renderFinalSummary('1.4.4', new Map([['publish-npm', 'success'], ['verify', 'failure']]));
  assert.match(summary, /Release 1\.4\.4: NOT complete/);
  assert.match(summary, /releases\/tag\/v1\.4\.4/);
  assert.match(summary, /create-stacki\/v\/1\.4\.4/);
  assert.ok(parsePostArguments(['--stage=resolve', '--run-id=5']).ok);
  assert.ok(!parsePostArguments(['--stage=ship']).ok);
  assert.ok(!parsePostArguments(['stage']).ok);
});
