// Connects the app window's failure events to the decision in windowHealth.ts and acts on it: reload, restart a hung
// renderer, or show the recovery screen. Everything Electron-specific arrives through the small interfaces below, so
// the whole sequence (events in, reloads and the recovery page out) runs in a test against fakes.
//
// The window is never left black: every failure reaches `handle`, which always ends in a reload, a restart of the
// renderer or the recovery page; the only events that do nothing are the ones that are not failures (a replaced
// navigation, a clean exit, a hang that ended on its own).
import { assert } from '../../shared/core/assert';
import type { MainMessageKey } from '../lib/mainLocale';
import { CRASH_LOG_LIMITS, appendCrash, describeCrashLog, readCrashLog, writeCrashLog, type CrashRecord } from './crashLog';
import { recoveryActionOf, renderRecoveryPage, recoveryPageUrl } from './recoveryPage';
import { HEALTHY, WINDOW_HEALTH_LIMITS, decideHealth, type HealthEvent, type HealthState } from './windowHealth';

type Translate = (key: MainMessageKey, params?: Readonly<Record<string, string | number>>) => string;

/** The part of a window's web contents this needs. Electron's own typed `on` listeners stay in main.ts, which calls `handle`. */
export interface RecoverableContents {
  readonly reload: () => void;
  readonly loadURL: (url: string) => Promise<void>;
  readonly forcefullyCrashRenderer: () => void;
  readonly isDestroyed: () => boolean;
}

export interface WindowRecoveryOptions {
  readonly contents: RecoverableContents;
  /** Where the crash log lives. */
  readonly directory: string;
  readonly homeDirectory: string | undefined;
  readonly now: () => number;
  /** Runs `action` after `delayMs`; the handle cancels it. */
  readonly setTimer: (action: () => void, delayMs: number) => { readonly cancel: () => void };
  readonly translate: () => Translate;
  readonly locale: () => string;
  /** Loads the app's own page again; what Reload on the recovery screen does, since the window then shows the recovery page. */
  readonly loadApp: () => Promise<void>;
  /** Called once the recovery page is up, so a window still waiting for its first frame is shown instead of staying hidden. */
  readonly onRecoveryShown: () => void;
  /** Lets the person pick another project; the window then loads it. */
  readonly openProject: () => void;
  readonly copyText: (text: string) => void;
  readonly log: (message: string) => void;
}

export interface WindowRecovery {
  /** Feeds one event into the guard. Public so main can forward events that arrive on `app`, not on the window. */
  readonly handle: (event: HealthEvent) => void;
  /** Deals with a navigation of the window: true when it was a recovery link (the caller cancels the navigation). */
  readonly handleNavigation: (url: string) => boolean;
  /** The records so far, oldest first. */
  readonly records: () => readonly CrashRecord[];
  /** Records something that is not a window event (a main-process error). */
  readonly note: (record: Pick<CrashRecord, 'source' | 'reason' | 'detail'>) => void;
}

export function attachWindowRecovery(options: WindowRecoveryOptions): WindowRecovery {
  assert(WINDOW_HEALTH_LIMITS.reloadsMax > 0, 'The window recovery reloads a bounded, positive number of times');
  assert(CRASH_LOG_LIMITS.entriesMax > 0, 'The window recovery keeps a crash log');
  let state: HealthState = HEALTHY;
  let records: readonly CrashRecord[] = readCrashLog(options.directory);
  let hangTimer: { readonly cancel: () => void } | undefined;

  const remember = (entry: Pick<CrashRecord, 'source' | 'reason' | 'detail'>): void => {
    records = appendCrash(records, { atMs: options.now(), ...entry }, options.homeDirectory);
    // A log that cannot be written is reported once per attempt and never throws: it must not be the next failure.
    if (!writeCrashLog(options.directory, records)) {
      options.log('[recovery] the crash log could not be written');
    }
  };

  const showRecovery = (reason: Extract<ReturnType<typeof decideHealth>['decision'], { readonly action: 'show-recovery' }>['reason']): void => {
    const html = renderRecoveryPage({ lang: options.locale(), reason, details: describeCrashLog(records) }, options.translate());
    options.contents.loadURL(recoveryPageUrl(html)).catch((error: unknown) => {
      options.log(`[recovery] the recovery page did not load: ${String(error)}`);
    });
    options.onRecoveryShown();
  };

  // The decision for one event, and doing what it says.
  const apply = (event: HealthEvent): void => {
    if (options.contents.isDestroyed()) {
      return;
    }
    const step = decideHealth(state, event, options.now());
    state = step.state;
    if (step.record !== undefined) {
      remember(step.record);
    }
    switch (step.decision.action) {
      case 'ignore':
      case 'record-only':
        return;
      case 'reload':
        if (event.kind === 'reload-requested') {
          options.loadApp().catch((error: unknown) => options.log(`[recovery] the app page did not load: ${String(error)}`));
        } else {
          options.contents.reload();
        }
        return;
      case 'restart-renderer':
        // The renderer reports `render-process-gone` after this, which the guard counts like any crash.
        options.contents.forcefullyCrashRenderer();
        return;
      case 'show-recovery':
        showRecovery(step.decision.reason);
        return;
      default: {
        const exhaustive: never = step.decision;
        return exhaustive;
      }
    }
  };

  // A hang is a failure only when it lasts, so the first report arms a timer and the window answering again disarms it.
  const handle = (event: HealthEvent): void => {
    apply(event);
    if (event.kind === 'unresponsive' || event.kind === 'responsive') {
      if (hangTimer !== undefined) {
        hangTimer.cancel();
        hangTimer = undefined;
      }
    }
    if (event.kind === 'unresponsive') {
      hangTimer = options.setTimer(() => apply({ kind: 'unresponsive-too-long' }), WINDOW_HEALTH_LIMITS.unresponsiveMsMax);
    }
  };

  // A navigation of the window: true when it was one of the recovery page's own links and has been dealt with.
  const handleNavigation = (url: string): boolean => {
    const action = recoveryActionOf(url);
    if (action === undefined) {
      return false;
    }
    switch (action) {
      case 'reload':
        apply({ kind: 'reload-requested' });
        return true;
      case 'open-project':
        options.openProject();
        return true;
      case 'copy-details':
        options.copyText(describeCrashLog(records));
        return true;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  };

  return {
    handle,
    handleNavigation,
    records: () => records,
    note: (entry) => remember(entry),
  };
}
