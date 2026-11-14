// Goal: `releaseStatus` says READY TO TAG only when check.yml proved the code being tagged, and
// says why not in every other case: wrong version, tag already pushed, dirty tree, a red or
// missing job, or code changed since the last green run.
// Methodology: the parsers are fed good, malformed and incomplete gh JSON (failures are values);
// the pure rules (selectCheckRuns, versionOnlyDelta, checkJobProblems, assessReadiness) run on
// built facts; gatherFacts runs end to end against a scripted command runner, so no test reaches
// GitHub or a real repository, including a gh failure and a missing field as normal results.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandRequest, CommandRunner } from '../../../scripts/release/releaseCommands.mts';
import { fail, ok } from '../../../scripts/release/releaseResult.mts';
import {
  REQUIRED_CHECK_JOBS,
  assessReadiness,
  checkJobProblems,
  gatherFacts,
  parseCheckJobs,
  parseCheckRuns,
  parseTagNames,
  renderReport,
  selectCheckRuns,
  versionOnlyDelta,
  type CheckJob,
  type CheckRun,
  type ReleaseFacts,
} from '../../../scripts/release/releaseStatus.mts';

const HEAD = 'a'.repeat(40);
const GREEN_BASE = 'b'.repeat(40);

const greenJobs: readonly CheckJob[] = REQUIRED_CHECK_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));

function run(headSha: string, status: string, conclusion: string | undefined, id = 1): CheckRun {
  return { id, headSha, status, conclusion, url: `https://github.com/flowtricks/stacki/actions/runs/${id}` };
}

// The fields a test varies, named one by one (a Partial parameter is banned by AGENTS.md).
interface FactOverrides {
  readonly version?: string;
  readonly tagOnOrigin?: boolean;
  readonly modifiedTrackedPaths?: readonly string[];
  readonly unpushedCount?: number;
  readonly exact?: ReleaseFacts['exact'];
  readonly base?: ReleaseFacts['base'];
}

function facts(overrides: FactOverrides): ReleaseFacts {
  return {
    sha: HEAD,
    version: '1.4.4',
    latestReleased: '1.4.3',
    tagOnOrigin: false,
    modifiedTrackedPaths: [],
    untrackedCount: 0,
    unpushedCount: 0,
    exact: undefined,
    base: undefined,
    ...overrides,
  };
}

test('parseCheckRuns reads gh output and turns every malformed shape into a failure value', () => {
  const good = parseCheckRuns('[{"databaseId":7,"headSha":"abc","status":"completed","conclusion":"success","url":"u"},{"databaseId":8,"headSha":"def","status":"in_progress","conclusion":"","url":"v"}]');
  assert.ok(good.ok);
  assert.equal(good.value[0]?.conclusion, 'success');
  assert.equal(good.value[1]?.conclusion, undefined, 'a pending run has no conclusion');
  const cases: readonly (readonly [string, string])[] = [
    ['', 'json-malformed'],
    ['{', 'json-malformed'],
    ['{}', 'json-shape'],
    ['[1]', 'json-shape'],
    ['[{"headSha":"a","status":"completed","url":"u"}]', 'json-field'],
    ['[{"databaseId":"7","headSha":"a","status":"completed","url":"u"}]', 'json-field'],
    ['[{"databaseId":7,"status":"completed","url":"u"}]', 'json-field'],
    ['[{"databaseId":7,"headSha":"a","url":"u"}]', 'json-field'],
    ['[{"databaseId":7,"headSha":"a","status":"completed"}]', 'json-field'],
  ];
  for (const [text, code] of cases) {
    const result = parseCheckRuns(text);
    assert.ok(!result.ok, text);
    assert.equal(result.error.code, code, text);
  }
});

