// An asset's pixel size for the List view's second line ("1920 x 1080 • 7.5 kB"), read lazily.
//
// Only a row on screen asks, a few reads run at once, and each answer is kept per file AND its
// modified time and size, so an edited file is read again and an unchanged one never is. The read
// itself is the main process's header reader (`assets:dimensions`, a 32 KB read, never a decode),
// or Studio's image load, so the panel's own thread never parses a file. The size shows at once; the
// dimensions fill in beside it when they arrive, on a line whose height is already reserved.
//
// Bounds: `DIMENSION_READS_MAX` reads in flight, `DIMENSION_QUEUE_MAX` waiting (the oldest waiting
// request is dropped first: its row has most likely scrolled away, and asks again if it comes back),
// and `DIMENSION_ENTRIES_MAX` answers kept (the least recently used goes first). None of them stops
// a large project: past a bound the cache forgets or reads later, it never refuses.
import { useEffect, useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import type { Result } from '../../../shared/core/result';

export const DIMENSION_READS_MAX = 4;
export const DIMENSION_QUEUE_MAX = 256;
export const DIMENSION_ENTRIES_MAX = 20_000;

export interface PixelSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** What is known of a file's size: nothing yet, its pixels, or that it has none to tell. */
export type DimensionState = { readonly kind: 'pending' } | { readonly kind: 'known'; readonly size: PixelSize } | { readonly kind: 'none' };

/** The file a read is for, and what makes its answer stale. */
export interface DimensionSubject {
  readonly rel: string;
  readonly size: number;
  readonly modifiedMs?: number;
}

export type DimensionReader = (rel: string) => Promise<Result<PixelSize | undefined, string>>;

export interface DimensionCache {
  /** The current state, or undefined when nothing has asked yet. */
  readonly get: (subject: DimensionSubject) => DimensionState | undefined;
  /** Asks for a read, unless one is known, running or waiting. */
  readonly request: (subject: DimensionSubject) => void;
  /** Records a size learned elsewhere (a video's metadata as its thumbnail loads). */
  readonly put: (subject: DimensionSubject, size: PixelSize) => void;
  readonly subscribe: (listener: () => void) => () => void;
  /** Counts for tests and the report: reads started, answers held, requests waiting. */
  readonly stats: () => { readonly reads: number; readonly entries: number; readonly waiting: number };
}

export function dimensionKey(subject: DimensionSubject): string {
  return `${subject.rel}\u0000${subject.size}\u0000${subject.modifiedMs ?? ''}`;
}

export function createDimensionCache(read: DimensionReader): DimensionCache {
  // A Map keeps insertion order: deleting and re-setting a key on use makes it the newest.
  const entries = new Map<string, DimensionState>();
  const waiting = new Map<string, string>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let running = 0;
  let reads = 0;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const remember = (key: string, state: DimensionState): void => {
    entries.delete(key);
    entries.set(key, state);
    // At most one over: each call adds one key.
    if (entries.size > DIMENSION_ENTRIES_MAX) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) {
        entries.delete(oldest);
      }
    }
    assert(entries.size <= DIMENSION_ENTRIES_MAX, 'The cache keeps at most its entry count');
  };
  // A finished read makes room for the next: the queue drains one answer at a time, never by recursion.
  const finish = (key: string, state: DimensionState): void => {
    running -= 1;
    inFlight.delete(key);
    assert(running >= 0, 'Reads finish once each');
    assert(running === inFlight.size, 'Every running read is in flight once');
    remember(key, state);
    notify();
    queueMicrotask(drain);
  };
  const pump = (): void => {
    while (running < DIMENSION_READS_MAX && waiting.size > 0) {
      // The newest request first: it is the row the person is looking at now.
      const key = [...waiting.keys()].at(-1);
      assert(key !== undefined, 'A non-empty queue has a newest request');
      const rel = waiting.get(key);
      assert(rel !== undefined, 'A waiting request names its file');
      waiting.delete(key);
      inFlight.add(key);
      running += 1;
      reads += 1;
      void read(rel)
        .then(
          (result) => (result.ok && result.value !== undefined ? { kind: 'known' as const, size: result.value } : { kind: 'none' as const }),
          // A read that throws is an unreadable file to this line, never a crash of the panel.
          () => ({ kind: 'none' as const }),
        )
        .then((state) => finish(key, state));
    }
    assert(running <= DIMENSION_READS_MAX, 'Reads in flight stay within their bound');
  };
  function drain(): void {
    pump();
  }

  return {
    get: (subject) => entries.get(dimensionKey(subject)),
    request: (subject) => {
      const key = dimensionKey(subject);
      if (entries.has(key) || waiting.has(key) || inFlight.has(key)) {
        return;
      }
      waiting.set(key, subject.rel);
      if (waiting.size > DIMENSION_QUEUE_MAX) {
        const oldest = waiting.keys().next().value;
        if (oldest !== undefined) {
          waiting.delete(oldest);
        }
      }
      assert(waiting.size <= DIMENSION_QUEUE_MAX, 'The queue stays within its bound');
      // Pending is shown, not stored: a dropped request leaves no state behind to look stuck.
      pump();
    },
    put: (subject, size) => {
      assert(size.widthPx > 0, 'A learned width is positive');
      assert(size.heightPx > 0, 'A learned height is positive');
      remember(dimensionKey(subject), { kind: 'known', size });
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stats: () => ({ reads, entries: entries.size, waiting: waiting.size }),
  };
}

const PENDING: DimensionState = { kind: 'pending' };

/** The file's state in the cache, asking for a read while `wanted` (the row is drawn and the view shows sizes). */
export function useDimensions(cache: DimensionCache, subject: DimensionSubject, options: { readonly wanted: boolean }): DimensionState {
  const { rel, size, modifiedMs } = subject;
  useEffect(() => {
    if (options.wanted) {
      cache.request(modifiedMs === undefined ? { rel, size } : { rel, size, modifiedMs });
    }
  }, [cache, rel, size, modifiedMs, options.wanted]);
  const state = useSyncExternalStore(cache.subscribe, () => cache.get(subject) ?? PENDING);
  return state;
}
