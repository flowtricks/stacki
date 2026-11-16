// A debug trace of the stages one action passes through, for finding where the time goes.
//
// Why a module of its own: "the canvas is slow to show an insert" has a dozen suspects (the
// placement check, the IPC, the write, the watcher, the compile, the patch), and a guess about
// which one is slow is how the wrong one gets fixed. A trace stamps each stage on one clock
// so the stages can be subtracted; the numbers in docs/insert-latency.md come from it.
//
// Off by default and free when off: a trace that is off is `STAGE_TRACE_OFF`, whose methods
// do nothing, so call sites never branch and never build the stage's label for nothing. A trace
// that is on keeps the last `STAGE_TRACE_LIMITS.runsMax` runs and each run's first
// `stagesMax` stages: it is a bounded ring, never a log that grows.
//
// Pure: the clock is passed in (epoch milliseconds, so two processes' traces line up), and
// nothing here reads a global.

import { assert } from './assert';

export const STAGE_TRACE_LIMITS = {
  /** Finished runs kept, oldest dropped first. */
  runsMax: 64,
  /** Stages one run records; later ones are counted in `dropped`, not stored. */
  stagesMax: 64,
} as const satisfies Record<string, number>;

export interface StageStamp {
  readonly stage: string;
  /** Epoch milliseconds, fractions kept. */
  readonly atMs: number;
}

export interface StageRun {
  readonly label: string;
  readonly stages: readonly StageStamp[];
  /** Stamps past `stagesMax`, which were not stored. */
  readonly dropped: number;
}

export interface StageTrace {
  readonly enabled: boolean;
  /** Starts a run; a run still open is finished first. */
  begin(label: string): void;
  /** Stamps a stage on the open run; nothing when no run is open. */
  mark(stage: string): void;
  /** Stamps a stage that happened elsewhere (a frame, another process) at its own time. */
  markAt(stage: string, atMs: number): void;
  /** Closes the open run, returning it. */
  finish(): StageRun | undefined;
  /** Finished runs, oldest first. */
  runs(): readonly StageRun[];
}

/** One stage of a run, as a duration: since the run began and since the stage before it. */
export interface StageDuration {
  readonly stage: string;
  readonly sinceStartMs: number;
  readonly sincePreviousMs: number;
}

/** The trace that is off: every method does nothing, so a call site costs a call and no work. */
export const STAGE_TRACE_OFF: StageTrace = Object.freeze({
  enabled: false,
  begin: (): void => undefined,
  mark: (): void => undefined,
  markAt: (): void => undefined,
  finish: (): undefined => undefined,
  runs: (): readonly StageRun[] => [],
});

export function createStageTrace(options: { readonly enabled: boolean; readonly clock: () => number }): StageTrace {
  if (!options.enabled) {
    return STAGE_TRACE_OFF;
  }
  const clock = options.clock;
  const finished: StageRun[] = [];
  let open: { label: string; stages: StageStamp[]; dropped: number } | undefined;
  const stamp = (stage: string, atMs: number): void => {
    if (open === undefined) {
      return;
    }
    assert(Number.isFinite(atMs), 'StageTrace: a stage has a finite time');
    if (open.stages.length < STAGE_TRACE_LIMITS.stagesMax) {
      open.stages.push({ stage, atMs });
    } else {
      open.dropped += 1;
    }
  };
  const finish = (): StageRun | undefined => {
    if (open === undefined) {
      return undefined;
    }
    const run: StageRun = { label: open.label, stages: open.stages, dropped: open.dropped };
    open = undefined;
    finished.push(run);
    if (finished.length > STAGE_TRACE_LIMITS.runsMax) {
      finished.shift();
    }
    assert(finished.length <= STAGE_TRACE_LIMITS.runsMax, 'StageTrace: finished runs stay inside their bound');
    return run;
  };
  return {
    enabled: true,
    begin: (label) => {
      finish();
      open = { label, stages: [], dropped: 0 };
      stamp('begin', clock());
    },
    mark: (stage) => stamp(stage, clock()),
    markAt: (stage, atMs) => stamp(stage, atMs),
    finish,
    runs: () => [...finished],
  };
}

/** A run as durations, stages in the order they happened (a stamp made at another process's time sorts by time). */
export function stageDurations(run: StageRun): readonly StageDuration[] {
  const first = run.stages[0];
  if (first === undefined) {
    return [];
  }
  const ordered = [...run.stages].sort((left, right) => left.atMs - right.atMs);
  let previous = first.atMs;
  return ordered.map((entry) => {
    const duration: StageDuration = { stage: entry.stage, sinceStartMs: entry.atMs - first.atMs, sincePreviousMs: entry.atMs - previous };
    previous = entry.atMs;
    return duration;
  });
}
