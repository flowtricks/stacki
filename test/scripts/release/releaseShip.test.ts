// Goal: `npm run release:ship` always takes the one right next step from what GitHub says, and
// never a wrong one: bump only when the version on main is public (or was burned by the old
// process), tag only when Check and the candidate are both green on the exact SHA, rerun only an
// explained infrastructure flake once, re-run a failed promotion on the same tag instead of
// burning a version, and stop with the job URL on anything real. The bump is a GitHub commit made
// from origin's files (never the working tree) and moves main by fast-forward only.
// Methodology: decideShip is pure and is driven through every state; the remote bump runs against
// a scripted gh that serves the seven files and records every write; the loop runs with an instant
// sleeper and a fake clock, so the minute-five forecast and the bounded dispatch fallback are
// exercised without waiting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CandidateEvidence } from '../../../scripts/release/promote.mts';
import { parseCompareSubjects, planRemoteBump, writeRemoteBump } from '../../../scripts/release/releaseBump.mts';
import type { CommandRunner } from '../../../scripts/release/releaseCommands.mts';
import { fail, ok } from '../../../scripts/release/releaseResult.mts';
import type { WorkflowRun } from '../../../scripts/release/releaseRuns.mts';
import { decideShip, forecastText, parseRemoteTags, parseShipArguments, progressText, ship, type ShipFacts } from '../../../scripts/release/releaseShip.mts';
import { REQUIRED_CHECK_JOBS, type RunEvidence } from '../../../scripts/release/releaseStatus.mts';
import type { WriteRequest, WriteRunner } from '../../../scripts/release/releaseWrite.mts';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

function check(status: string, conclusion: string | undefined): RunEvidence {
  return {
    run: { id: 11, headSha: HEAD, status, conclusion, url: 'https://example.test/check/11' },
    jobs: REQUIRED_CHECK_JOBS.map((name) => ({ name, status, conclusion })),
  };
}

function candidate(status: string, conclusion: string | undefined): CandidateEvidence {
  return {
    run: { id: 22, headSha: HEAD, status, conclusion, displayTitle: 'Candidate 1.4.8', url: 'https://example.test/candidate/22' },
    jobs: [{ name: 'candidate', status, conclusion }],
  };
}

function run(fields: Pick<WorkflowRun, 'status' | 'conclusion' | 'attempt'>): WorkflowRun {
  return {
    id: 33,
    workflowName: 'Release',
    event: 'push',
    headBranch: 'v1.4.8',
    headSha: HEAD,
    createdAt: '2026-11-17T20:00:00Z',
    url: 'https://example.test/release/33',
    ...fields,
  };
}

const BASE: ShipFacts = {
  originSha: HEAD,
  version: '1.4.8',
  tags: [{ name: 'v1.4.7', sha: OLD }],
  check: check('completed', 'success'),
  checkFailure: undefined,
  candidate: candidate('completed', 'success'),
  candidateFailure: undefined,
  releaseRun: undefined,
  published: false,
  postRun: undefined,
};

test('an unreleased version: wait while either run works, tag only when both are green', () => {
  assert.deepEqual(decideShip(BASE), { kind: 'tag', version: '1.4.8', sha: HEAD });
  assert.equal(decideShip({ ...BASE, check: undefined }).kind, 'wait');
  assert.equal(decideShip({ ...BASE, candidate: candidate('in_progress', undefined) }).kind, 'wait');
  const stopped = decideShip({ ...BASE, check: check('completed', 'failure'), checkFailure: { kind: 'stop', reason: 'a test failed.', nextStep: 'fix' } });
  assert.equal(stopped.kind, 'stop');
  assert.ok(stopped.kind === 'stop' && stopped.reason.includes('https://example.test/check/11'));
  assert.deepEqual(decideShip({ ...BASE, candidate: candidate('completed', 'failure'), candidateFailure: { kind: 'rerun', matches: [] } }), {
    kind: 'rerun',
    workflow: 'candidate.yml',
    runId: 22,
  });
  assert.equal(decideShip({ ...BASE, candidate: candidate('completed', 'failure'), candidateFailure: undefined }).kind, 'stop', 'an unexplained failure stops');
  const skipped = { ...candidate('completed', 'success'), jobs: [{ name: 'candidate', status: 'completed', conclusion: 'skipped' }] };
  assert.equal(decideShip({ ...BASE, candidate: skipped }).kind, 'stop', 'a candidate that built nothing is not green');
});

