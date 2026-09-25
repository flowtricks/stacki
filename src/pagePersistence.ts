// Serialize writes and drain edits made while a write is pending. A successful
// write acknowledges its exact state object, never a newer edit or another file.

import { LIMITS } from '../shared/limits';
import type { ScanResult } from '../shared/scan';

/** The page state as the saver needs it: a dirty flag on an object whose
 * identity is the ack token (the WeakSet tracks exact state objects). */
interface PageStateHandle {
  readonly dirty?: boolean;
}

interface CurrentSnapshot<State extends PageStateHandle> {
  readonly currentPage?: { readonly path?: string | undefined } | null;
  readonly pageState?: State | null;
}

interface PageSaverDeps<State extends PageStateHandle, Acknowledgement> {
  readonly readCurrent: () => CurrentSnapshot<State>;
  readonly write: (path: string, pageState: State) => Promise<Acknowledgement>;
  readonly markSaved: (
    pageState: State,
    acknowledgement: Acknowledgement | undefined,
  ) => void;
}

export function createPageSaver<State extends PageStateHandle, Acknowledgement>({
  readCurrent,
  write,
  markSaved,
}: PageSaverDeps<State, Acknowledgement>): () => Promise<void> {
  let pending: Promise<void> = Promise.resolve();
  const saved = new WeakMap<State, Acknowledgement>();
  const flush = async (): Promise<void> => {
    const path = readCurrent().currentPage?.path;
    if (!path) {
      return;
    }
    let drain = 0;
    while (true) {
      drain += 1;
      // Each pass past this point needs a strictly newer dirty state; hitting
      // the cap means edits arrive faster than writes can ever drain — a bug.
      if (drain > LIMITS.saveDrainMax) {
        throw new Error(`save drain exceeded ${LIMITS.saveDrainMax} passes for ${path}`);
      }
      const { currentPage, pageState } = readCurrent();
      if (currentPage?.path !== path || !pageState?.dirty) {
        return;
      }
      if (!saved.has(pageState)) {
        const acknowledgement = await write(path, pageState);
        saved.set(pageState, acknowledgement);
      }
      markSaved(pageState, saved.get(pageState));
      if (readCurrent().pageState === pageState) {
        return;
      }
    }
  };
  return () => {
    const result = pending.then(flush);
    // A failed save is reported to its caller and leaves future saves usable.
    pending = result.catch(() => {});
    return result;
  };
}

export function scanContainsFile(scan: ScanResult | null | undefined, path: string): boolean {
  return (['pages', 'components', 'layouts'] as const).some((kind) =>
    scan?.[kind]?.some((entry) => entry.path === path),
  );
}

// Each code window destination owns its debounce. Typing in a second file must
// never cancel the first file's pending write. Writes to one file stay ordered.

type WriteFn = () => unknown;

interface WaitingEntry {
  readonly write: WriteFn;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

interface FileSaverDeps {
  readonly delay?: number;
  readonly onError?: (error: unknown) => void;
}

export function createFileSaver({ delay = 300, onError = () => {} }: FileSaverDeps = {}): {
  schedule(key: string, write: WriteFn): void;
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
    if (entry.timer !== null) {
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
            waiting.set(key, { write: entry.write, timer: null });
          }
        }
        onError(error);
      },
    );
    return result;
  };
  return {
    schedule(key: string, write: WriteFn): void {
      const pending = waiting.get(key);
      if (pending?.timer != null) {
        clearTimeout(pending.timer);
      }
      waiting.set(key, {
        write,
        timer: setTimeout(() => {
          void start(key).catch(() => {});
        }, delay),
      });
    },
    async flush(): Promise<void> {
      let drain = 0;
      do {
        drain += 1;
        // Same convergence argument as createPageSaver's flush.
        if (drain > LIMITS.saveDrainMax) {
          throw new Error(`file-saver flush exceeded ${LIMITS.saveDrainMax} passes`);
        }
        for (const key of waiting.keys()) {
          start(key);
        }
        await Promise.all(running.values());
      } while (waiting.size);
    },
  };
}
