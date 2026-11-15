// Goal: a failed release is rerun automatically only for a known infrastructure flake, only on the
// first attempt, and only when every failed job is explained; everything else stops with the next
// step. Each entry of knownFlakes.mts has its own regression test here: a log excerpt from the
// failure it names that must match, and a near miss that must not (AGENTS.md: no entry without one).
// Methodology: decideRerun is pure; the log parsers get `gh run view --log-failed` lines with their
// job, step and timestamp columns; the entry-by-entry table below must cover the whole list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWN_FLAKES } from '../../../scripts/release/knownFlakes.mts';
import { decideRerun, logLineText, parseAnnotations, parseRunJobs, REAL_FAILURE_NEXT_STEP, splitFailedLog } from '../../../scripts/release/rerunPolicy.mts';

// One row per flake: the job it happened in, a matching excerpt, and a near miss for the same job.
const REGRESSIONS: readonly { readonly id: string; readonly job: string; readonly hit: string; readonly miss: string }[] = [
  {
    id: 'windows-ebusy-rmdir',
    job: 'build-windows',
    hit: "Error: EBUSY: resource busy or locked, rmdir 'D:\\a\\stacki\\studio\\.studio\\demo'\n",
    miss: "Error: EBUSY: resource busy or locked, open 'D:\\a\\file'\n",
  },
  {
    id: 'macos-tooltip-escape',
    job: 'tests (macos-latest)',
    hit: '[212/290] FAIL renderer/apps/appUiKitTooltip (31.0s)\napp-ui-kit-tooltip: 1 of 9 failed\n  Escape hides it\n    {"hovered":1}\n',
    miss: 'app-ui-kit-tooltip: 2 of 9 failed\n  a press hides it\n  Escape hides it\n',
  },
  {
    id: 'npm-registry-network',
    job: 'build-linux',
    hit: 'npm error code ECONNRESET\nnpm error network aborted\n',
    miss: 'npm error code ERESOLVE\n',
  },
  {
    id: 'service-unavailable',
    job: 'build-mac',
    hit: 'Error: Response status code does not indicate success: 503 (Service Unavailable).\n',
    miss: 'expected status 503 from the preview server, got 200\n',
  },
  {
    id: 'apt-archive-fetch',
    job: 'build-linux',
    hit: 'E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/pool/main/x.deb  404  Not Found [IP: 1.2.3.4 80]\n',
    miss: 'E: Unable to locate package stacki\n',
  },
  {
    id: 'runner-lost',
    job: 'build-windows',
    hit: 'The hosted runner: GitHub Actions 12 lost communication with the server. Anything in your workflow that terminates the runner process...\n',
    miss: 'The operation was canceled.\n',
  },
];

test('every known flake has a regression row, and each row matches its own entry only on the hit', () => {
  assert.deepEqual(
    REGRESSIONS.map((row) => row.id),
    KNOWN_FLAKES.map((flake) => flake.id),
    'add a regression row for every entry in knownFlakes.mts, in the same order',
  );
  for (const row of REGRESSIONS) {
    const hit = decideRerun(1, [{ id: 1, name: row.job, text: row.hit }]);
    assert.equal(hit.kind, 'rerun', row.id);
    assert.ok(hit.kind === 'rerun' && hit.matches[0]?.flake.id === row.id, row.id);
    assert.equal(decideRerun(1, [{ id: 1, name: row.job, text: row.miss }]).kind, 'stop', `${row.id} near miss`);
  }
});

test('a platform flake does not explain a failure on another platform', () => {
  assert.equal(decideRerun(1, [{ id: 1, name: 'build-mac', text: REGRESSIONS[0]?.hit ?? '' }]).kind, 'stop');
  assert.equal(decideRerun(1, [{ id: 1, name: 'build-windows', text: REGRESSIONS[1]?.hit ?? '' }]).kind, 'stop');
});

test('one rerun at most, and only when every failed job is explained', () => {
  const flake = { id: 1, name: 'build-windows', text: REGRESSIONS[0]?.hit ?? '' };
  const real = { id: 2, name: 'build-mac', text: 'AssertionError: expected 1 to equal 2\n' };
  const second = decideRerun(2, [flake]);
  assert.equal(second.kind, 'stop');
  assert.ok(second.kind === 'stop' && second.nextStep === REAL_FAILURE_NEXT_STEP);
  assert.equal(decideRerun(1, [flake, real]).kind, 'stop');
  assert.equal(decideRerun(1, []).kind, 'stop');
  assert.throws(() => decideRerun(0, [flake]), /Assertion failed: decideRerun: attempts start at one/);
});

test('the failed log is split by job with its columns removed', () => {
  assert.deepEqual(logLineText('build-mac\tRun npm test\t2026-11-14T21:40:00.1234567Z npm error code ECONNRESET'), { job: 'build-mac', text: 'npm error code ECONNRESET' });
  assert.equal(logLineText('no tabs here'), undefined);
  const log = [
    'tests (macos-latest)\tRun npm test\t2026-11-14T21:40:00.0000000Z app-ui-kit-tooltip: 1 of 9 failed',
    'tests (macos-latest)\tRun npm test\t2026-11-14T21:40:00.0000000Z   Escape hides it',
    'build-windows\tRun npm ci\t2026-11-14T21:40:01.0000000Z npm error code E503',
  ].join('\r\n');
  const byJob = splitFailedLog(log);
  assert.equal(byJob.get('tests (macos-latest)'), 'app-ui-kit-tooltip: 1 of 9 failed\n  Escape hides it\n');
  assert.equal(decideRerun(1, [{ id: 1, name: 'tests (macos-latest)', text: byJob.get('tests (macos-latest)') ?? '' }]).kind, 'rerun');
});

test('job and annotation parsers turn bad shapes into failure values', () => {
  const jobs = parseRunJobs(JSON.stringify({ jobs: [{ databaseId: 5, name: 'build-mac', conclusion: 'failure' }] }));
  assert.ok(jobs.ok);
  assert.equal(jobs.value[0]?.conclusion, 'failure');
  assert.ok(!parseRunJobs('{}').ok);
  assert.ok(!parseRunJobs(JSON.stringify({ jobs: [{ name: 'x' }] })).ok);
  const annotations = parseAnnotations(JSON.stringify([{ message: 'lost communication with the server' }, { title: 'none' }]));
  assert.ok(annotations.ok);
  assert.deepEqual(annotations.value, ['lost communication with the server']);
  assert.ok(!parseAnnotations('nope').ok);
});
