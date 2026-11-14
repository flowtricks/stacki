#!/usr/bin/env node
// Usage (the file is .mts so Node runs it directly, as it runs scripts/policy):
//
//   node --experimental-strip-types scripts/release/releaseStatus.mts [sha|HEAD]
//
// Answers one question before a tag is pushed: may this commit be tagged? It reads (never
// writes) the check.yml result for the commit from GitHub, whether the tag already exists on
// origin, and whether the working tree and unpushed commits are in order, then ends with one
// verdict line: `READY TO TAG` or `NOT READY: <reason>`. Exit status: 0 ready, 1 not ready,
// 2 the facts could not be read (gh or git failed), which is also not ready.
//
// The rule it applies is docs/release-runbook.md, "What must be green on the tagged SHA":
//   - check.yml is green, with every required job, on the exact SHA; or
//   - it is green on an ancestor, and every commit since touches only the version files and the
//     release notes. release.yml then runs the whole suite on the tagged SHA on all three
//     platforms before it builds anything, so that tiny delta cannot ship untested.

import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import {
  flowtricksEnvironment,
  systemCommandRunner,
  type CommandRunner,
} from './releaseCommands.mts';
import { parseRecord, parseRecordList, readInteger, readList, readOptionalString, readRecord, readString } from './releaseJson.mts';
import { ok, type Result } from './releaseResult.mts';
import { latestReleasedVersion, validatePatchBump } from './releaseVersion.mts';

export const STATUS_LIMITS = {
  /** Commits walked back from the SHA looking for a green check.yml; a release is a few commits. */
  ancestorCommitsMax: 100,
  /** Runs read from check.yml; one per push to main, so this covers days of work. */
  checkRunsMax: 100,
  pathsShownMax: 12,
} as const satisfies Record<string, number>;

export const SOURCE_REPOSITORY = 'flowtricks/stacki';

// check.yml's jobs by name. A rename that silently dropped a platform must not read as green.
export const REQUIRED_CHECK_JOBS = ['policy', 'test (ubuntu-latest)', 'test (macos-latest)', 'test (windows-latest)'] as const;

// The files a release bump rewrites (see `git show --stat` of any chore(release) commit).
export const VERSION_ONLY_FILES = [
  'package.json',
  'package-lock.json',
  'packages/create-stacki/package.json',
  'studio/package.json',
  'studio/package-lock.json',
  'studio/src/shared/release.json',
  'docs/releases.md',
] as const;

export interface CheckRun {
  readonly id: number;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | undefined;
  readonly url: string;
}

export interface CheckJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | undefined;
}

export interface RunEvidence {
  readonly run: CheckRun;
  readonly jobs: readonly CheckJob[];
}

export interface BaseEvidence extends RunEvidence {
  // How many commits back from the SHA the green run is.
  readonly distance: number;
  readonly deltaPaths: readonly string[];
}

export interface ReleaseFacts {
  readonly sha: string;
  readonly version: string;
  readonly latestReleased: string;
  readonly tagOnOrigin: boolean;
  readonly modifiedTrackedPaths: readonly string[];
  readonly untrackedCount: number;
  readonly unpushedCount: number | undefined;
  readonly exact: RunEvidence | undefined;
  readonly base: BaseEvidence | undefined;
}

export interface Verdict {
  readonly ready: boolean;
  // READY: what to do next. NOT READY: the first blocking reason.
  readonly text: string;
}

export function parseCheckRuns(text: string): Result<readonly CheckRun[]> {
  const records = parseRecordList(text, 'gh run list');
  if (!records.ok) {
    return records;
  }
  const runs: CheckRun[] = [];
  for (const record of records.value) {
    const id = readInteger(record, 'databaseId', 'gh run list');
    const headSha = readString(record, 'headSha', 'gh run list');
    const status = readString(record, 'status', 'gh run list');
    const url = readString(record, 'url', 'gh run list');
    if (!id.ok) {
      return id;
    }
    if (!headSha.ok) {
      return headSha;
    }
    if (!status.ok) {
      return status;
    }
    if (!url.ok) {
      return url;
    }
    runs.push({ id: id.value, headSha: headSha.value, status: status.value, conclusion: readOptionalString(record, 'conclusion'), url: url.value });
  }
  return ok(runs);
}

