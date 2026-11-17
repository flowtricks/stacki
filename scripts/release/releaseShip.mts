#!/usr/bin/env node
// The one release command:
//
//   npm run release:ship                 says where the release stands and the next step; writes nothing
//   npm run release:ship -- --confirm    takes every next step until the version is live, or stops with why
//
// It is a state machine over facts read from GitHub (never from this working tree), so it can be
// stopped and started again at any point and always picks up where the release is:
//
//   version on origin/main is released  -> bump: a GitHub commit `chore(release): version X.Y.Z` on
//                                           top of origin/main (releaseBump.mts). The push starts
//                                           check.yml and candidate.yml on that commit, in parallel.
//   candidate or Check still running     -> wait, one status line a minute, with the macOS queue
//                                           called out at minute five (the one stage outside our control).
//   a job failed                         -> the rerun policy (rerunPolicy.mts): one rerun of the failed
//                                           jobs when every failure is a known infrastructure flake on
//                                           the first attempt; anything else stops with the job URLs.
//                                           A real failure is fixed on main as an ordinary commit: the
//                                           version stays X.Y.Z (no tag exists yet), the candidate runs
//                                           again on the new HEAD, and this command resumes.
//   both green on the exact SHA          -> tag: create vX.Y.Z on that SHA. release.yml promotes the
//                                           candidate's own artifacts (promote.mts); nothing is rebuilt.
//   tag exists, not yet public           -> wait for release.yml; a failed promotion is re-run on the
//                                           same tag (uploads are idempotent), never a new version.
//   public                               -> wait for Release post (npm, site, verify) and report.
//
// Every wait is bounded (SHIP_LIMITS); every write goes through the release write allowlist.

import { pathToFileURL } from 'node:url';
import { assert } from '../policy/assert.mts';
import { type CandidateEvidence, candidateProblem, readCandidate } from './promote.mts';
import { flowtricksEnvironment, systemCommandRunner, systemSleeper, type CommandRunner, type Sleeper } from './releaseCommands.mts';
import { planRemoteBump, writeRemoteBump, writeRemoteTag } from './releaseBump.mts';
import { parseRecord, readString } from './releaseJson.mts';
import { parseRunJobs, splitFailedLog, parseAnnotations, decideRerun, type FailedJob, type RerunDecision } from './rerunPolicy.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { listRuns, newestSince, type WorkflowRun } from './releaseRuns.mts';
import { exactCheckProblem, readExactCheckRun, SOURCE_REPOSITORY, type CheckJob, type RunEvidence } from './releaseStatus.mts';
import { latestReleasedVersion, nextPatchVersion, parseVersion } from './releaseVersion.mts';
import { systemWriteRunner, type WriteRunner } from './releaseWrite.mts';

export const RELEASES_REPOSITORY = 'flowtricks/stacki-releases';

export const SHIP_LIMITS = {
  pollDelayMs: 60_000,
  // Two hours of one-minute polls: past the p95 of a cold candidate (about 70 minutes) with margin.
  iterationsMax: 120,
  // A tag created through the API starts release.yml within seconds; past this, stop and say so.
  releaseAppearMinutesMax: 3,
  // The minute at which the forecast is made: every job should have a runner by then.
  forecastMinute: 5,
  tagCountMax: 2_000,
} as const satisfies Record<string, number>;

export interface Tag {
  readonly name: string;
  readonly sha: string;
}

export interface ShipFacts {
  readonly originSha: string;
  readonly version: string;
  readonly tags: readonly Tag[];
  readonly check: RunEvidence | undefined;
  readonly checkFailure: RerunDecision | undefined;
  readonly candidate: CandidateEvidence | undefined;
  readonly candidateFailure: RerunDecision | undefined;
  readonly releaseRun: WorkflowRun | undefined;
  readonly published: boolean;
  readonly postRun: WorkflowRun | undefined;
}

export type ShipStep =
  | { readonly kind: 'bump'; readonly previous: string; readonly version: string; readonly baseSha: string; readonly note: string | undefined }
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'rerun'; readonly workflow: 'check.yml' | 'candidate.yml' | 'release.yml'; readonly runId: number }
  | { readonly kind: 'stop'; readonly reason: string; readonly nextStep: string }
  | { readonly kind: 'tag'; readonly version: string; readonly sha: string }
  | { readonly kind: 'done'; readonly version: string; readonly summary: string };