test('parseCheckJobs reads the jobs object and rejects missing or malformed jobs', () => {
  const good = parseCheckJobs('{"jobs":[{"name":"policy","status":"completed","conclusion":"success"},{"name":"test (windows-latest)","status":"queued","conclusion":""}]}');
  assert.ok(good.ok);
  assert.equal(good.value.length, 2);
  assert.equal(good.value[1]?.conclusion, undefined);
  for (const text of ['[]', '{}', '{"jobs":{}}', '{"jobs":[1]}', '{"jobs":[{"status":"completed"}]}', '{"jobs":[{"name":"x"}]}', 'nope']) {
    assert.ok(!parseCheckJobs(text).ok, text);
  }
});

test('parseTagNames keeps tag names and drops peeled entries and noise', () => {
  const output = [`${'1'.repeat(40)}\trefs/tags/v1.4.1`, `${'2'.repeat(40)}\trefs/tags/v1.4.1^{}`, `${'3'.repeat(40)}\trefs/tags/v1.4.2`, 'garbage', ''].join('\n');
  assert.deepEqual(parseTagNames(output), ['v1.4.1', 'v1.4.2']);
});

test('selectCheckRuns finds the exact run and the nearest green ancestor, newest attempt first', () => {
  const ancestry = [HEAD, 'c'.repeat(40), GREEN_BASE, 'd'.repeat(40), 'e'.repeat(40)];
  const runs = [
    run('f'.repeat(40), 'completed', 'success', 9), // Not an ancestor: ignored.
    run('c'.repeat(40), 'completed', 'failure', 8), // Ancestor but red: ignored.
    run(GREEN_BASE, 'completed', 'success', 7),
    run('e'.repeat(40), 'completed', 'success', 6), // Older green: farther away.
  ];
  const selected = selectCheckRuns(runs, HEAD, ancestry);
  assert.equal(selected.exact, undefined);
  assert.equal(selected.base?.run.id, 7);
  assert.equal(selected.base?.distance, 2);
  const withExact = selectCheckRuns([run(HEAD, 'in_progress', undefined, 10), ...runs], HEAD, ancestry);
  assert.equal(withExact.exact?.id, 10);
  assert.equal(selectCheckRuns([], HEAD, ancestry).base, undefined);
  assert.equal(selectCheckRuns([run(HEAD, 'completed', 'success')], HEAD, [HEAD]).base, undefined, 'the SHA is never its own base');
});

test('versionOnlyDelta allows exactly the version files and release notes', () => {
  assert.deepEqual(versionOnlyDelta(['package.json', 'docs/releases.md', 'studio/src/shared/release.json']), { allowed: true, offending: [] });
  assert.deepEqual(versionOnlyDelta([]), { allowed: true, offending: [] });
  const mixed = versionOnlyDelta(['package.json', 'src/app.ts', 'packages/create-stacki/package.json', 'docs/release-runbook.md']);
  assert.equal(mixed.allowed, false);
  assert.deepEqual(mixed.offending, ['src/app.ts', 'docs/release-runbook.md']);
  assert.equal(versionOnlyDelta(['package.json.bak']).allowed, false);
  assert.equal(versionOnlyDelta(['./package.json']).allowed, false, 'paths are compared exactly');
});

test('checkJobProblems demands every required job, so a dropped platform is not green', () => {
  assert.deepEqual(checkJobProblems(greenJobs), []);
  assert.deepEqual(checkJobProblems(greenJobs.slice(0, 3)), ['test (windows-latest): missing from the run']);
  const red = greenJobs.map((job) => (job.name === 'test (macos-latest)' ? { ...job, conclusion: 'failure' } : job));
  assert.deepEqual(checkJobProblems(red), ['test (macos-latest): failure']);
  assert.equal(checkJobProblems([]).length, REQUIRED_CHECK_JOBS.length);
});

test('READY when check.yml is green on the exact SHA', () => {
  const verdict = assessReadiness(facts({ exact: { run: run(HEAD, 'completed', 'success'), jobs: greenJobs } }));
  assert.equal(verdict.ready, true);
  assert.match(verdict.text, /exact SHA/);
});