export function parseCheckJobs(text: string): Result<readonly CheckJob[]> {
  const record = parseRecord(text, 'gh run view');
  if (!record.ok) {
    return record;
  }
  const list = readList(record.value['jobs'], 'gh run view jobs');
  if (!list.ok) {
    return list;
  }
  const jobs: CheckJob[] = [];
  for (const entry of list.value) {
    const job = readRecord(entry, 'gh run view job');
    if (!job.ok) {
      return job;
    }
    const name = readString(job.value, 'name', 'gh run view job');
    const status = readString(job.value, 'status', 'gh run view job');
    if (!name.ok) {
      return name;
    }
    if (!status.ok) {
      return status;
    }
    jobs.push({ name: name.value, status: status.value, conclusion: readOptionalString(job.value, 'conclusion') });
  }
  return ok(jobs);
}

/** Tag names from `git ls-remote --tags` output, peeled entries (^{}) dropped. */
export function parseTagNames(lsRemoteOutput: string): readonly string[] {
  const names: string[] = [];
  for (const line of lsRemoteOutput.split('\n')) {
    const match = /\trefs\/tags\/([^\s^]+)$/.exec(line);
    if (match?.[1] !== undefined) {
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * The run for the exact SHA, and the newest green run on an ancestor. `ancestry` is the SHA's
 * history newest first (the SHA itself is index 0), so an index is a distance in commits.
 */
export function selectCheckRuns(
  runs: readonly CheckRun[],
  sha: string,
  ancestry: readonly string[],
): { readonly exact: CheckRun | undefined; readonly base: { readonly run: CheckRun; readonly distance: number } | undefined } {
  assert(ancestry.length <= STATUS_LIMITS.ancestorCommitsMax + 1, 'selectCheckRuns: ancestry is bounded');
  // Runs are newest first, so the first match for a SHA is its latest attempt.
  const exact = runs.find((run) => run.headSha === sha);
  let base: { run: CheckRun; distance: number } | undefined;
  for (const run of runs) {
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      continue;
    }
    const distance = ancestry.indexOf(run.headSha);
    if (distance > 0 && (base === undefined || distance < base.distance)) {
      base = { run, distance };
    }
  }
  return { exact, base };
}

export function versionOnlyDelta(paths: readonly string[]): { readonly allowed: boolean; readonly offending: readonly string[] } {
  const allowedFiles: readonly string[] = VERSION_ONLY_FILES;
  const offending = paths.filter((path) => !allowedFiles.includes(path));
  return { allowed: offending.length === 0, offending };
}

/** Required jobs that are missing or did not succeed; empty means every platform is green. */
export function checkJobProblems(jobs: readonly CheckJob[]): readonly string[] {
  const problems: string[] = [];
  for (const name of REQUIRED_CHECK_JOBS) {
    const job = jobs.find((candidate) => candidate.name === name);
    if (job === undefined) {
      problems.push(`${name}: missing from the run`);
    } else if (job.conclusion !== 'success') {
      problems.push(`${name}: ${job.conclusion ?? job.status}`);
    }
  }
  return problems;
}

export function assessReadiness(facts: ReleaseFacts): Verdict {
  const bump = validatePatchBump(facts.latestReleased, facts.version);
  if (!bump.ok) {
    return { ready: false, text: bump.error.message };
  }
  if (facts.tagOnOrigin) {
    return { ready: false, text: `tag v${facts.version} already exists on origin. Never move it: fix forward in the next patch.` };
  }
  if (facts.modifiedTrackedPaths.length > 0) {
    const shown = facts.modifiedTrackedPaths.slice(0, STATUS_LIMITS.pathsShownMax).join(', ');
    return { ready: false, text: `uncommitted changes to tracked files (${shown}); the pre-push gate builds the working tree, not the commit.` };
  }
  const exactProblem = exactRunProblem(facts.exact);
  if (exactProblem !== undefined) {
    return { ready: false, text: exactProblem };
  }
  if (facts.exact !== undefined && facts.exact.run.status === 'completed') {
    return { ready: true, text: 'check.yml is green on this exact SHA. Tag it.' };
  }
  return baseVerdict(facts);
}

// A finished run that is not fully green on this SHA is a real signal. A run still going is not
// required: the version-only rule below covers a bump commit whose own check is still running.
function exactRunProblem(exact: RunEvidence | undefined): string | undefined {
  if (exact === undefined || exact.run.status !== 'completed') {
    return undefined;
  }
  if (exact.run.conclusion !== 'success') {
    const failed = exact.jobs.filter((job) => job.conclusion !== 'success').map((job) => `${job.name}: ${job.conclusion ?? job.status}`);
    return `check.yml ${exact.run.conclusion ?? 'did not succeed'} on this SHA (${failed.join('; ') || 'see the run'}): ${exact.run.url}`;
  }
  const problems = checkJobProblems(exact.jobs);
  return problems.length === 0 ? undefined : `check.yml succeeded but required jobs are not green (${problems.join('; ')}): ${exact.run.url}`;
}

function baseVerdict(facts: ReleaseFacts): Verdict {
  if (facts.base === undefined) {
    return {
      ready: false,
      text: `no green check.yml on this SHA or its last ${STATUS_LIMITS.ancestorCommitsMax} ancestors. Push main (git push) and wait for the Check run.`,
    };
  }
  const problems = checkJobProblems(facts.base.jobs);
  if (problems.length > 0) {
    return { ready: false, text: `the green ancestor run is missing required jobs (${problems.join('; ')}): ${facts.base.run.url}` };
  }
  const delta = versionOnlyDelta(facts.base.deltaPaths);
  if (!delta.allowed) {
    const shown = delta.offending.slice(0, STATUS_LIMITS.pathsShownMax).join(', ');
    return {
      ready: false,
      text:
        `check.yml is green only on ${facts.base.run.headSha.slice(0, 7)}, and ${delta.offending.length} file(s) changed since that are not version files (${shown}). ` +
        'Push main and wait for check.yml on this SHA.',
    };
  }
  const pushNote = facts.unpushedCount === undefined || facts.unpushedCount > 0 ? ' Push main and the tag in one push.' : ' Tag it.';
  return { ready: true, text: `check.yml is green on ${facts.base.run.headSha.slice(0, 7)} and only version files changed since.${pushNote}` };
}

export function renderReport(facts: ReleaseFacts, verdict: Verdict): string {
  const lines: string[] = [];
  lines.push(`Release status for ${facts.sha.slice(0, 7)} (version ${facts.version}, last released ${facts.latestReleased})`);
  const bump = validatePatchBump(facts.latestReleased, facts.version);
  lines.push(`  versioning   ${bump.ok ? 'patch bump OK' : `REJECTED: ${bump.error.code}`}`);
  lines.push(`  tag          v${facts.version} ${facts.tagOnOrigin ? 'ALREADY ON ORIGIN' : 'not on origin (good)'}`);
  lines.push(`  working tree ${facts.modifiedTrackedPaths.length === 0 ? 'no modified tracked files' : `${facts.modifiedTrackedPaths.length} modified tracked file(s)`}, ${facts.untrackedCount} untracked`);
  lines.push(`  unpushed     ${facts.unpushedCount === undefined ? 'unknown' : `${facts.unpushedCount} commit(s) not on origin/main`}`);
  lines.push(`  check.yml    ${facts.exact === undefined ? 'no run for this exact SHA' : `${facts.exact.run.status}/${facts.exact.run.conclusion ?? 'pending'} ${facts.exact.run.url}`}`);
  for (const job of facts.exact?.jobs ?? []) {
    lines.push(`    ${job.name.padEnd(22)} ${job.conclusion ?? job.status}`);
  }
  if (facts.base !== undefined) {
    const delta = versionOnlyDelta(facts.base.deltaPaths);
    lines.push(`  green base   ${facts.base.run.headSha.slice(0, 7)}, ${facts.base.distance} commit(s) back: ${facts.base.run.url}`);
    for (const job of facts.base.jobs) {
      lines.push(`    ${job.name.padEnd(22)} ${job.conclusion ?? job.status}`);
    }
    lines.push(`  delta        ${facts.base.deltaPaths.length} file(s) since the base, ${delta.allowed ? 'all version files' : `${delta.offending.length} not version files`}`);
  }
  lines.push(verdict.ready ? `READY TO TAG: ${verdict.text}` : `NOT READY: ${verdict.text}`);
  return lines.join('\n');
}

function gitText(runner: CommandRunner, argumentsList: readonly string[]): Result<string> {
  const result = runner({ command: 'git', argumentsList });
  return result.ok ? ok(result.value.trim()) : result;
}

function readVersionAt(runner: CommandRunner, sha: string): Result<string> {
  const manifest = gitText(runner, ['show', `${sha}:package.json`]);
  if (!manifest.ok) {
    return manifest;
  }
  const record = parseRecord(manifest.value, 'package.json');
  return record.ok ? readString(record.value, 'version', 'package.json') : record;
}

function readRunEvidence(runner: CommandRunner, run: CheckRun): Result<RunEvidence> {
  const jobsText = runner({ command: 'gh', argumentsList: ['run', 'view', String(run.id), '--repo', SOURCE_REPOSITORY, '--json', 'jobs'] });
  if (!jobsText.ok) {
    return jobsText;
  }
  const jobs = parseCheckJobs(jobsText.value);
  return jobs.ok ? ok({ run, jobs: jobs.value }) : jobs;
}

/** Everything the verdict needs, read once. A failed read is a failure value, never a guess. */
export function gatherFacts(reference: string, runner: CommandRunner): Result<ReleaseFacts> {
  const resolved = gitText(runner, ['rev-parse', '--verify', `${reference}^{commit}`]);
  if (!resolved.ok) {
    return resolved;
  }
  const sha = resolved.value;
  assert(/^[0-9a-f]{40}$/.test(sha), 'gatherFacts: rev-parse returned a full SHA');
  const version = readVersionAt(runner, sha);
  if (!version.ok) {
    return version;
  }
  const tags = runner({ command: 'git', argumentsList: ['ls-remote', '--tags', 'origin', 'refs/tags/v*'] });
  if (!tags.ok) {
    return tags;
  }
  const tagNames = parseTagNames(tags.value);
  const latest = latestReleasedVersion(tagNames);
  if (!latest.ok) {
    return latest;
  }
  // Untrimmed: the first column of a porcelain line is a space for an unstaged change.
  const status = runner({ command: 'git', argumentsList: ['status', '--porcelain'] });
  if (!status.ok) {
    return status;
  }
  const statusLines = status.value.split('\n').filter((line) => line.length > 0);
  const modifiedTrackedPaths = statusLines.filter((line) => !line.startsWith('??')).map((line) => line.slice(3));
  const history = gitText(runner, ['rev-list', `--max-count=${STATUS_LIMITS.ancestorCommitsMax + 1}`, sha]);
  if (!history.ok) {
    return history;
  }
  const ancestry = history.value.split('\n').filter((line) => line.length > 0);
  const runsText = runner({
    command: 'gh',
    argumentsList: ['run', 'list', '--repo', SOURCE_REPOSITORY, '--workflow', 'check.yml', '--branch', 'main', '--limit', String(STATUS_LIMITS.checkRunsMax), '--json', 'databaseId,headSha,status,conclusion,url'],
  });
  if (!runsText.ok) {
    return runsText;
  }
  const runs = parseCheckRuns(runsText.value);
  if (!runs.ok) {
    return runs;
  }
  const selected = selectCheckRuns(runs.value, sha, ancestry);
  const exact = selected.exact === undefined ? ok(undefined) : readRunEvidence(runner, selected.exact);
  if (!exact.ok) {
    return exact;
  }
  const base = readBaseEvidence(runner, sha, selected.base);
  if (!base.ok) {
    return base;
  }
  return ok({
    sha,
    version: version.value,
    latestReleased: latest.value,
    tagOnOrigin: tagNames.includes(`v${version.value}`),
    modifiedTrackedPaths,
    untrackedCount: statusLines.length - modifiedTrackedPaths.length,
    unpushedCount: readUnpushedCount(runner, sha),
    exact: exact.value,
    base: base.value,
  });
}

function readBaseEvidence(runner: CommandRunner, sha: string, base: { readonly run: CheckRun; readonly distance: number } | undefined): Result<BaseEvidence | undefined> {
  if (base === undefined) {
    return ok(undefined);
  }
  const evidence = readRunEvidence(runner, base.run);
  if (!evidence.ok) {
    return evidence;
  }
  const delta = gitText(runner, ['diff', '--name-only', base.run.headSha, sha]);
  if (!delta.ok) {
    return delta;
  }
  const deltaPaths = delta.value.split('\n').filter((line) => line.length > 0);
  return ok({ ...evidence.value, distance: base.distance, deltaPaths });
}

// Display only: the remote tip may be a commit this clone has not fetched, which reads as unknown.
function readUnpushedCount(runner: CommandRunner, sha: string): number | undefined {
  const remote = gitText(runner, ['ls-remote', 'origin', 'refs/heads/main']);
  const remoteSha = remote.ok ? remote.value.split('\t')[0] : undefined;
  if (remoteSha === undefined || remoteSha.length === 0) {
    return undefined;
  }
  const count = gitText(runner, ['rev-list', '--count', `${remoteSha}..${sha}`]);
  const parsed = count.ok ? Number(count.value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function main(argumentsList: readonly string[]): number {
  if (argumentsList.length > 1) {
    console.error('usage: releaseStatus.mts [sha|HEAD]');
    return 2;
  }
  const reference = argumentsList[0] ?? 'HEAD';
  const bootstrap = systemCommandRunner(process.env);
  const runner = systemCommandRunner(flowtricksEnvironment(process.env, bootstrap));
  const facts = gatherFacts(reference, runner);
  if (!facts.ok) {
    console.log(`NOT READY: could not read the facts (${facts.error.code}): ${facts.error.message}`);
    return 2;
  }
  const verdict = assessReadiness(facts.value);
  console.log(renderReport(facts.value, verdict));
  return verdict.ready ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
