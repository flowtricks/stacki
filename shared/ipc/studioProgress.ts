import { pathText, record, text } from '../core/boundary';
import { assert } from '../core/assert';

export const STUDIO_INSTALL_STAGES = ['release', 'files', 'dependencies', 'check', 'build', 'activate', 'complete'] as const;
export type StudioInstallStage = (typeof STUDIO_INSTALL_STAGES)[number];
// Keep snapshots small even when npm emits extensive dependency diagnostics.
export const STUDIO_LOG_CHARS_MAX = 24_000;
export interface StudioInstallProgress {
  readonly projectPath: string;
  readonly requestId: string;
  readonly stage: StudioInstallStage;
  readonly output: string;
}
export type StudioInstallUpdate = { readonly kind: 'stage'; readonly stage: StudioInstallStage } | { readonly kind: 'output'; readonly text: string };

export function studioCompletedStages(stage: StudioInstallStage): number {
  const completed = STUDIO_INSTALL_STAGES.indexOf(stage);
  assert(completed >= 0, 'Studio progress stage belongs to the installation sequence');
  assert(completed < STUDIO_INSTALL_STAGES.length, 'Studio progress stays within its stage count');
  return completed;
}

export function parseStudioRequestId(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(input)) {
    throw new Error('Invalid Studio installation request ID');
  }
  return input;
}

export function parseStudioInstallProgress(input: unknown): StudioInstallProgress {
  const value = record(input);
  const stage = STUDIO_INSTALL_STAGES.find((candidate) => candidate === value['stage']);
  if (stage === undefined) {
    throw new Error('Invalid Studio installation stage');
  }
  const output = text(value['output']);
  if (output.length > STUDIO_LOG_CHARS_MAX) {
    throw new Error('Studio installation output exceeds limit');
  }
  return {
    projectPath: pathText(value['projectPath']),
    requestId: parseStudioRequestId(value['requestId']),
    stage,
    output,
  };
}