test('READY when green on an ancestor and only version files changed since', () => {
  const base = { run: run(GREEN_BASE, 'completed', 'success', 2), jobs: greenJobs, distance: 1, deltaPaths: ['package.json', 'docs/releases.md'] };
  const verdict = assessReadiness(facts({ base, unpushedCount: 1 }));
  assert.equal(verdict.ready, true);
  assert.match(verdict.text, /one push/);
  // A check still running on the bump commit does not block: the version-only rule covers it.
  const running = assessReadiness(facts({ base, exact: { run: run(HEAD, 'in_progress', undefined, 3), jobs: [] } }));
  assert.equal(running.ready, true);
});

test('NOT READY when code changed since the green run', () => {
  const base = { run: run(GREEN_BASE, 'completed', 'success'), jobs: greenJobs, distance: 3, deltaPaths: ['package.json', 'src/features/style/embed/useEditorScanning.ts'] };
  const verdict = assessReadiness(facts({ base }));
  assert.equal(verdict.ready, false);
  assert.match(verdict.text, /1 file\(s\) changed since that are not version files \(src\/features/);
});

test('NOT READY when no green run exists in range', () => {
  const verdict = assessReadiness(facts({}));
  assert.equal(verdict.ready, false);
  assert.match(verdict.text, /no green check\.yml/);
});

test('NOT READY when the exact run failed, even if an older run was green', () => {
  const failed = greenJobs.map((job) => (job.name === 'test (windows-latest)' ? { ...job, conclusion: 'failure' } : job));
  const base = { run: run(GREEN_BASE, 'completed', 'success'), jobs: greenJobs, distance: 1, deltaPaths: ['package.json'] };
  const verdict = assessReadiness(facts({ base, exact: { run: run(HEAD, 'completed', 'failure', 4), jobs: failed } }));
  assert.equal(verdict.ready, false);
  assert.match(verdict.text, /test \(windows-latest\): failure/);
});

test('NOT READY when a successful run lacks a required job', () => {
  const verdict = assessReadiness(facts({ exact: { run: run(HEAD, 'completed', 'success'), jobs: greenJobs.slice(0, 2) } }));
  assert.equal(verdict.ready, false);
  assert.match(verdict.text, /required jobs are not green/);
});

test('NOT READY on a minor bump, a repeated version, an existing tag and a dirty tree', () => {
  const exact = { run: run(HEAD, 'completed', 'success'), jobs: greenJobs };
  assert.match(assessReadiness(facts({ exact, version: '1.5.0' })).text, /minor bump/);
  assert.match(assessReadiness(facts({ exact, version: '1.4.3' })).text, /already released/);
  assert.match(assessReadiness(facts({ exact, tagOnOrigin: true })).text, /Never move it/);
  const dirty = assessReadiness(facts({ exact, modifiedTrackedPaths: ['src/a.ts'] }));
  assert.equal(dirty.ready, false);
  assert.match(dirty.text, /uncommitted changes to tracked files \(src\/a\.ts\)/);
});

test('renderReport ends with the verdict line', () => {
  const exact = { run: run(HEAD, 'completed', 'success'), jobs: greenJobs };
  const ready = facts({ exact });
  assert.match(renderReport(ready, assessReadiness(ready)).split('\n').at(-1) ?? '', /^READY TO TAG: /);
  const blocked = facts({});
  assert.match(renderReport(blocked, assessReadiness(blocked)).split('\n').at(-1) ?? '', /^NOT READY: /);
});

// A scripted runner answers by the command text, so gatherFacts runs without git or gh.
function scripted(answers: Readonly<Record<string, string | undefined>>): CommandRunner {
  return (request: CommandRequest) => {
    const text = `${request.command} ${request.argumentsList.join(' ')}`;
    for (const [prefix, answer] of Object.entries(answers)) {
      if (text.startsWith(prefix)) {
        return answer === undefined ? fail('command-failed', `${prefix} failed`) : ok(answer);
      }
    }
    return fail('command-unscripted', `no answer for ${text}`);
  };
}

const RUNS_JSON = JSON.stringify([
  { databaseId: 2, headSha: GREEN_BASE, status: 'completed', conclusion: 'success', url: 'https://example.test/runs/2' },
]);
const JOBS_JSON = JSON.stringify({ jobs: REQUIRED_CHECK_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })) });