test('a released version on main: bump to the next patch, only on a green Check of that exact SHA', () => {
  const released: ShipFacts = { ...BASE, version: '1.4.7', tags: [{ name: 'v1.4.7', sha: OLD }], published: true };
  assert.deepEqual(decideShip(released), { kind: 'bump', previous: '1.4.7', version: '1.4.8', baseSha: HEAD, note: undefined });
  assert.equal(decideShip({ ...released, check: undefined }).kind, 'wait', 'no Check yet: no bump');
  assert.equal(decideShip({ ...released, check: check('in_progress', undefined) }).kind, 'wait', 'Check running: no bump');
  const red = decideShip({ ...released, check: check('completed', 'failure'), checkFailure: { kind: 'stop', reason: 'a test failed.', nextStep: 'fix' } });
  assert.ok(red.kind === 'stop' && red.reason.includes('nothing is bumped'));
  assert.deepEqual(decideShip({ ...released, check: check('completed', 'failure'), checkFailure: { kind: 'rerun', matches: [] } }), { kind: 'rerun', workflow: 'check.yml', runId: 11 });
  const burned = decideShip({ ...BASE, version: '1.4.6', tags: [{ name: 'v1.4.6', sha: OLD }, { name: 'v1.4.7', sha: OLD }], published: false });
  assert.equal(burned.kind, 'bump');
  assert.ok(burned.kind === 'bump' && burned.version === '1.4.8' && (burned.note ?? '').includes('never published'));
});

test('a tag on main: wait for promotion, rerun a failed one on the same tag once, then stop', () => {
  const tagged: ShipFacts = { ...BASE, tags: [{ name: 'v1.4.8', sha: HEAD }] };
  assert.equal(decideShip(tagged).kind, 'wait');
  assert.equal(decideShip({ ...tagged, releaseRun: run({ status: 'in_progress', conclusion: undefined, attempt: 1 }) }).kind, 'wait');
  assert.deepEqual(decideShip({ ...tagged, releaseRun: run({ status: 'completed', conclusion: 'failure', attempt: 1 }) }), { kind: 'rerun', workflow: 'release.yml', runId: 33 });
  const twice = decideShip({ ...tagged, releaseRun: run({ status: 'completed', conclusion: 'failure', attempt: 2 }) });
  assert.ok(twice.kind === 'stop' && twice.nextStep.includes('Never move the tag'));
  const live = { ...tagged, published: true, releaseRun: run({ status: 'completed', conclusion: 'success', attempt: 1 }) };
  assert.equal(decideShip(live).kind, 'wait', 'public, Release post not started');
  assert.equal(decideShip({ ...live, postRun: run({ status: 'completed', conclusion: 'success', attempt: 1 }) }).kind, 'done');
  assert.equal(decideShip({ ...live, postRun: run({ status: 'completed', conclusion: 'failure', attempt: 1 }) }).kind, 'stop');
});

test('progress, forecast, tags and arguments', () => {
  const jobs = [
    { name: 'test shard (macos-latest, 1/4)', status: 'queued', conclusion: undefined },
    { name: 'test shard (ubuntu-latest, 1/4)', status: 'completed', conclusion: 'failure' },
    { name: 'policy', status: 'completed', conclusion: 'success' },
  ];
  assert.equal(progressText(jobs), '2/3 jobs done, 1 failed, 1 macOS queued');
  assert.equal(forecastText(4, { check: undefined, candidate: undefined }), undefined, 'no forecast before minute five');
  assert.match(forecastText(5, { check: { ...check('in_progress', undefined), jobs }, candidate: undefined }) ?? '', /AT RISK, 1 job/);
  assert.match(forecastText(6, BASE) ?? '', /on track/);
  const tags = parseRemoteTags(`${OLD}\trefs/tags/v1.4.7\n${HEAD}\trefs/tags/v1.4.7^{}\n${OLD}\trefs/tags/nightly\n`);
  assert.deepEqual(tags, ok([{ name: 'v1.4.7', sha: HEAD }]), 'an annotated tag resolves to its commit');
  assert.deepEqual(parseShipArguments([]), ok('look'));
  assert.deepEqual(parseShipArguments(['--confirm']), ok('confirm'));
  assert.equal(parseShipArguments(['--force']).ok, false);
  assert.throws(() => decideShip({ ...BASE, originSha: 'main' }), /Assertion failed: decideShip: origin is a full SHA/);
});

