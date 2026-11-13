// Studio's publish job reports stages; the shared publish popup accepts `DesktopPublishState`.
// This is the only translation between the two, so Studio shows the same popup, steps and
// results as Desktop. The mapping is pure, so both repositories' tests can run it directly.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { DesktopPublishState } from '../../../vendor/stacki/shared/properties/publishState';
import { described, type Described, type MessageKey, type TypedMessageRef } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import type { PublishStage, PublishState } from './publish';

export interface PublishStatusView {
  readonly state: DesktopPublishState;
  /** Studio-only detail the shared popup shows under the result. */
  readonly note?: string;
  /** The same sentences as `note`, each with its reference, so the popup can translate them; `note` is their English join. */
  readonly noteParts?: readonly Described[];
}

/** Studio's job runs on the server, so closing or switching tabs does not stop it. The key is translated where the popup is drawn. */
export const STUDIO_PUBLISH_RUNNING_NOTE_KEY = 'publish.studio.runningNote' satisfies MessageKey;

const PUBLISH_INTERRUPTED = described('publish.studio.interrupted');
export const PUBLISH_INTERRUPTED_MESSAGE = PUBLISH_INTERRUPTED.message;

// `completed` counts the stages already finished when this stage starts.
const STAGES: Readonly<Record<PublishStage, { readonly completed: number; readonly step: Described & { readonly messageRef: TypedMessageRef } }>> = {
  preparing: { completed: 0, step: described('publish.status.step.preparingFiles') },
  building: { completed: 1, step: described('publish.status.step.building') },
  committing: { completed: 2, step: described('publish.status.step.savingToGitHub') },
  cleanup: { completed: 3, step: described('publish.status.step.cleanup') },
  deploying: { completed: 4, step: described('publish.status.step.deploying') },
};
const PREPARING = described('publish.status.preparing');
const PREPARING_STATE: DesktopPublishState = { kind: 'running', step: PREPARING.message, stepRef: PREPARING.messageRef };

// GitHub-only runs have four stages; a run that also waits on live deployment has five.
const STAGES_TOTAL = 4;
const STAGES_TOTAL_DEPLOYED = 5;

/** `interrupted` is the client's own failure: the request or the status stream broke. */
export function publishStatusView(state: PublishState | undefined, interrupted: 'interrupted' | 'running'): PublishStatusView {
  if (interrupted === 'interrupted') {
    if (state?.kind === 'failed') {
      return { state: failedState(state) };
    }
    return { state: { kind: 'failed', message: PUBLISH_INTERRUPTED.message, messageRef: PUBLISH_INTERRUPTED.messageRef, github: false, hosting: false } };
  }
  if (state === undefined) {
    return { state: PREPARING_STATE };
  }
  switch (state.kind) {
    case 'idle':
      return { state: PREPARING_STATE };
    case 'building':
      return { state: runningState(state) };
    case 'committed':
      return committedView(state);
    case 'review-open':
      return { state: { kind: 'review-open', sha: state.sha, branch: state.branch, url: state.url } };
    case 'failed':
      return { state: failedState(state) };
  }
}

function failedState(state: Extract<PublishState, { kind: 'failed' }>): DesktopPublishState {
  return { kind: 'failed', message: state.message, ...(state.messageRef === undefined ? {} : { messageRef: state.messageRef }), github: false, hosting: false };
}

function runningState(state: Extract<PublishState, { kind: 'building' }>): DesktopPublishState {
  if (state.stage === undefined) {
    return PREPARING_STATE;
  }
  const stage = STAGES[state.stage];
  const total = state.deployment === 'pending' ? STAGES_TOTAL_DEPLOYED : STAGES_TOTAL;
  assert(stage.completed < total, `Stage ${state.stage} runs within ${total} stages`);
  assert(stage.completed >= 0, 'Completed stages are never negative');
  return { kind: 'running', step: stage.step.message, stepRef: stage.step.messageRef, progress: { completed: stage.completed, total } };
}

function committedView(state: Extract<PublishState, { kind: 'committed' }>): PublishStatusView {
  const github = state.github !== 'skipped';
  const hosting = state.deployment === 'live';
  const notes: Described[] = [];
  if (state.deployment === 'pending') {
    notes.push(described('publish.studio.note.unconfirmed'));
  } else if (state.deployment === undefined) {
    notes.push(described('publish.studio.note.notConnected'));
  } else {
    assert(hosting, 'A live deployment is a completed hosting result');
  }
  if (state.cleanupWarning !== undefined) {
    // The server's own cleanup sentence has no reference; the retry notice carries one.
    notes.push(
      state.cleanupWarningRef === undefined ? { message: state.cleanupWarning } : { message: state.cleanupWarning, messageRef: state.cleanupWarningRef },
    );
  }
  const done: DesktopPublishState = { kind: 'done', github, hosting };
  return notes.length === 0 ? { state: done } : { state: done, note: notes.map((part) => part.message).join(' '), noteParts: notes };
}