const REAL_FAILURE =
  'Fix it on main as an ordinary commit with a regression test (AGENTS.md). The version stays the same, because no tag exists: ' +
  'the candidate runs again on the new HEAD, and `npm run release:ship -- --confirm` picks up from there.';

/** The single next step for these facts. Pure: every read happened before. */
export function decideShip(facts: ShipFacts): ShipStep {
  assert(/^[0-9a-f]{40}$/.test(facts.originSha), 'decideShip: origin is a full SHA');
  assert(parseVersion(facts.version).ok, 'decideShip: the version is X.Y.Z');
  const tag = facts.tags.find((candidate) => candidate.name === `v${facts.version}`);
  if (tag !== undefined) {
    return decideTagged(facts, tag);
  }
  return decideCandidateStage(facts);
}

function decideTagged(facts: ShipFacts, tag: Tag): ShipStep {
  if (facts.published) {
    if (facts.originSha === tag.sha) {
      return decidePost(facts);
    }
    return bumpStep(facts, undefined);
  }
  if (facts.originSha !== tag.sha) {
    // A tag that never became public and is behind main: the old process burned it. Never move it.
    return bumpStep(facts, `v${facts.version} was tagged but never published; it is skipped, never moved.`);
  }
  const run = facts.releaseRun;
  if (run === undefined) {
    return { kind: 'wait', reason: `release.yml has not started for v${facts.version}` };
  }
  if (run.status !== 'completed') {
    return { kind: 'wait', reason: `release.yml is promoting v${facts.version}: ${run.url}` };
  }
  if (run.conclusion === 'success') {
    return { kind: 'wait', reason: `release.yml passed; waiting for v${facts.version} to read as public` };
  }
  if (run.attempt === 1) {
    // Promotion only uploads files that were already built and tested; a rerun on the same tag is safe.
    return { kind: 'rerun', workflow: 'release.yml', runId: run.id };
  }
  return {
    kind: 'stop',
    reason: `promoting v${facts.version} failed twice: ${run.url}`,
    nextStep: 'Read the failed step. Nothing was rebuilt, so this is an upload or a permission: fix it and run `gh run rerun ' + String(run.id) + ' --failed --repo flowtricks/stacki`. Never move the tag.',
  };
}

function decidePost(facts: ShipFacts): ShipStep {
  const post = facts.postRun;
  if (post === undefined) {
    return { kind: 'wait', reason: `v${facts.version} is public; waiting for Release post (npm, site, verify) to start` };
  }
  if (post.status !== 'completed') {
    return { kind: 'wait', reason: `v${facts.version} is public; Release post is running: ${post.url}` };
  }
  if (post.conclusion === 'success') {
    return { kind: 'done', version: facts.version, summary: `v${facts.version} is live; Release post passed: ${post.url}` };
  }
  return {
    kind: 'stop',
    reason: `v${facts.version} is public, but Release post ended ${post.conclusion ?? 'unfinished'}: ${post.url}`,
    nextStep: 'The desktop release is live. Its summary names the failed stage (npm, site or verify) and the one next step; docs/release-runbook.md section 3.',
  };
}

function bumpStep(facts: ShipFacts, note: string | undefined): ShipStep {
  const latest = latestReleasedVersion(facts.tags.map((tag) => tag.name));
  if (!latest.ok) {
    return { kind: 'stop', reason: latest.error.message, nextStep: 'Check the tags on origin.' };
  }
  const next = nextPatchVersion(latest.value);
  if (!next.ok) {
    return { kind: 'stop', reason: next.error.message, nextStep: 'Check the tags on origin.' };
  }
  return { kind: 'bump', previous: latest.value, version: next.value, baseSha: facts.originSha, note };
}

