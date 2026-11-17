// Goal: release.yml promotes only a finished candidate: check.yml green on the exact SHA, and a
// candidate.yml run on that SHA that completed green, is not a rehearsal (in a real release), and
// whose final `candidate` job ran. A run that skipped its builds also ends green, so the final job
// is the proof. Every other state refuses, and a refusal uploads nothing.
// Methodology: candidateProblem is pure and gets each near miss; provePromotion runs against a
// scripted gh (no network); the argument parser gets good and bad flags.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordingReporter } from '../../../scripts/release/actionsReport.mts';
import { candidateProblem, parseCandidateRuns, parsePromoteArguments, provePromotion, runPromote, type CandidateEvidence } from '../../../scripts/release/promote.mts';
import type { CommandRunner } from '../../../scripts/release/releaseCommands.mts';
import { ok } from '../../../scripts/release/releaseResult.mts';
import { REQUIRED_CHECK_JOBS } from '../../../scripts/release/releaseStatus.mts';

const SHA = 'b'.repeat(40);

interface RunOverrides { readonly status?: string; readonly conclusion?: string | undefined; readonly displayTitle?: string }

function evidence(overrides: RunOverrides = {}, finalConclusion: string | undefined = 'success'): CandidateEvidence {
  return {
    run: { id: 7, headSha: SHA, status: 'completed', conclusion: 'success', displayTitle: 'Candidate 1.4.8', url: 'https://example.test/run/7', ...overrides },
    jobs: [
      { name: 'plan', status: 'completed', conclusion: 'success' },
      { name: 'candidate', status: 'completed', conclusion: finalConclusion },
    ],
  };
}

test('only a completed green non-rehearsal candidate whose final job ran is promoted', () => {
  assert.equal(candidateProblem(evidence(), 'release'), undefined);
  assert.match(candidateProblem(undefined, 'release') ?? '', /no candidate.yml run/);
  assert.match(candidateProblem(evidence({ status: 'in_progress', conclusion: undefined }), 'release') ?? '', /still in_progress/);
  assert.match(candidateProblem(evidence({ conclusion: 'failure' }), 'release') ?? '', /ended failure/);
  assert.match(candidateProblem(evidence({ displayTitle: 'Candidate 1.4.8 (rehearsal)' }), 'release') ?? '', /rehearsal/);
  assert.equal(candidateProblem(evidence({ displayTitle: 'Candidate 1.4.8 (rehearsal)' }), 'dry-run'), undefined, 'a dry run may rehearse on a rehearsal');
  assert.match(candidateProblem(evidence({}, 'skipped'), 'release') ?? '', /skipped means nothing was built/);
  const withoutFinal: CandidateEvidence = { run: evidence().run, jobs: [{ name: 'plan', status: 'completed', conclusion: 'success' }] };
  assert.match(candidateProblem(withoutFinal, 'release') ?? '', /has no candidate job/);
});

function scripted(candidateRuns: string): CommandRunner {
  const checkJobs = JSON.stringify({ jobs: REQUIRED_CHECK_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })) });
  const candidateJobs = JSON.stringify({ jobs: evidence().jobs });
  return (request) => {
    const joined = request.argumentsList.join(' ');
    if (joined.includes('--workflow check.yml')) {
      return ok(JSON.stringify([{ databaseId: 1, headSha: SHA, status: 'completed', conclusion: 'success', url: 'https://example.test/check/1' }]));
    }
    if (joined.includes('--workflow candidate.yml')) {
      return ok(candidateRuns);
    }
    if (joined.startsWith('run view 1 ')) {
      return ok(checkJobs);
    }
    return ok(candidateJobs);
  };
}

test('the proof reads Check and the candidate on the exact SHA and names the run to download', () => {
  const runs = JSON.stringify([
    { databaseId: 9, headSha: SHA, status: 'completed', conclusion: 'failure', displayTitle: 'Candidate 1.4.8', url: 'https://example.test/run/9' },
    { databaseId: 7, headSha: SHA, status: 'completed', conclusion: 'success', displayTitle: 'Candidate 1.4.8', url: 'https://example.test/run/7' },
  ]);
  const proof = provePromotion({ sha: SHA, tag: 'v1.4.8', version: '1.4.8', mode: 'release' }, scripted(runs));
  assert.deepEqual(proof, ok({ candidateRunId: 7, candidateUrl: 'https://example.test/run/7', checkUrl: 'https://example.test/check/1' }));
  const none = provePromotion({ sha: SHA, tag: 'v1.4.8', version: '1.4.8', mode: 'release' }, scripted('[]'));
  assert.ok(!none.ok && none.error.code === 'candidate-not-green');
  const { reporter, report } = recordingReporter();
  assert.equal(runPromote({ sha: SHA, tag: 'v1.4.8', version: '1.4.8', mode: 'release' }, scripted('[]'), reporter), 1);
  assert.ok(report.summaries.some((summary) => summary.includes('NOT PROMOTED')));
  assert.equal(report.outputs.has('candidate_run_id'), false, 'a refusal names no run to download');
  assert.throws(() => provePromotion({ sha: SHA, tag: 'v1.4.9', version: '1.4.8', mode: 'release' }, scripted(runs)), /Assertion failed: provePromotion: the tag names the version/);
});

test('parsers turn bad shapes into failures', () => {
  assert.equal(parseCandidateRuns('{}').ok, false);
  assert.equal(parseCandidateRuns('[{"databaseId":1}]').ok, false);
  assert.deepEqual(parsePromoteArguments([`--sha=${SHA}`, '--tag=v1.4.8', '--dry-run=false']), ok({ sha: SHA, tag: 'v1.4.8', version: '1.4.8', mode: 'release' }));
  assert.equal(parsePromoteArguments([`--sha=${SHA}`, '--tag=v1.4.8']).ok, true, 'a dry run is the default');
  for (const bad of [['--sha=abc', '--tag=v1.4.8'], [`--sha=${SHA}`, '--tag=1.4.8'], [`--sha=${SHA}`, '--tag=v1.4.8', '--dry-run=maybe'], ['--force']]) {
    assert.equal(parsePromoteArguments(bad).ok, false, bad.join(' '));
  }
});
