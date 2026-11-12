// One clock for every live timer in the transcript. A running turn shows several: the line under the
// transcript, each running tool call, each background task. They must not each own an interval, so
// they all read this ticker, which runs a single interval while at least one of them is mounted and
// none otherwise: a finished turn costs no timer at all.
//
// The clock is injected (`createTicker`) so a test advances time by hand.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';

export interface TickerClock {
  readonly now: () => number;
  readonly setInterval: (callback: () => void, periodMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface Ticker {
  readonly subscribe: (listener: () => void) => () => void;
  /** The clock reading as of the last tick (stable between ticks, as a store snapshot must be). */
  readonly read: () => number;
  /** How many listeners are attached; the interval runs when this is above zero. */
  readonly listenerCount: () => number;
}

export const TICK_MS = 1000;

/** A reading older than this is refreshed on read while nobody listens, so the first paint is not minutes stale. */
const STALE_MS = 500;

export function createTicker(clock: TickerClock, periodMs: number): Ticker {
  assert(periodMs > 0, 'createTicker: a positive period');
  const listeners = new Set<() => void>();
  let handle: unknown;
  let reading = clock.now();
  const tick = (): void => {
    reading = clock.now();
    for (const listener of [...listeners]) {
      listener();
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        reading = clock.now();
        handle = clock.setInterval(tick, periodMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clock.clearInterval(handle);
          handle = undefined;
        }
      };
    },
    read() {
      if (listeners.size === 0) {
        const current = clock.now();
        if (current - reading >= STALE_MS) {
          reading = current;
        }
      }
      return reading;
    },
    listenerCount: () => listeners.size,
  };
}

const systemClock: TickerClock = {
  now: () => Date.now(),
  setInterval: (callback, periodMs) => window.setInterval(callback, periodMs),
  clearInterval: (handle) => window.clearInterval(typeof handle === 'number' ? handle : undefined),
};

let shared: Ticker | undefined;

/** The ticker the whole transcript shares; created on first use so importing this module reads no clock. */
export function sharedTicker(): Ticker {
  shared ??= createTicker(systemClock, TICK_MS);
  return shared;
}

/** The time of the last tick, re-rendering the caller once a second while it is mounted. */
export function useNow(): number {
  const ticker = sharedTicker();
  return useSyncExternalStore(ticker.subscribe, ticker.read, ticker.read);
}
