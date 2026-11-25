// Work proportional to a project's size, written once and run two ways.
//
// Stacki has no product size limit, so a scan of thousands of pages or a data
// file of tens of megabytes must finish, however long it takes. What it must
// never do is freeze the main process while it does: the window, the preview
// and the file watcher all share this one thread. So a walker is written as a
// generator that yields at every point where stopping is safe (after a
// directory, after a file). The driver decides how to run it:
//
// - `runSync` drains it in one go, for callers that are synchronous already
//   (tests, the preview plugin, helpers called from one-off code).
// - `runSliced` drains it in slices of `SLICE_MS_MAX` milliseconds and returns
//   to the event loop between them, so a scan of any size shows up as time,
//   never as a stall.
//
// One body per walker means the two cannot drift apart. The module uses only
// globals (`performance`, `setImmediate`) so Studio's browser bundle of the
// stylesheet reader, which drains these generators synchronously, can include it.
import { assert } from '../../shared/core/assert';
import { PLATFORM_LIMITS } from '../../shared/core/limits';

/** A step is one yield; the final value is the result of the work. */
export type SlicedWork<T> = Generator<void, T, void>;

/**
 * Longest one slice may run before the driver returns to the event loop. The
 * unit of work between yields is one directory or one file, so a slice can run
 * past this by that one unit; it bounds the work per slice, not the input.
 */
export const SLICE_MS_MAX = 8;

/** Runs the work to completion without yielding to the event loop. */
export function runSync<T>(work: SlicedWork<T>): T {
  let steps = 0;
  let next = work.next();
  while (next.done !== true) {
    // Each step is one unit of the input's own work, so the count stays exact.
    steps += 1;
    assert(steps <= PLATFORM_LIMITS.safeIntegerMax, 'runSync: the step count stays an exact integer');
    next = work.next();
  }
  return next.value;
}

/** Runs the work in slices, returning to the event loop between them. */
export async function runSliced<T>(work: SlicedWork<T>): Promise<T> {
  let sliceStartedMs = performance.now();
  let steps = 0;
  let next = work.next();
  while (next.done !== true) {
    steps += 1;
    assert(steps <= PLATFORM_LIMITS.safeIntegerMax, 'runSliced: the step count stays an exact integer');
    if (performance.now() - sliceStartedMs >= SLICE_MS_MAX) {
      await yieldToEventLoop();
      sliceStartedMs = performance.now();
    }
    next = work.next();
  }
  return next.value;
}

/**
 * Lets queued events (input, timers, watcher ticks) run before the caller
 * continues. `setImmediate` runs after the poll phase, so pending I/O callbacks
 * are served first, unlike a microtask, which would starve them.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * A clock for async code that cannot be a generator (it awaits real I/O): call
 * `yieldIfDue` after each unit of work and it returns to the event loop only
 * when the current slice has used its time.
 */
export function createSliceClock(): { readonly yieldIfDue: () => Promise<void> } {
  let sliceStartedMs = performance.now();
  return {
    yieldIfDue: async () => {
      if (performance.now() - sliceStartedMs >= SLICE_MS_MAX) {
        await yieldToEventLoop();
        sliceStartedMs = performance.now();
      }
    },
  };
}
