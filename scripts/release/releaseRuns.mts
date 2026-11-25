// Reading and waiting for GitHub Actions runs, shared by the release controller, the release plan
// and the post-release chain. Every wait is bounded: a poll has an attempt cap and a delay from
// COMMAND_LIMITS, so a stuck run ends the wait with a clear failure instead of hanging a job.

import { assert } from '../policy/assert.mts';
import { COMMAND_LIMITS, pollUntil, type CommandRunner, type Sleeper } from './releaseCommands.mts';
import { parseRecord, parseRecordList, readInteger, readOptionalString, readString, type JsonRecord } from './releaseJson.mts';
import { fail, ok, type Result } from './releaseResult.mts';

export interface WorkflowRun {
  readonly id: number;
  readonly workflowName: string;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | undefined;
  readonly attempt: number;
  readonly createdAt: string;
  readonly url: string;
}

export const RUN_FIELDS = 'databaseId,workflowName,event,headBranch,headSha,status,conclusion,attempt,createdAt,url';

function readRun(record: JsonRecord, label: string): Result<WorkflowRun> {
  const id = readInteger(record, 'databaseId', label);
  const workflowName = readString(record, 'workflowName', label);
  const event = readString(record, 'event', label);
  const headBranch = readString(record, 'headBranch', label);
  const headSha = readString(record, 'headSha', label);
  const status = readString(record, 'status', label);
  const attempt = readInteger(record, 'attempt', label);
  const createdAt = readString(record, 'createdAt', label);
  const url = readString(record, 'url', label);
  for (const field of [id, workflowName, event, headBranch, headSha, status, attempt, createdAt, url]) {
    if (!field.ok) {
      return field;
    }
  }
  assert(id.ok, 'readRun: id was checked');
  assert(workflowName.ok, 'readRun: workflowName was checked');
  assert(event.ok, 'readRun: event was checked');
  assert(headBranch.ok, 'readRun: headBranch was checked');
  assert(headSha.ok, 'readRun: headSha was checked');
  assert(status.ok, 'readRun: status was checked');
  assert(attempt.ok, 'readRun: attempt was checked');
  assert(createdAt.ok, 'readRun: createdAt was checked');
  assert(url.ok, 'readRun: url was checked');
  return ok({
    id: id.value,
    workflowName: workflowName.value,
    event: event.value,
    headBranch: headBranch.value,
    headSha: headSha.value,
    status: status.value,
    conclusion: readOptionalString(record, 'conclusion'),
    attempt: attempt.value,
    createdAt: createdAt.value,
    url: url.value,
  });
}

export function parseRun(text: string): Result<WorkflowRun> {
  const record = parseRecord(text, 'gh run view');
  return record.ok ? readRun(record.value, 'gh run view') : record;
}

export function parseRuns(text: string): Result<readonly WorkflowRun[]> {
  const records = parseRecordList(text, 'gh run list');
  if (!records.ok) {
    return records;
  }
  const runs: WorkflowRun[] = [];
  for (const record of records.value) {
    const run = readRun(record, 'gh run list');
    if (!run.ok) {
      return run;
    }
    runs.push(run.value);
  }
  return ok(runs);
}

export function viewRun(runner: CommandRunner, repository: string, id: number): Result<WorkflowRun> {
  const text = runner({ command: 'gh', argumentsList: ['run', 'view', String(id), '--repo', repository, '--json', RUN_FIELDS] });
  return text.ok ? parseRun(text.value) : text;
}

export interface RunQuery {
  readonly repository: string;
  readonly workflow: string;
  readonly event: string | undefined;
  readonly commit: string | undefined;
}

export function listRuns(runner: CommandRunner, query: RunQuery): Result<readonly WorkflowRun[]> {
  const argumentsList = ['run', 'list', '--repo', query.repository, '--workflow', query.workflow, '--limit', '20', '--json', RUN_FIELDS];
  if (query.event !== undefined) {
    argumentsList.push('--event', query.event);
  }
  if (query.commit !== undefined) {
    argumentsList.push('--commit', query.commit);
  }
  const text = runner({ command: 'gh', argumentsList });
  return text.ok ? parseRuns(text.value) : text;
}

export interface WaitPlan {
  readonly minutesMax: number;
  readonly delayMs: number;
  readonly sleeper: Sleeper;
}

export function attemptsFor(plan: WaitPlan): number {
  assert(plan.minutesMax > 0, 'attemptsFor: a positive wait');
  assert(plan.delayMs > 0, 'attemptsFor: a positive delay');
  const attempts = 1 + Math.ceil((plan.minutesMax * 60_000) / plan.delayMs);
  assert(attempts <= COMMAND_LIMITS.pollAttemptsMax, `attemptsFor: ${attempts} attempts exceeds the poll limit; lengthen the delay`);
  return attempts;
}

/** Waits for the first run the finder returns; a failed read is retried within the same bound. */
export async function waitForRunToAppear(plan: WaitPlan, find: () => Result<WorkflowRun | undefined>): Promise<Result<WorkflowRun>> {
  const last = await pollUntil(
    { attemptsMax: attemptsFor(plan), delayMs: plan.delayMs, sleeper: plan.sleeper },
    () => Promise.resolve(find()),
    (result) => result.ok && result.value !== undefined,
  );
  if (!last.ok) {
    return last;
  }
  if (last.value === undefined) {
    return fail('run-not-found', `no matching run appeared within ${plan.minutesMax} minute(s).`);
  }
  return ok(last.value);
}

/** Waits until the run completes; the result is the completed run, or a timeout failure. */
export async function waitForRunToComplete(plan: WaitPlan, runner: CommandRunner, repository: string, id: number): Promise<Result<WorkflowRun>> {
  const last = await pollUntil(
    { attemptsMax: attemptsFor(plan), delayMs: plan.delayMs, sleeper: plan.sleeper },
    () => Promise.resolve(viewRun(runner, repository, id)),
    (result) => result.ok && result.value.status === 'completed',
  );
  if (!last.ok) {
    return last;
  }
  if (last.value.status !== 'completed') {
    return fail('run-timeout', `run ${last.value.url} is still ${last.value.status} after ${plan.minutesMax} minute(s).`);
  }
  return ok(last.value);
}

/** The newest run created at or after `since` (ISO time), which a dispatch just made. */
export function newestSince(runs: readonly WorkflowRun[], since: string): WorkflowRun | undefined {
  const sinceMs = Date.parse(since);
  assert(Number.isFinite(sinceMs), 'newestSince: since is an ISO time');
  return runs.find((run) => Date.parse(run.createdAt) >= sinceMs);
}
