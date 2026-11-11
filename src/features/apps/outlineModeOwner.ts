// Which app holds the canvas's deep outline mode (docs/apps.md, "Outline modes"),
// by the rules canvas capture follows (canvasCapture.ts): the latest app to set it
// owns it, and it goes back to the editor's normal mode on its own when it no longer
// fits what the person is doing. It resets when:
//
//   - the owner sets `normal`, or stops running (silently: its frames are gone);
//   - the person opens another rail panel than Apps (`panel`);
//   - another app is opened or brought to the panel, or sets a mode itself (`replaced`);
//   - the project closes (`project`).
//
// What an app asked for outlives a reset for leaving: each app's last request is
// kept, and when the person comes back to it (its panel shown again, its popup
// focused or shown) it gets deep mode back, heard as `restored`. The app's own
// `normal`, and the app stopping, forget the request; the project closing forgets
// every one.
//
// Deep mode changes only what the hover outlines; the canvas frame never lets a
// click select inside a closed component (electron/preload/frameOutlineMode.ts).
// Pure state over callbacks, so tests drive it without frames; the runtime
// (appsRuntime.ts) owns the one instance and `apply` tells the canvas.
import { assert } from '../../../shared/core/assert';
import type { AppEditOutcome, AppEventData, AppEventName, AppOutlineMode, AppOutlineReason } from '../../../shared/properties/appsRpc';

export interface OutlineModeDeps {
  readonly emit: <E extends AppEventName>(appId: string, event: E, data: AppEventData[E]) => number;
  readonly running: (appId: string) => boolean;
  /** Puts the canvas in a mode (src/ui/canvasOutlineMode.ts). */
  readonly apply: (mode: AppOutlineMode) => void;
}

export interface OutlineModeOwner {
  /** `canvas.setOutlineMode`: the calling app sets the mode. */
  readonly set: (appId: string, mode: AppOutlineMode) => AppEditOutcome;
  /** The app that holds deep mode, if one does. */
  readonly owner: () => string | undefined;
  /** Back to normal for `reason`, telling the owner; false when nothing was held. */
  readonly reset: (reason: Exclude<AppOutlineReason, 'app' | 'restored'>) => boolean;
  /** The person came back to an app: the deep mode it last asked for, if it did, is its again. */
  readonly restore: (appId: string) => boolean;
  /** An app was opened or brought to the panel: another app's deep mode ends. */
  readonly shown: (appId: string) => void;
  /** The running apps changed: an owner that stopped loses the mode, silently. */
  readonly changed: () => void;
}

export function createOutlineModeOwner(deps: OutlineModeDeps): OutlineModeOwner {
  let owner: string | undefined;
  // The apps whose last request was deep: bounded by the running apps, which drop out as they stop.
  const requested = new Set<string>();
  const release = (): string | undefined => {
    const previous = owner;
    owner = undefined;
    deps.apply('normal');
    return previous;
  };
  const reset = (reason: Exclude<AppOutlineReason, 'app' | 'restored'>): boolean => {
    if (reason === 'project') {
      requested.clear();
    }
    if (owner === undefined) {
      return false;
    }
    const previous = release();
    assert(previous !== undefined, 'A reset releases the owner it had');
    deps.emit(previous, 'canvas.outline', { mode: 'normal', reason });
    return true;
  };
  return {
    set: (appId, mode) => {
      if (mode === 'normal') {
        requested.delete(appId);
        if (owner === appId) {
          release();
          deps.emit(appId, 'canvas.outline', { mode: 'normal', reason: 'app' });
        }
        assert(owner !== appId, 'An app that sets normal holds no deep mode');
        return { applied: true };
      }
      if (!deps.running(appId)) {
        return { applied: false, reason: 'Only a running app sets the outline mode' };
      }
      if (owner !== undefined && owner !== appId) {
        reset('replaced');
      }
      owner = appId;
      requested.add(appId);
      deps.apply('deep');
      deps.emit(appId, 'canvas.outline', { mode: 'deep', reason: 'app' });
      assert(owner === appId, 'The latest app to set deep mode owns it');
      return { applied: true };
    },
    owner: () => owner,
    reset,
    restore: (appId) => {
      if (owner === appId || !requested.has(appId) || !deps.running(appId)) {
        return false;
      }
      if (owner !== undefined) {
        reset('replaced');
      }
      owner = appId;
      deps.apply('deep');
      deps.emit(appId, 'canvas.outline', { mode: 'deep', reason: 'restored' });
      assert(requested.has(appId), 'Only a requested mode is restored');
      return true;
    },
    shown: (appId) => {
      if (owner !== undefined && owner !== appId) {
        reset('replaced');
      }
    },
    changed: () => {
      for (const appId of [...requested]) {
        if (!deps.running(appId)) {
          requested.delete(appId); // A stopped app's request goes with it.
        }
      }
      if (owner !== undefined && !deps.running(owner)) {
        release();
      }
    },
  };
}
