#!/usr/bin/env node
// Promotion: the only thing that happens after a release tag exists. release.yml runs
//
//   node --experimental-strip-types scripts/release/promote.mts --sha=SHA --tag=vX.Y.Z --dry-run=<true|false>
//
// It finds the proof that this exact commit is a finished candidate, and refuses anything less:
//   - check.yml passed on the SHA, every platform and every shard (releaseStatus.mts);
//   - a candidate.yml run on the SHA, not a rehearsal, completed green, whose final `candidate` job
//     ran (a run that skipped its builds also ends green, so the conclusion alone proves nothing);
//   - the tag names the version the candidate built.
// It writes the candidate run id as an output; the workflow then downloads exactly that run's
// artifacts, checks them (candidate.mts --stage=assets) and publishes them. Nothing is rebuilt or
// retested here, so a failure after the tag can only be an upload, and an upload is re-runnable on
// the same tag: the version is never burned for an infrastructure reason.
// A dry run accepts a rehearsal candidate and stops before any upload, so the promote steps can be
// rehearsed on any commit without anything reaching users.

import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { systemReporter, type Reporter } from './actionsReport.mts';
import { systemCommandRunner, type CommandRunner } from './releaseCommands.mts';
import { parseRecordList, readInteger, readOptionalString, readString } from './releaseJson.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { exactCheckProblem, parseCheckJobs, readExactCheckRun, SOURCE_REPOSITORY, type CheckJob } from './releaseStatus.mts';
import { parseVersion } from './releaseVersion.mts';

export const CANDIDATE_WORKFLOW = 'candidate.yml';
// candidate.yml's `run-name`: a rehearsal says so in the title, which gh run list reports.
export const REHEARSAL_TITLE_MARK = '(rehearsal)';
export const CANDIDATE_FINAL_JOB = 'candidate';

export interface CandidateRun {
  readonly id: number;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | undefined;
  readonly displayTitle: string;
  readonly url: string;
}

export interface CandidateEvidence {
  readonly run: CandidateRun;
  readonly jobs: readonly CheckJob[];
}

export type PromoteMode = 'release' | 'dry-run';

export function parseCandidateRuns(text: string): Result<readonly CandidateRun[]> {
  const records = parseRecordList(text, 'gh run list candidate');
  if (!records.ok) {
    return records;
  }
  const runs: CandidateRun[] = [];
  for (const record of records.value) {
    const id = readInteger(record, 'databaseId', 'candidate run');
    const headSha = readString(record, 'headSha', 'candidate run');
    const status = readString(record, 'status', 'candidate run');
    const displayTitle = readString(record, 'displayTitle', 'candidate run');
    const url = readString(record, 'url', 'candidate run');
    if (!id.ok) {
      return id;
    }
    if (!headSha.ok) {
      return headSha;
    }
    if (!status.ok) {
      return status;
    }
    if (!displayTitle.ok) {
      return displayTitle;
    }
    if (!url.ok) {
      return url;
    }
    runs.push({ id: id.value, headSha: headSha.value, status: status.value, conclusion: readOptionalString(record, 'conclusion'), displayTitle: displayTitle.value, url: url.value });
  }
  return ok(runs);
}

/** Why this candidate cannot be promoted, or undefined when it can. */
export function candidateProblem(evidence: CandidateEvidence | undefined, mode: PromoteMode): string | undefined {
  if (evidence === undefined) {
    return 'no candidate.yml run for this exact SHA';
  }
  if (evidence.run.status !== 'completed') {
    return `candidate.yml is still ${evidence.run.status}: ${evidence.run.url}`;
  }
  if (evidence.run.conclusion !== 'success') {
    return `candidate.yml ended ${evidence.run.conclusion ?? 'without a conclusion'}: ${evidence.run.url}`;
  }
  if (mode === 'release' && evidence.run.displayTitle.includes(REHEARSAL_TITLE_MARK)) {
    return `candidate.yml run ${evidence.run.url} is a rehearsal; a rehearsal is never promoted`;
  }
  const final = evidence.jobs.find((job) => job.name === CANDIDATE_FINAL_JOB);
  if (final === undefined) {
    return `candidate.yml run ${evidence.run.url} has no ${CANDIDATE_FINAL_JOB} job`;
  }
  if (final.conclusion !== 'success') {
    return `the ${CANDIDATE_FINAL_JOB} job ended ${final.conclusion ?? 'unfinished'} (skipped means nothing was built): ${evidence.run.url}`;
  }
  return undefined;
}