const FILES: ReadonlyMap<string, string> = new Map([
  ['package.json', '{\n  "name": "stacki",\n  "version": "1.4.7",\n  "private": true\n}\n'],
  ['package-lock.json', '{\n  "name": "stacki",\n  "version": "1.4.7",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "stacki",\n      "version": "1.4.7"\n    }\n  }\n}\n'],
  ['packages/create-stacki/package.json', '{\n  "name": "create-stacki",\n  "version": "1.4.7"\n}\n'],
  ['studio/package.json', '{\n  "name": "astro-studio",\n  "version": "1.4.7"\n}\n'],
  ['studio/package-lock.json', '{\n  "name": "astro-studio",\n  "version": "1.4.7",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "astro-studio",\n      "version": "1.4.7"\n    }\n  }\n}\n'],
  ['studio/src/shared/release.json', '{\n  "version": "1.4.7"\n}\n'],
  ['docs/releases.md', '# Releases\n\n## 1.4.7\n\n- Earlier.\n'],
]);

function remote(): CommandRunner {
  return (request) => {
    const target = request.argumentsList.find((argument) => argument.startsWith('repos/')) ?? '';
    const file = /contents\/(.+)\?ref=/.exec(target)?.[1];
    if (file !== undefined) {
      const text = FILES.get(file);
      return text === undefined ? fail('command-failed', `404 ${file}`) : ok(text);
    }
    if (target.includes('/compare/')) {
      return ok(JSON.stringify([
        { message: 'fix(props): an unset prop shows its default\n\nbody', parents: 1 },
        { message: 'Merge branch x', parents: 2 },
        { message: 'feat(release): build once, promote', parents: 1 },
      ]));
    }
    if (target.includes('/git/commits/')) {
      return ok(JSON.stringify({ sha: HEAD, tree: { sha: 'c'.repeat(40) } }));
    }
    return fail('command-failed', `unexpected ${request.argumentsList.join(' ')}`);
  };
}

test('the remote bump plans from origin files and writes blobs, a tree, a commit and a fast-forward', () => {
  const plan = planRemoteBump({ baseSha: HEAD, previous: '1.4.7', version: '1.4.8' }, remote());
  assert.ok(plan.ok, plan.ok ? '' : plan.error.message);
  assert.deepEqual(
    plan.value.changes.map((change) => change.path),
    [...FILES.keys()].filter((name) => name !== 'docs/releases.md').concat('docs/releases.md'),
  );
  assert.ok(plan.value.changes.every((change) => !change.text.includes('"version": "1.4.7"')), 'every version line moved');
  assert.ok((plan.value.changes.at(-1)?.text ?? '').includes('## 1.4.8'));
  assert.equal(plan.value.commitSubject, 'chore(release): version 1.4.8');
  const writes: WriteRequest[] = [];
  let created = 0;
  const writer: WriteRunner = (request) => {
    writes.push(request);
    created += 1;
    return ok(JSON.stringify({ sha: String(created % 10).repeat(40) }));
  };
  const commit = writeRemoteBump(plan.value, remote(), writer);
  assert.ok(commit.ok);
  const endpoints = writes.map((request) => request.argumentsList.slice(1, 4).join(' '));
  assert.equal(endpoints.filter((endpoint) => endpoint.endsWith('git/blobs')).length, 7);
  assert.deepEqual(endpoints.slice(7), ['--method POST repos/flowtricks/stacki/git/trees', '--method POST repos/flowtricks/stacki/git/commits', '--method PATCH repos/flowtricks/stacki/git/refs/heads/main']);
  assert.deepEqual(writes.at(-1)?.argumentsList.slice(-2), ['-F', 'force=false'], 'main moves by fast-forward only');
  const refusing: WriteRunner = (request) => (request.argumentsList[2] === 'PATCH' ? fail('command-failed', '422 Update is not a fast forward') : ok(JSON.stringify({ sha: HEAD })));
  const moved = writeRemoteBump(plan.value, remote(), refusing);
  assert.ok(!moved.ok && moved.error.code === 'main-moved');
});

