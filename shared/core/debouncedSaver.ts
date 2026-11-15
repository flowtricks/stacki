// Coalesces a burst of change events into few writes, with a hard bound on how long a change may wait. Used by the
// window's saved state and the boot snapshot: both are updated by events that arrive many times a second (a drag,
// typing) and written to disk rarely.
import { assert } from './assert';

/** What the saver needs of a clock; the global timers are the real one, a fake drives tests. */
export interface SaveClock<Timer> {
  readonly now: () => number;
  readonly setTimer: (task: () => void, delayMs: number) => Timer;
  readonly clearTimer: (timer: Timer) => void;
}

export interface SaveTiming {
  /** After the last event, how long the write waits. */
  readonly delayMs: number;
  /** A burst that never pauses still writes this often, so a crash loses at most this much. */
  readonly waitMsMax: number;
}

export interface DebouncedSaver {
  /** Asks for a save: it runs after the delay, or at the latest `waitMsMax` after the first ask of a burst. */
  readonly schedule: () => void;
  /** Runs a waiting save now (the window is closing); a no-op when none waits. */
  readonly flush: () => void;
}

/** At most one timer exists, and one write happens at most every `waitMsMax` during a continuous burst. */
export function createCoalescedSaver<Timer>(clock: SaveClock<Timer>, timing: SaveTiming, save: () => void): DebouncedSaver {
  assert(timing.delayMs > 0, 'createCoalescedSaver: the delay is positive');
  assert(timing.waitMsMax >= timing.delayMs, 'createCoalescedSaver: the bound is not below the delay');
  let timer: Timer | undefined;
  let burstStartedAtMs: number | undefined;
  const run = (): void => {
    if (timer !== undefined) {
      clock.clearTimer(timer);
    }
    timer = undefined;
    burstStartedAtMs = undefined;
    save();
  };
  return {
    schedule(): void {
      const nowMs = clock.now();
      const startedAtMs = burstStartedAtMs ?? nowMs;
      burstStartedAtMs = startedAtMs;
      if (timer !== undefined) {
        clock.clearTimer(timer);
      }
      const remainingMs = timing.waitMsMax - (nowMs - startedAtMs);
      const delayMs = Math.max(0, Math.min(timing.delayMs, remainingMs));
      assert(delayMs <= timing.delayMs, 'createCoalescedSaver: the wait is bounded');
      timer = clock.setTimer(run, delayMs);
    },
    flush(): void {
      if (timer !== undefined) {
        run();
      }
    },
  };
}