function happyAnswers(): Record<string, string | undefined> {
  return {
    'git rev-parse --verify': `${HEAD}\n`,
    [`git show ${HEAD}:package.json`]: '{"name":"stacki","version":"1.4.4"}',
    'git ls-remote --tags': `${'1'.repeat(40)}\trefs/tags/v1.4.3\n${'2'.repeat(40)}\trefs/tags/v1.4.3^{}\n`,
    'git status --porcelain': ' M package.json\n?? notes.txt\n',
    'git rev-list --max-count': `${HEAD}\n${GREEN_BASE}\n`,
    'gh run list': RUNS_JSON,
    'gh run view 2': JOBS_JSON,
    [`git diff --name-only ${GREEN_BASE} ${HEAD}`]: 'package.json\ndocs/releases.md\n',
    'git ls-remote origin refs/heads/main': `${GREEN_BASE}\trefs/heads/main\n`,
    'git rev-list --count': '1\n',
  };
}

test('gatherFacts assembles the facts from scripted gh and git answers', () => {
  const gathered = gatherFacts('HEAD', scripted(happyAnswers()));
  assert.ok(gathered.ok);
  assert.equal(gathered.value.version, '1.4.4');
  assert.equal(gathered.value.latestReleased, '1.4.3');
  assert.equal(gathered.value.tagOnOrigin, false);
  assert.deepEqual(gathered.value.modifiedTrackedPaths, ['package.json'], 'the leading space of a porcelain line is kept');
  assert.equal(gathered.value.untrackedCount, 1);
  assert.equal(gathered.value.unpushedCount, 1);
  assert.equal(gathered.value.base?.distance, 1);
  assert.equal(assessReadiness(gathered.value).ready, false, 'the modified package.json blocks');
  const clean = gatherFacts('HEAD', scripted({ ...happyAnswers(), 'git status --porcelain': '' }));
  assert.ok(clean.ok);
  assert.equal(assessReadiness(clean.value).ready, true);
});

test('gatherFacts returns each failed read as a value, never a guess', () => {
  const failing: readonly (readonly [string, string | undefined, string])[] = [
    ['git rev-parse --verify', undefined, 'command-failed'],
    [`git show ${HEAD}:package.json`, '{"name":"stacki"}', 'json-field'],
    [`git show ${HEAD}:package.json`, 'not json', 'json-malformed'],
    ['git ls-remote --tags', undefined, 'command-failed'],
    ['git ls-remote --tags', '', 'tags-none'],
    ['gh run list', undefined, 'command-failed'],
    ['gh run list', '{"oops":true}', 'json-shape'],
    ['gh run list', '[{"headSha":"x"}]', 'json-field'],
    ['gh run view 2', '[]', 'json-shape'],
    [`git diff --name-only ${GREEN_BASE} ${HEAD}`, undefined, 'command-failed'],
  ];
  for (const [prefix, answer, code] of failing) {
    const gathered = gatherFacts('HEAD', scripted({ ...happyAnswers(), [prefix]: answer }));
    assert.ok(!gathered.ok, `${prefix} -> ${String(answer)}`);
    assert.equal(gathered.error.code, code, `${prefix} -> ${String(answer)}`);
  }
});

test('gatherFacts crashes on a reference that does not resolve to a full SHA', () => {
  assert.throws(() => gatherFacts('HEAD', scripted({ ...happyAnswers(), 'git rev-parse --verify': 'abc123\n' })), /rev-parse returned a full SHA/);
});

test('an unreadable remote leaves the unpushed count unknown instead of failing the status', () => {
  const gathered = gatherFacts('HEAD', scripted({ ...happyAnswers(), 'git ls-remote origin refs/heads/main': undefined }));
  assert.ok(gathered.ok);
  assert.equal(gathered.value.unpushedCount, undefined);
});
