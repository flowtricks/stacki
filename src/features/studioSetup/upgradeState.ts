// The Studio box's upgrade state machine: one pure reducer, so what the box shows after any sequence of
// answers, progress snapshots and clicks can be tested without a window.
//
//   checking -> unavailable | current | ready                              (the check answers)
//   ready | failure -> running -> success | failure                         (start; a retry is a start)
//   current | ready | success | restoreFailure -> restoring -> restored | restoreFailure   (restore)
//
// An event that does not fit the state is ignored, not an error: a late progress snapshot or a second click
// must never move the box. A late check never overwrites a running, finished or failed operation.
import { assert } from '../../../shared/core/assert';
import type { StudioInstallProgress } from '../../../shared/ipc/studioProgress';
import type { StudioRestoreResult, StudioUpgradeCheck, StudioUpgradeNote, StudioUpgradeResult } from '../../../shared/ipc/studioUpgrade';

export type UpgradeState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'current'; readonly version: string; readonly previous: StudioUpgradeNote | undefined }
  | { readonly kind: 'ready'; readonly installed: string; readonly latest: string; readonly previous: StudioUpgradeNote | undefined }
  | { readonly kind: 'running'; readonly installed: string; readonly latest: string; readonly requestId: string; readonly progress: StudioInstallProgress }
  | { readonly kind: 'success'; readonly note: StudioUpgradeNote }
  | { readonly kind: 'failure'; readonly installed: string; readonly latest: string; readonly message: string }
  | { readonly kind: 'restoring'; readonly note: StudioUpgradeNote }
  | { readonly kind: 'restored'; readonly version: string }
  | { readonly kind: 'restoreFailure'; readonly note: StudioUpgradeNote; readonly message: string };

export type UpgradeEvent =
  | { readonly type: 'checked'; readonly check: StudioUpgradeCheck }
  | { readonly type: 'start'; readonly requestId: string; readonly progress: StudioInstallProgress }
  | { readonly type: 'progress'; readonly progress: StudioInstallProgress }
  | { readonly type: 'finished'; readonly result: StudioUpgradeResult }
  | { readonly type: 'restore' }
  | { readonly type: 'restoreFinished'; readonly result: StudioRestoreResult };

export const UPGRADE_INITIAL: UpgradeState = { kind: 'checking' };

/** Whether the person may start (or retry) an upgrade now; the button's enabled state and the reducer share this answer. */
export function canStartUpgrade(state: UpgradeState): state is Extract<UpgradeState, { kind: 'ready' | 'failure' }> {
  return state.kind === 'ready' || state.kind === 'failure';
}

/** The upgrade a restore would undo, when the state still offers one. */
export function restorableNote(state: UpgradeState): StudioUpgradeNote | undefined {
  switch (state.kind) {
    case 'current':
    case 'ready':
      return state.previous;
    case 'success':
    case 'restoreFailure':
      return state.note;
    case 'checking':
    case 'unavailable':
    case 'running':
    case 'failure':
    case 'restoring':
    case 'restored':
      return undefined;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function reduceUpgrade(state: UpgradeState, event: UpgradeEvent): UpgradeState {
  switch (event.type) {
    case 'checked':
      return acceptsCheck(state) ? fromCheck(event.check) : state;
    case 'start':
      if (!canStartUpgrade(state)) {
        return state;
      }
      assert(event.progress.requestId === event.requestId, 'The first snapshot belongs to the request that started');
      return { kind: 'running', installed: state.installed, latest: state.latest, requestId: event.requestId, progress: event.progress };
    case 'progress':
      return state.kind === 'running' && event.progress.requestId === state.requestId ? { ...state, progress: event.progress } : state;
    case 'finished':
      return state.kind === 'running' ? finish(state, event.result) : state;
    case 'restore': {
      const note = restorableNote(state);
      return note === undefined ? state : { kind: 'restoring', note };
    }
    case 'restoreFinished':
      if (state.kind !== 'restoring') {
        return state;
      }
      return event.result.kind === 'restored'
        ? { kind: 'restored', version: event.result.version }
        : { kind: 'restoreFailure', note: state.note, message: event.result.message };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

// Only a box that is still waiting or resting takes a new answer; an operation in flight or finished keeps its own.
function acceptsCheck(state: UpgradeState): boolean {
  switch (state.kind) {
    case 'checking':
    case 'unavailable':
    case 'current':
    case 'ready':
      return true;
    case 'running':
    case 'success':
    case 'failure':
    case 'restoring':
    case 'restored':
    case 'restoreFailure':
      return false;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function fromCheck(check: StudioUpgradeCheck): UpgradeState {
  switch (check.kind) {
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'current':
      return { kind: 'current', version: check.version, previous: check.previous };
    case 'ready':
      return { kind: 'ready', installed: check.installed, latest: check.latest, previous: check.previous };
    default: {
      const exhaustive: never = check;
      return exhaustive;
    }
  }
}

function finish(state: Extract<UpgradeState, { kind: 'running' }>, result: StudioUpgradeResult): UpgradeState {
  if (result.kind === 'upgraded') {
    return { kind: 'success', note: result.note };
  }
  return { kind: 'failure', installed: state.installed, latest: state.latest, message: result.message };
}