test('compare subjects skip merges, read newest first, and refuse bad shapes', () => {
  const subjects = parseCompareSubjects('[{"message":"a","parents":1},{"message":"m","parents":2},{"message":"b\\nbody","parents":1}]');
  assert.deepEqual(subjects, ok([{ subject: 'b' }, { subject: 'a' }]));
  assert.equal(parseCompareSubjects('{}').ok, false);
  assert.equal(parseCompareSubjects('[{"message":"a"}]').ok, false);
});

test('the loop: a look writes nothing; a confirmed run tags once, then stops if release.yml never starts', async () => {
  let clockMs = 0;
  const lines: string[] = [];
  const writes: string[] = [];
  let tagged = false;
  const runner: CommandRunner = (request) => {
    const joined = request.argumentsList.join(' ');
    if (joined.startsWith('ls-remote origin refs/heads/main')) {
      return ok(`${HEAD}\trefs/heads/main\n`);
    }
    if (joined.startsWith('ls-remote --tags')) {
      return ok(`${OLD}\trefs/tags/v1.4.7\n${tagged ? `${HEAD}\trefs/tags/v1.4.8\n` : ''}`);
    }
    if (joined.includes('contents/package.json')) {
      return ok('{"version":"1.4.8"}');
    }
    if (joined.includes('--workflow check.yml')) {
      return ok(JSON.stringify([{ databaseId: 11, headSha: HEAD, status: 'completed', conclusion: 'success', url: 'https://example.test/check/11' }]));
    }
    if (joined.includes('--workflow candidate.yml')) {
      return ok(JSON.stringify([{ databaseId: 22, headSha: HEAD, status: 'completed', conclusion: 'success', displayTitle: 'Candidate 1.4.8', url: 'https://example.test/candidate/22' }]));
    }
    if (joined.startsWith('run view 11')) {
      return ok(JSON.stringify({ jobs: REQUIRED_CHECK_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })) }));
    }
    if (joined.startsWith('run view 22')) {
      return ok(JSON.stringify({ jobs: [{ name: 'candidate', status: 'completed', conclusion: 'success' }] }));
    }
    if (joined.includes('--workflow release.yml') || joined.includes('--workflow release-post.yml')) {
      return ok('[]');
    }
    if (joined.startsWith('release view')) {
      return fail('command-failed', 'release not found');
    }
    return fail('command-failed', `unexpected ${joined}`);
  };
  const writer: WriteRunner = (request) => {
    writes.push(request.argumentsList.join(' '));
    if (request.argumentsList.includes('ref=refs/tags/v1.4.8')) {
      tagged = true;
    }
    return ok('{}');
  };
  const dependencies = {
    runner,
    writer,
    sleeper: (delayMs: number) => {
      clockMs += delayMs;
      return Promise.resolve();
    },
    now: () => clockMs,
    print: (line: string) => {
      lines.push(line);
    },
  };
  assert.equal(await ship('look', dependencies), 0);
  assert.equal(writes.length, 0, 'a look writes nothing');
  assert.ok(lines.some((line) => line.includes('next: tag v1.4.8')));
  // Confirmed: one tag, then the bounded wait for release.yml, then a stop that moves nothing.
  assert.equal(await ship('confirm', dependencies), 1);
  assert.equal(writes.filter((write) => write.includes('git/refs -f ref=refs/tags/v1.4.8')).length, 1);
  assert.equal(writes.length, 1, 'nothing but the tag is written');
  assert.ok(lines.some((line) => line.includes('STOPPED: release.yml did not start within 3 minutes')));
  assert.ok(clockMs <= 5 * 60_000, 'the stop comes within the bound, not at the iteration cap');
});
