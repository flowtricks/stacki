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
