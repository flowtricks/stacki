// What happens when release.yml fails, decided by rule instead of by judgement:
//
//   - every failed job's log (and annotations) matches a known infrastructure flake for that job
//     (knownFlakes.mts), and this is the run's first attempt: rerun the failed jobs, once;
//   - anything else: stop, and write the failure and the single next step to the summary.
//
// Never a code change, never a retag, never a second rerun: a failure that survives one rerun is
// real, and a real failure needs a person (or an agent given the run URL) to diagnose it, fix it
// with a regression test, and release the next patch.

import { assert } from '../policy/assert.mts';
import { KNOWN_FLAKES, type FlakeSignature } from './knownFlakes.mts';
import { parseRecord, readInteger, readList, readOptionalString, readRecord, readString, parseRecordList } from './releaseJson.mts';
import { ok, type Result } from './releaseResult.mts';

export const RERUN_LIMITS = {
  logCharsMax: 8 * 1024 * 1024,
  jobsMax: 100,
} as const satisfies Record<string, number>;

export interface FailedJob {
  readonly id: number;
  readonly name: string;
  // The job's failed-step log, prefixes removed, plus its annotations.
  readonly text: string;
}

export type RerunDecision =
  | { readonly kind: 'rerun'; readonly matches: readonly { readonly job: string; readonly flake: FlakeSignature }[] }
  | { readonly kind: 'stop'; readonly reason: string; readonly nextStep: string };

export const REAL_FAILURE_NEXT_STEP =
  'This is a real failure. Give an agent the failing run URL and docs/release-runbook.md; it fixes the cause with a regression test, ' +
  'and you release the next patch with the Release button. Never move or delete the tag.';

export function decideRerun(attempt: number, failedJobs: readonly FailedJob[]): RerunDecision {
  assert(Number.isSafeInteger(attempt), 'decideRerun: the attempt is an integer');
  assert(attempt >= 1, 'decideRerun: attempts start at one');
  if (failedJobs.length === 0) {
    return { kind: 'stop', reason: 'release.yml did not succeed, but no job failed (cancelled or skipped).', nextStep: 'Open the run; if it was cancelled by hand, press Re-run all jobs once.' };
  }
  if (attempt > 1) {
    const names = failedJobs.map((job) => job.name).join(', ');
    return { kind: 'stop', reason: `attempt ${attempt} failed again (${names}); a failure that repeats after a rerun is not a flake.`, nextStep: REAL_FAILURE_NEXT_STEP };
  }
  const matches: { job: string; flake: FlakeSignature }[] = [];
  for (const job of failedJobs) {
    const flake = KNOWN_FLAKES.find((signature) => signature.jobPattern.test(job.name) && signature.logPattern.test(job.text));
    if (flake === undefined) {
      return { kind: 'stop', reason: `${job.name} failed, and its log matches no known infrastructure flake.`, nextStep: REAL_FAILURE_NEXT_STEP };
    }
    matches.push({ job: job.name, flake });
  }
  assert(matches.length === failedJobs.length, 'decideRerun: every failed job is explained');
  return { kind: 'rerun', matches };
}

/** One line of `gh run view --log-failed`, without its job, step and timestamp columns. */
export function logLineText(line: string): { readonly job: string; readonly text: string } | undefined {
  const firstTab = line.indexOf('\t');
  const secondTab = firstTab < 0 ? -1 : line.indexOf('\t', firstTab + 1);
  if (secondTab < 0) {
    return undefined;
  }
  const rest = line.slice(secondTab + 1).replace(/^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, '');
  return { job: line.slice(0, firstTab), text: rest };
}

/** The failed log, split by job name. */
export function splitFailedLog(log: string): ReadonlyMap<string, string> {
  assert(log.length <= RERUN_LIMITS.logCharsMax, 'splitFailedLog: the log is bounded');
  const byJob = new Map<string, string[]>();
  for (const line of log.split('\n')) {
    const parsed = logLineText(line.replace(/\r$/, ''));
    if (parsed === undefined) {
      continue;
    }
    const lines = byJob.get(parsed.job) ?? [];
    lines.push(parsed.text);
    byJob.set(parsed.job, lines);
  }
  return new Map([...byJob].map(([job, lines]) => [job, `${lines.join('\n')}\n`]));
}

export interface RunJob {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | undefined;
}

export function parseRunJobs(text: string): Result<readonly RunJob[]> {
  const record = parseRecord(text, 'gh run view jobs');
  if (!record.ok) {
    return record;
  }
  const list = readList(record.value['jobs'], 'gh run view jobs');
  if (!list.ok) {
    return list;
  }
  if (list.value.length > RERUN_LIMITS.jobsMax) {
    return { ok: false, error: { code: 'json-too-large', message: 'more jobs than the limit' } };
  }
  const jobs: RunJob[] = [];
  for (const entry of list.value) {
    const job = readRecord(entry, 'job');
    if (!job.ok) {
      return job;
    }
    const id = readInteger(job.value, 'databaseId', 'job');
    const name = readString(job.value, 'name', 'job');
    if (!id.ok) {
      return id;
    }
    if (!name.ok) {
      return name;
    }
    jobs.push({ id: id.value, name: name.value, conclusion: readOptionalString(job.value, 'conclusion') });
  }
  return ok(jobs);
}

/** Annotation messages from the check-runs API; a lost runner leaves its message only here. */
export function parseAnnotations(text: string): Result<readonly string[]> {
  const records = parseRecordList(text, 'annotations');
  if (!records.ok) {
    return records;
  }
  return ok(records.value.map((record) => readOptionalString(record, 'message') ?? '').filter((message) => message.length > 0));
}
