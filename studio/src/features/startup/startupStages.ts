// What a cold start of the hosted preview container passes through, in order, and how the
// editor and the Worker talk about it. The container reports each stage as it begins
// (scripts/container.ts); the Durable Object keeps the last few (startupLog.ts); the editor
// reads them from a route the Worker answers without waking the container
// (/studio/api/startup), so a person sees "Restoring your drafts" instead of a spinner.
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';

/** In the order a cold start reaches them; `ready` means the preview server answers and the home page is compiled. */
export const STARTUP_STAGES = ['container', 'repository', 'drafts', 'dependencies', 'server', 'compile', 'ready'] as const;
export type StartupStage = (typeof STARTUP_STAGES)[number];

/** Why each number is what it is sits next to it; every poll, history and body is bounded by these. */
export const STARTUP_LIMITS = {
  /** A report is a stage name and one number; a longer body is not from our container. */
  reportBytesMax: 512,
  /** One entry per stage, so a history can never be longer than the stage list. */
  historyMax: STARTUP_STAGES.length,
  /** The container's clock since its process began: a day is far beyond any real start. */
  sinceStartMsMax: 86_400_000,
  /** The editor asks again this soon at first, so a stage change shows within about a second. */
  pollMsMin: 1_000,
  /** ...and never less often than this, so a long start costs few requests. */
  pollMsMax: 3_000,
  /** At the slowest rate this is over ten minutes of polling: the container's own port wait is ten minutes. */
  pollsMax: 300,
  /** The boot screen says it is slow after this, naming the stage that is taking the time. */
  slowAfterMs: 20_000,
  /** A start that has gone this long shows Retry: a cold start is normally well under a minute once the image is on the host. */
  retryAfterMs: 90_000,
} as const satisfies Record<string, number>;

export interface StartupEntry {
  readonly stage: StartupStage;
  /** Milliseconds from the container process starting to this stage beginning. */
  readonly sinceStartMs: number;
}

/** What the editor shows: where a start is, plus the measured history of this start. */
export interface StartupView {
  readonly stage: StartupStage;
  readonly history: readonly StartupEntry[];
}

export function isStartupStage(value: unknown): value is StartupStage {
  return STARTUP_STAGES.some((stage) => stage === value);
}

export function stageIndex(stage: StartupStage): number {
  return STARTUP_STAGES.indexOf(stage);
}

/** The container's report of a stage beginning. Anything else is refused, never trusted. */
export function parseStartupReport(input: unknown): Result<StartupEntry, string> {
  if (typeof input !== 'object' || input === null) {
    return err('Startup report: expected an object');
  }
  const stage: unknown = 'stage' in input ? input.stage : undefined;
  const sinceStartMs: unknown = 'sinceStartMs' in input ? input.sinceStartMs : undefined;
  if (!isStartupStage(stage)) {
    return err('Startup report: unknown stage');
  }
  if (typeof sinceStartMs !== 'number' || !Number.isSafeInteger(sinceStartMs)) {
    return err('Startup report: sinceStartMs must be a safe integer');
  }
  if (sinceStartMs < 0 || sinceStartMs > STARTUP_LIMITS.sinceStartMsMax) {
    return err('Startup report: sinceStartMs out of range');
  }
  return ok({ stage, sinceStartMs });
}

/** The Worker's answer, parsed in the editor. An older Worker has no such route: the caller treats a failure as "no detail". */
export function parseStartupView(input: unknown): Result<StartupView, string> {
  if (typeof input !== 'object' || input === null) {
    return err('Startup view: expected an object');
  }
  const stage: unknown = 'stage' in input ? input.stage : undefined;
  const history: unknown = 'history' in input ? input.history : undefined;
  if (!isStartupStage(stage)) {
    return err('Startup view: unknown stage');
  }
  if (!Array.isArray(history)) {
    return err('Startup view: history must be a list');
  }
  if (history.length > STARTUP_LIMITS.historyMax) {
    return err('Startup view: history too long');
  }
  const entries: StartupEntry[] = [];
  for (const item of history) {
    const entry = parseStartupReport(item);
    if (!entry.ok) {
      return entry;
    }
    entries.push(entry.value);
  }
  return ok({ stage, history: entries });
}
