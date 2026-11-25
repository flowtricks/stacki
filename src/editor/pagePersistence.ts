// The page saver (plan §7, §11.9): the open page's queue (src/editor/pageEdits.ts)
// sent to its actor, one entry at a time, in order. The queue is the only
// record of what is unsaved — nothing tracks which state object was written —
// and one flush sends the entries it finds when it starts: an edit made while
// it runs is queued behind them and has its own save scheduled, so there is no
// drain loop to bound. Flushes run one at a time (src/lib/coalescedRun.ts), and a
// caller is answered by a flush that began after it asked: everything queued
// before the call has been sent, or a refusal is holding it back.
//
// Every write names the checksum it was authored against, and a refusal (the
// file changed on disk) stops autosave instead of retrying (plan §7).
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ScanResult } from '../../shared/properties/projectScan';
import { createCoalescedRun } from '../lib/coalescedRun';
import type { EditDrafts, QueueEntry } from './pageEdits';

/** How sending one entry ended. The sender has already shown the outcome on
 * the page (its reply installed, its conflict notice raised). */
export type EntrySent =
  | { readonly tag: 'sent' }
  /** Refused, or written in part: the page is conflicted, and the entry
   * stays queued until the user decides (reload or review). */
  | { readonly tag: 'conflicted' }
  /** Not written now: the entry stays queued for the next save. */
  | { readonly tag: 'failed'; readonly error: Error };

/** Where a flush left the page: its edits are on disk (or there were none), or
 * a refused save is holding them back until the user decides (plan §7). */
export type FlushOutcome = 'settled' | 'conflicted';

export interface PageSaverDeps {
  readonly queue: EditDrafts;
  /** The open file's path, when one is open. */
  readonly currentPath: () => string | undefined;
  /** Whether the open page is conflicted: autosave stays off (plan §7). */
  readonly conflicted: () => boolean;
  readonly send: (path: string, entry: QueueEntry) => Promise<EntrySent>;
}

export interface PageSaver {
  readonly flush: () => Promise<FlushOutcome>;
  /** True while an entry is on its way to disk; its outcome is authoritative. */
  readonly writing: () => boolean;
}

type SaverPhase = { readonly tag: 'idle' } | { readonly tag: 'writing'; readonly path: string };

export function createPageSaver(deps: PageSaverDeps): PageSaver {
  // The saver's one piece of state, owned here.
  let phase: SaverPhase = { tag: 'idle' };
  const flushOnce = async (): Promise<FlushOutcome> => {
    const path = deps.currentPath();
    if (path === undefined) {
      return 'settled';
    }
    if (deps.conflicted()) {
      return 'conflicted';
    }
    // The entries found now, and no more: gestures stay inside the queue's
    // bound, plus one code or model entry.
    const count = deps.queue.entries(path).length;
    assert(count <= LIMITS.intentsPendingMax + 1, 'The queue stays inside its bound');
    for (let sent = 0; sent < count; sent++) {
      const entry = deps.queue.shift(path);
      if (entry === undefined) {
        return 'settled'; // A reload discarded the rest.
      }
      phase = { tag: 'writing', path };
      let outcome: EntrySent;
      try {
        outcome = await deps.send(path, entry);
      } catch (error: unknown) {
        // A transport that throws instead of answering: nothing is known to
        // have been written, and the entry is never lost.
        deps.queue.unshift(path, entry);
        throw error;
      } finally {
        phase = { tag: 'idle' };
      }
      switch (outcome.tag) {
        case 'sent':
          continue;
        case 'conflicted':
          deps.queue.unshift(path, entry);
          return 'conflicted';
        case 'failed':
          deps.queue.unshift(path, entry);
          throw outcome.error;
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    }
    return 'settled';
  };
  const runs = createCoalescedRun(flushOnce);
  return {
    flush: () => runs.request(),
    writing: () => phase.tag === 'writing',
  };
}

export function scanContainsFile(scan: ScanResult | undefined, path: string): boolean {
  if (/\/\.stacki\/canvas\/[a-f0-9-]{36}\.astro$/.test(path.replaceAll('\\', '/'))) {
    return true;
  }
  return (['pages', 'components', 'layouts'] as const).some((kind) => scan?.[kind]?.some((entry) => entry.path === path));
}

// Each code window destination owns its debounce. Typing in a second file must
// never cancel the first file's pending write. Writes to one file stay ordered.

type FileWrite = () => unknown;

interface WaitingEntry {
  readonly write: FileWrite;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

interface FileSaverDeps {
  readonly delay?: number;
  readonly onError?: (error: unknown) => void;
}

export function createFileSaver({ delay = 300, onError = () => {} }: FileSaverDeps = {}): {
  schedule(key: string, write: FileWrite): void;
  flush(): Promise<void>;
} {
  const waiting = new Map<string, WaitingEntry>();
  const running = new Map<string, Promise<unknown>>();
  const start = (key: string): Promise<unknown> => {
    const entry = waiting.get(key);
    if (!entry) {
      return running.get(key) || Promise.resolve();
    }
    waiting.delete(key);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    const result: Promise<unknown> = (running.get(key) || Promise.resolve()).catch(() => {}).then(() => entry.write());
    running.set(key, result);
    result.then(
      () => {
        if (running.get(key) === result) {
          running.delete(key);
        }
      },
      (error: unknown) => {
        if (running.get(key) === result) {
          running.delete(key);
          if (!waiting.has(key)) {
            waiting.set(key, { write: entry.write, timer: undefined });
          }
        }
        onError(error);
      },
    );
    return result;
  };
  return {
    schedule(key: string, write: FileWrite): void {
      const pending = waiting.get(key);
      if (pending?.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      waiting.set(key, {
        write,
        timer: setTimeout(() => {
          void start(key).catch(() => {});
        }, delay),
      });
    },
    // Every write waiting now starts, and the flush answers once each file's
    // writes have run: a write scheduled meanwhile has its own timer, and a
    // failed one waits for the next flush — no loop until quiet.
    async flush(): Promise<void> {
      for (const key of [...waiting.keys()]) {
        void start(key);
      }
      await Promise.all(running.values());
    },
  };
}