function decideCandidateStage(facts: ShipFacts): ShipStep {
  const pending: string[] = [];
  for (const [label, workflow, evidence, failure] of [
    ['Check', 'check.yml', facts.check, facts.checkFailure],
    ['Candidate', 'candidate.yml', facts.candidate, facts.candidateFailure],
  ] as const) {
    if (evidence === undefined) {
      pending.push(`${label} has not started`);
      continue;
    }
    if (evidence.run.status !== 'completed') {
      pending.push(`${label} ${progressText(evidence.jobs)}`);
      continue;
    }
    if (evidence.run.conclusion === 'success') {
      continue;
    }
    if (failure === undefined) {
      return { kind: 'stop', reason: `${label} ended ${evidence.run.conclusion ?? 'unfinished'}: ${evidence.run.url}`, nextStep: REAL_FAILURE };
    }
    if (failure.kind === 'rerun') {
      return { kind: 'rerun', workflow, runId: evidence.run.id };
    }
    return { kind: 'stop', reason: `${label}: ${failure.reason} ${evidence.run.url}`, nextStep: REAL_FAILURE };
  }
  if (pending.length > 0) {
    return { kind: 'wait', reason: pending.join('; ') };
  }
  // Both runs completed green; the full proof is the same one release.yml will demand.
  const checkProblem = exactCheckProblem(facts.check);
  if (checkProblem !== undefined) {
    return { kind: 'stop', reason: `Check: ${checkProblem}`, nextStep: REAL_FAILURE };
  }
  const problem = candidateProblem(facts.candidate, 'release');
  if (problem !== undefined) {
    return { kind: 'stop', reason: `Candidate: ${problem}`, nextStep: 'Run candidate.yml on main (Actions > Candidate > Run workflow, rehearsal unticked).' };
  }
  return { kind: 'tag', version: facts.version, sha: facts.originSha };
}

export function progressText(jobs: readonly CheckJob[]): string {
  const done = jobs.filter((job) => job.status === 'completed').length;
  const failed = jobs.filter((job) => job.status === 'completed' && job.conclusion !== 'success' && job.conclusion !== 'skipped').length;
  const queuedMac = jobs.filter((job) => job.status === 'queued' && /mac/i.test(job.name)).length;
  const parts = [`${done}/${jobs.length} jobs done`];
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (queuedMac > 0) {
    parts.push(`${queuedMac} macOS queued`);
  }
  return parts.join(', ');
}

/** The minute-five forecast: a job still without a runner is the risk to the hour. */
export function forecastText(elapsedMinutes: number, facts: Pick<ShipFacts, 'check' | 'candidate'>): string | undefined {
  assert(elapsedMinutes >= 0, 'forecastText: elapsed time is not negative');
  if (elapsedMinutes < SHIP_LIMITS.forecastMinute) {
    return undefined;
  }
  const queued = [...(facts.check?.jobs ?? []), ...(facts.candidate?.jobs ?? [])].filter((job) => job.status === 'queued');
  if (queued.length === 0) {
    return 'forecast: every job has a runner; on track for the budget (p50 about 35 minutes to live, p95 under 60).';
  }
  const names = queued.map((job) => job.name).slice(0, 4);
  return `forecast: AT RISK, ${queued.length} job(s) still waiting for a GitHub runner at minute ${Math.floor(elapsedMinutes)} (${names.join(', ')}). GitHub capacity, not our code; nothing to do but wait (the runner wait is capped by GitHub, then the rerun policy retries once).`;
}

