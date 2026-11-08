// Studio's publish job reports stages; the shared publish popup accepts `DesktopPublishState`.
// This is the only translation between the two, so Studio shows the same popup, steps and
// results as Desktop. The mapping is pure, so both repositories' tests can run it directly.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { DesktopPublishState } from '../../../vendor/stacki/shared/properties/publishState';
import type { PublishStage, PublishState } from './publish';

export interface PublishStatusView {
  readonly state: DesktopPublishState;
  /** Studio-only detail the shared popup shows under the result. */
  readonly note?: string;
}

/** Studio's job runs on the server, so closing or switching tabs does not stop it. */
export const STUDIO_PUBLISH_RUNNING_NOTE = 'Publishing continues if you switch tabs.';

export const PUBLISH_INTERRUPTED_MESSAGE = 'Publishing did not finish. Please try again.';

// `completed` counts the stages already finished when this stage starts.
const STAGES: Readonly<Record<PublishStage, { readonly completed: number; readonly step: string }>> = {
  preparing: { completed: 0, step: 'Preparing files…' },
  building: { completed: 1, step: 'Building website…' },
  committing: { completed: 2, step: 'Saving to GitHub…' },
  cleanup: { completed: 3, step: 'Cleaning up storage…' },
  deploying: { completed: 4, step: 'Deploying live website…' },
};

// GitHub-only runs have four stages; a run that also waits on live deployment has five.
const STAGES_TOTAL = 4;
const STAGES_TOTAL_DEPLOYED = 5;

/** `interrupted` is the client's own failure: the request or the status stream broke. */
export function publishStatusView(state: PublishState | undefined, interrupted: 'interrupted' | 'running'): PublishStatusView {
  if (interrupted === 'interrupted') {
    if (state?.kind === 'failed') {
      return { state: { kind: 'failed', message: state.message, github: false, hosting: false } };
    }
    return { state: { kind: 'failed', message: PUBLISH_INTERRUPTED_MESSAGE, github: false, hosting: false } };
  }
  if (state === undefined) {
    return { state: { kind: 'running', step: 'Preparing publish…' } };
  }
  switch (state.kind) {
    case 'idle':
      return { state: { kind: 'running', step: 'Preparing publish…' } };
    case 'building':
      return { state: runningState(state) };
    case 'committed':
      return committedView(state);
    case 'review-open':
      return { state: { kind: 'review-open', sha: state.sha, branch: state.branch, url: state.url } };
    case 'failed':
      return { state: { kind: 'failed', message: state.message, github: false, hosting: false } };
  }
}

function runningState(state: Extract<PublishState, { kind: 'building' }>): DesktopPublishState {
  if (state.stage === undefined) {
    return { kind: 'running', step: 'Preparing publish…' };
  }
  const stage = STAGES[state.stage];
  const total = state.deployment === 'pending' ? STAGES_TOTAL_DEPLOYED : STAGES_TOTAL;
  assert(stage.completed < total, `Stage ${state.stage} runs within ${total} stages`);
  assert(stage.completed >= 0, 'Completed stages are never negative');
  return { kind: 'running', step: stage.step, progress: { completed: stage.completed, total } };
}

function committedView(state: Extract<PublishState, { kind: 'committed' }>): PublishStatusView {
  const github = state.github !== 'skipped';
  const hosting = state.deployment === 'live';
  const notes: string[] = [];
  if (state.deployment === 'pending') {
    notes.push('Deployment is still unconfirmed. Check your hosting provider before publishing again.');
  } else if (state.deployment === undefined) {
    notes.push('Live deployment is not connected in this Studio.');
  } else {
    assert(hosting, 'A live deployment is a completed hosting result');
  }
  if (state.cleanupWarning !== undefined) {
    notes.push(state.cleanupWarning);
  }
  const done: DesktopPublishState = { kind: 'done', github, hosting };
  return notes.length === 0 ? { state: done } : { state: done, note: notes.join(' ') };
}
