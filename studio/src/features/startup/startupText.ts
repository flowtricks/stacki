import type { StartupStage } from './startupStages';
import { STARTUP_STAGES, stageIndex } from './startupStages';

// Literal keys, so the catalog check sees each one used.
export const STARTUP_STAGE_KEYS = {
  container: 'studio.boot.stage.container',
  repository: 'studio.boot.stage.repository',
  drafts: 'studio.boot.stage.drafts',
  dependencies: 'studio.boot.stage.dependencies',
  server: 'studio.boot.stage.server',
  compile: 'studio.boot.stage.compile',
  ready: 'studio.boot.stage.ready',
} as const satisfies Record<StartupStage, string>;

/** "Step 3 of 6": the stages before ready are the steps; ready itself is the end, not a step. */
export function startupStep(stage: StartupStage): { readonly step: number; readonly total: number } {
  const total = STARTUP_STAGES.length - 1;
  return { step: Math.min(total, stageIndex(stage) + 1), total };
}

/** What the one status row and the bar show for a step: the counter text and how full the bar is. */
export interface StartupRow {
  /** "5/6": the digits are the same in every language, so it is not a catalog message. */
  readonly counter: string;
  /** Completed steps over total, in [0, 1): the step in progress is not complete, so the bar is never full before ready. */
  readonly fraction: number;
  readonly step: number;
  readonly total: number;
}

/**
 * A step and total that may not be trusted (a future stage list, a bad report) become a row the bar can
 * draw, or undefined for the indeterminate bar. Step 0 counts as the first step; a step past the total is the last.
 */
export function startupRow(step: number, total: number): StartupRow | undefined {
  if (!Number.isSafeInteger(step) || !Number.isSafeInteger(total) || total < 1) {
    return undefined;
  }
  const clamped = Math.min(total, Math.max(1, step));
  return { counter: `${clamped}/${total}`, fraction: (clamped - 1) / total, step: clamped, total };
}

/** A bar never goes backwards while one screen is open: a late or repeated report cannot shrink it. */
export function startupFractionHeld(held: number, next: number): number {
  return Math.max(held, next);
}