/** Failed, timed-out and runner-less jobs of one attempt, each with its failed log and annotations. */
export function readUnfinishedJobs(runner: CommandRunner, runId: number, attempt: number): Result<readonly FailedJob[]> {
  const jobsText = runner({ command: 'gh', argumentsList: ['run', 'view', String(runId), '--attempt', String(attempt), '--repo', SOURCE_REPOSITORY, '--json', 'jobs'] });
  if (!jobsText.ok) {
    return jobsText;
  }
  const jobs = parseRunJobs(jobsText.value);
  if (!jobs.ok) {
    return jobs;
  }
  // A job GitHub never found a runner for ends `cancelled`, with its reason only in an annotation.
  const unfinished = jobs.value.filter((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out' || job.conclusion === 'cancelled');
  const log = runner({ command: 'gh', argumentsList: ['run', 'view', String(runId), '--attempt', String(attempt), '--repo', SOURCE_REPOSITORY, '--log-failed'], timeoutMs: 180_000 });
  const byJob = log.ok ? splitFailedLog(log.value) : new Map<string, string>();
  const result: FailedJob[] = [];
  for (const job of unfinished) {
    const annotationsText = runner({ command: 'gh', argumentsList: ['api', `repos/${SOURCE_REPOSITORY}/check-runs/${job.id}/annotations`] });
    const annotations = annotationsText.ok ? parseAnnotations(annotationsText.value) : ok([]);
    result.push({ id: job.id, name: job.name, text: `${byJob.get(job.name) ?? ''}${(annotations.ok ? annotations.value : []).join('\n')}\n` });
  }
  return ok(result);
}

function failureOf(runner: CommandRunner, run: { readonly id: number; readonly status: string; readonly conclusion: string | undefined }, attempt: number): Result<RerunDecision | undefined> {
  if (run.status !== 'completed') {
    return ok(undefined);
  }
  if (run.conclusion === 'success') {
    return ok(undefined);
  }
  const jobs = readUnfinishedJobs(runner, run.id, attempt);
  return jobs.ok ? ok(decideRerun(attempt, jobs.value)) : jobs;
}

function runAttempt(runner: CommandRunner, runId: number): Result<number> {
  const text = runner({ command: 'gh', argumentsList: ['run', 'view', String(runId), '--repo', SOURCE_REPOSITORY, '--json', 'attempt'] });
  if (!text.ok) {
    return text;
  }
  const record = parseRecord(text.value, 'run attempt');
  if (!record.ok) {
    return record;
  }
  const attempt = record.value['attempt'];
  return typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 1 ? ok(attempt) : fail('json-field', 'run attempt is not a positive integer');
}

export function parseRemoteTags(lsRemote: string): Result<readonly Tag[]> {
  const tags: Tag[] = [];
  for (const line of lsRemote.split('\n')) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(v\d{1,6}\.\d{1,6}\.\d{1,6})(\^\{\})?$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    const name = match[2] ?? '';
    const sha = match[1] ?? '';
    // An annotated tag lists the tag object, then the commit with ^{}; the commit wins.
    const existing = tags.findIndex((tag) => tag.name === name);
    if (existing >= 0) {
      if (match[3] !== undefined) {
        tags[existing] = { name, sha };
      }
      continue;
    }
    tags.push({ name, sha });
    if (tags.length > SHIP_LIMITS.tagCountMax) {
      return fail('tags-limit', `more than ${SHIP_LIMITS.tagCountMax} tags on origin.`);
    }
  }
  return ok(tags);
}

function readOriginVersion(runner: CommandRunner, sha: string): Result<string> {
  const text = runner({ command: 'gh', argumentsList: ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${SOURCE_REPOSITORY}/contents/package.json?ref=${sha}`] });
  if (!text.ok) {
    return text;
  }
  const record = parseRecord(text.value, 'package.json');
  return record.ok ? readString(record.value, 'version', 'package.json') : record;
}

function readPublished(runner: CommandRunner, version: string): boolean {
  const view = runner({ command: 'gh', argumentsList: ['release', 'view', `v${version}`, '--repo', RELEASES_REPOSITORY, '--json', 'isDraft'] });
  if (!view.ok) {
    return false;
  }
  const record = parseRecord(view.value, 'release view');
  return record.ok && record.value['isDraft'] === false;
}

/** Everything decideShip needs, read from GitHub. */
export function gatherShipFacts(runner: CommandRunner): Result<ShipFacts> {
  const main = runner({ command: 'git', argumentsList: ['ls-remote', 'origin', 'refs/heads/main'] });
  if (!main.ok) {
    return main;
  }
  const originSha = /^([0-9a-f]{40})\s/.exec(main.value)?.[1];
  if (originSha === undefined) {
    return fail('origin-main', 'origin has no main branch');
  }
  const version = readOriginVersion(runner, originSha);
  if (!version.ok) {
    return version;
  }
  const tagsText = runner({ command: 'git', argumentsList: ['ls-remote', '--tags', 'origin', 'refs/tags/v*'] });
  if (!tagsText.ok) {
    return tagsText;
  }
  const tags = parseRemoteTags(tagsText.value);
  if (!tags.ok) {
    return tags;
  }
  const tag = tags.value.find((candidate) => candidate.name === `v${version.value}`);
  if (tag !== undefined) {
    return gatherTaggedFacts(runner, { originSha, version: version.value, tags: tags.value, tag });
  }
  const check = readExactCheckRun(originSha, runner);
  if (!check.ok) {
    return check;
  }
  const candidate = readCandidate(originSha, runner);
  if (!candidate.ok) {
    return candidate;
  }
  const checkFailure = check.value === undefined ? ok(undefined) : withAttempt(runner, check.value.run);
  if (!checkFailure.ok) {
    return checkFailure;
  }
  const candidateFailure = candidate.value === undefined ? ok(undefined) : withAttempt(runner, candidate.value.run);
  if (!candidateFailure.ok) {
    return candidateFailure;
  }
  return ok({
    originSha,
    version: version.value,
    tags: tags.value,
    check: check.value,
    checkFailure: checkFailure.value,
    candidate: candidate.value,
    candidateFailure: candidateFailure.value,
    releaseRun: undefined,
    published: false,
    postRun: undefined,
  });
}

function withAttempt(runner: CommandRunner, run: { readonly id: number; readonly status: string; readonly conclusion: string | undefined }): Result<RerunDecision | undefined> {
  if (run.status !== 'completed') {
    return ok(undefined);
  }
  if (run.conclusion === 'success') {
    return ok(undefined);
  }
  const attempt = runAttempt(runner, run.id);
  return attempt.ok ? failureOf(runner, run, attempt.value) : attempt;
}

function gatherTaggedFacts(
  runner: CommandRunner,
  known: { readonly originSha: string; readonly version: string; readonly tags: readonly Tag[]; readonly tag: Tag },
): Result<ShipFacts> {
  const runs = listRuns(runner, { repository: SOURCE_REPOSITORY, workflow: 'release.yml', event: undefined, commit: known.tag.sha });
  if (!runs.ok) {
    return runs;
  }
  const releaseRun = runs.value.find((run) => run.headSha === known.tag.sha);
  const published = readPublished(runner, known.version);
  let postRun: WorkflowRun | undefined;
  if (published && releaseRun !== undefined) {
    const posts = listRuns(runner, { repository: SOURCE_REPOSITORY, workflow: 'release-post.yml', event: undefined, commit: undefined });
    if (!posts.ok) {
      return posts;
    }
    postRun = newestSince(posts.value, releaseRun.createdAt);
  }
  return ok({
    originSha: known.originSha,
    version: known.version,
    tags: known.tags,
    check: undefined,
    checkFailure: undefined,
    candidate: undefined,
    candidateFailure: undefined,
    releaseRun,
    published,
    postRun,
  });
}

export interface ShipDependencies {
  readonly runner: CommandRunner;
  readonly writer: WriteRunner;
  readonly sleeper: Sleeper;
  readonly now: () => number;
  readonly print: (line: string) => void;
}

export type ShipMode = 'look' | 'confirm';

/** Runs the state machine: one look, or every step to live. Returns the exit status. */
export async function ship(mode: ShipMode, dependencies: ShipDependencies): Promise<number> {
  const startedMs = dependencies.now();
  let forecastPrinted = false;
  let tagCreatedMs: number | undefined;
  for (let iteration = 0; iteration < SHIP_LIMITS.iterationsMax; iteration += 1) {
    const facts = gatherShipFacts(dependencies.runner);
    if (!facts.ok) {
      dependencies.print(`ship: could not read the release state: ${facts.error.message}`);
      return 2;
    }
    const step = decideShip(facts.value);
    const elapsedMinutes = (dependencies.now() - startedMs) / 60_000;
    const stamp = `[${String(Math.floor(elapsedMinutes)).padStart(3, ' ')}m] ${facts.value.originSha.slice(0, 8)} v${facts.value.version}`;
    switch (step.kind) {
      case 'wait': {
        dependencies.print(`${stamp} waiting: ${step.reason}`);
        if (!forecastPrinted) {
          const forecast = forecastText(elapsedMinutes, facts.value);
          if (forecast !== undefined) {
            dependencies.print(`${stamp} ${forecast}`);
            forecastPrinted = true;
          }
        }
        if (mode === 'look') {
          return 0;
        }
        if (tagCreatedMs !== undefined && facts.value.releaseRun === undefined && dependencies.now() - tagCreatedMs > SHIP_LIMITS.releaseAppearMinutesMax * 60_000) {
          // A tag created with a person's token starts release.yml at once. Nothing else may publish:
          // a dispatched release.yml is always a dry run, and Release post follows tag pushes only.
          dependencies.print(`${stamp} STOPPED: release.yml did not start within ${SHIP_LIMITS.releaseAppearMinutesMax} minutes of the tag.`);
          dependencies.print(`${stamp} next step: check Actions for a Release run on v${facts.value.version}; GitHub may be delayed. Run this command again; it waits for the run, and never moves the tag.`);
          return 1;
        }
        await dependencies.sleeper(SHIP_LIMITS.pollDelayMs);
        continue;
      }
      case 'done':
        dependencies.print(`${stamp} DONE: ${step.summary}`);
        return 0;
      case 'stop':
        dependencies.print(`${stamp} STOPPED: ${step.reason}`);
        dependencies.print(`${stamp} next step: ${step.nextStep}`);
        return 1;
      case 'bump': {
        const plan = planRemoteBump({ baseSha: step.baseSha, previous: step.previous, version: step.version }, dependencies.runner);
        if (!plan.ok) {
          dependencies.print(`${stamp} STOPPED: the bump could not be planned: ${plan.error.message}`);
          return 1;
        }
        if (step.note !== undefined) {
          dependencies.print(`${stamp} note: ${step.note}`);
        }
        dependencies.print(`${stamp} next: bump ${step.previous} -> ${step.version} on ${step.baseSha.slice(0, 8)} (${plan.value.changes.map((change) => change.path).join(', ')})`);
        if (mode === 'look') {
          dependencies.print('Nothing written. Run `npm run release:ship -- --confirm` to release.');
          return 0;
        }
        const commit = writeRemoteBump(plan.value, dependencies.runner, dependencies.writer);
        if (!commit.ok) {
          dependencies.print(`${stamp} STOPPED: ${commit.error.message}`);
          return 1;
        }
        dependencies.print(`${stamp} bumped: main is ${commit.value.slice(0, 8)}; Check and Candidate start on it now.`);
        await dependencies.sleeper(SHIP_LIMITS.pollDelayMs);
        continue;
      }
      case 'rerun': {
        dependencies.print(`${stamp} next: rerun the failed jobs of ${step.workflow} run ${step.runId} (every failure is a known infrastructure flake, first attempt)`);
        if (mode === 'look') {
          return 0;
        }
        const rerun = dependencies.writer({ command: 'gh', argumentsList: ['run', 'rerun', String(step.runId), '--failed', '--repo', SOURCE_REPOSITORY], output: 'capture' });
        if (!rerun.ok) {
          dependencies.print(`${stamp} STOPPED: the rerun could not start: ${rerun.error.message}`);
          return 1;
        }
        await dependencies.sleeper(SHIP_LIMITS.pollDelayMs);
        continue;
      }
      case 'tag': {
        dependencies.print(`${stamp} next: tag v${step.version} on ${step.sha.slice(0, 8)} (Check and Candidate are green on this exact SHA)`);
        if (mode === 'look') {
          dependencies.print('Nothing written. Run `npm run release:ship -- --confirm` to release.');
          return 0;
        }
        const tagged = writeRemoteTag(step.version, step.sha, dependencies.writer);
        if (!tagged.ok) {
          dependencies.print(`${stamp} STOPPED: the tag could not be created: ${tagged.error.message}`);
          return 1;
        }
        tagCreatedMs = dependencies.now();
        dependencies.print(`${stamp} tagged v${step.version}; release.yml promotes the candidate's artifacts.`);
        await dependencies.sleeper(SHIP_LIMITS.pollDelayMs);
        continue;
      }
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
  }
  dependencies.print(`ship: still not live after ${SHIP_LIMITS.iterationsMax} minutes; run the command again to resume where it is.`);
  return 1;
}

export function parseShipArguments(argumentsList: readonly string[]): Result<ShipMode> {
  if (argumentsList.length === 0) {
    return ok('look');
  }
  if (argumentsList.length === 1 && argumentsList[0] === '--confirm') {
    return ok('confirm');
  }
  return fail('usage', 'usage: npm run release:ship [-- --confirm]');
}

async function main(argumentsList: readonly string[]): Promise<number> {
  const mode = parseShipArguments(argumentsList);
  if (!mode.ok) {
    console.error(mode.error.message);
    return 2;
  }
  const bootstrap = systemCommandRunner(process.env);
  const environment = flowtricksEnvironment(process.env, bootstrap);
  return ship(mode.value, {
    runner: systemCommandRunner(environment),
    writer: systemWriteRunner(environment),
    sleeper: systemSleeper,
    now: () => Date.now(),
    print: (line) => {
      console.log(line);
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