/** The newest candidate.yml run for exactly this commit, with its jobs. */
export function readCandidate(sha: string, runner: CommandRunner): Result<CandidateEvidence | undefined> {
  assert(/^[0-9a-f]{40}$/.test(sha), 'readCandidate: a full SHA');
  const listed = runner({
    command: 'gh',
    argumentsList: ['run', 'list', '--repo', SOURCE_REPOSITORY, '--workflow', CANDIDATE_WORKFLOW, '--commit', sha, '--limit', '20', '--json', 'databaseId,headSha,status,conclusion,displayTitle,url'],
  });
  if (!listed.ok) {
    return listed;
  }
  const runs = parseCandidateRuns(listed.value);
  if (!runs.ok) {
    return runs;
  }
  // Newest first; the newest green run wins over an older red one on the same commit.
  const matching = runs.value.filter((run) => run.headSha === sha);
  const run = matching.find((candidate) => candidate.conclusion === 'success') ?? matching[0];
  if (run === undefined) {
    return ok(undefined);
  }
  const jobsText = runner({ command: 'gh', argumentsList: ['run', 'view', String(run.id), '--repo', SOURCE_REPOSITORY, '--json', 'jobs'] });
  if (!jobsText.ok) {
    return jobsText;
  }
  const jobs = parseCheckJobs(jobsText.value);
  return jobs.ok ? ok({ run, jobs: jobs.value }) : jobs;
}

export interface PromoteInput {
  readonly sha: string;
  readonly tag: string;
  readonly version: string;
  readonly mode: PromoteMode;
}

export interface PromoteProof {
  readonly candidateRunId: number;
  readonly candidateUrl: string;
  readonly checkUrl: string;
}

/** Every proof a promotion needs, or the first one missing. */
export function provePromotion(input: PromoteInput, runner: CommandRunner): Result<PromoteProof> {
  assert(/^[0-9a-f]{40}$/.test(input.sha), 'provePromotion: a full SHA');
  assert(input.tag === `v${input.version}`, 'provePromotion: the tag names the version');
  const check = readExactCheckRun(input.sha, runner);
  if (!check.ok) {
    return check;
  }
  const checkProblem = exactCheckProblem(check.value);
  if (checkProblem !== undefined) {
    return fail('check-not-green', checkProblem);
  }
  assert(check.value !== undefined, 'provePromotion: a green Check has a run');
  const candidate = readCandidate(input.sha, runner);
  if (!candidate.ok) {
    return candidate;
  }
  const problem = candidateProblem(candidate.value, input.mode);
  if (problem !== undefined) {
    return fail('candidate-not-green', problem);
  }
  assert(candidate.value !== undefined, 'provePromotion: a green candidate has a run');
  return ok({ candidateRunId: candidate.value.run.id, candidateUrl: candidate.value.run.url, checkUrl: check.value.run.url });
}

export function parsePromoteArguments(argumentsList: readonly string[]): Result<PromoteInput> {
  const values = new Map<string, string>();
  for (const argument of argumentsList) {
    const match = /^--(sha|tag|dry-run)=(.*)$/.exec(argument);
    if (match === null) {
      return fail('usage', `unknown argument ${argument}`);
    }
    values.set(match[1] ?? '', match[2] ?? '');
  }
  const sha = values.get('sha') ?? '';
  const tag = values.get('tag') ?? '';
  const dryRun = values.get('dry-run') ?? 'true';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return fail('usage', '--sha must be a full commit SHA');
  }
  const tagMatch = /^v(\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(tag);
  if (tagMatch === null || !parseVersion(tagMatch[1] ?? '').ok) {
    return fail('usage', '--tag must be vX.Y.Z');
  }
  if (dryRun !== 'true' && dryRun !== 'false') {
    return fail('usage', '--dry-run is true or false');
  }
  return ok({ sha, tag, version: tagMatch[1] ?? '', mode: dryRun === 'true' ? 'dry-run' : 'release' });
}

export function runPromote(input: PromoteInput, runner: CommandRunner, reporter: Reporter): number {
  const proof = provePromotion(input, runner);
  if (!proof.ok) {
    reporter.error(`Not promoted: ${proof.error.message}`);
    reporter.summary(
      [
        `### ${input.tag}: NOT PROMOTED`,
        '',
        proof.error.message,
        '',
        'Nothing was uploaded and nothing is public. Fix the cause on main, let the candidate go green on the new HEAD, and run `npm run release:ship` again: it moves no tag and re-runs this on the same version when the tag already points at a green candidate.',
      ].join('\n'),
    );
    return 1;
  }
  reporter.output('candidate_run_id', String(proof.value.candidateRunId));
  reporter.summary([`### ${input.tag}: promoting (${input.mode})`, '', `- Check: ${proof.value.checkUrl}`, `- Candidate: ${proof.value.candidateUrl}`].join('\n'));
  return 0;
}

function main(argumentsList: readonly string[]): number {
  const reporter = systemReporter(process.env);
  const parsed = parsePromoteArguments(argumentsList);
  if (!parsed.ok) {
    reporter.error(parsed.error.message);
    return 2;
  }
  return runPromote(parsed.value, systemCommandRunner(process.env), reporter);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
