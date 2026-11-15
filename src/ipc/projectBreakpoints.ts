// The project's preview breakpoints, as the renderer sees them: one store per project, backed by `.stacki/breakpoints.json`
// (shared/properties/projectBreakpoints.ts says what the file holds).
//
// Why a store: the preview bar, the canvas sizing, the all-breakpoints view and the Settings editor all read the same three
// widths from different parts of the tree, and an edit in Settings must move the bar in the same frame. The store keeps the
// last state read or saved, so a reader gets widths synchronously and subscribes for changes (`useProjectBreakpoints`).
//
// Reading never writes. A project without the file, or while it is first read, shows the Lumos defaults. A file that cannot
// be read or parsed is `blocked`: the defaults are shown with the reason, and a save answers an error value instead of
// touching the file, so a hand-edited file is never overwritten silently. Writes are serialized per project and witnessed by
// the metadata transport (it refuses a write whose base is no longer on disk); on that refusal the store reads again and
// applies the same edit once. A save whose bytes equal the file's, or that would create a file holding only the defaults,
// writes nothing.
import { assert } from '../../shared/core/assert';
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import {
  BREAKPOINT_DEFAULT_LIST,
  breakpointsEqual,
  checkedList,
  parseBreakpointsSource,
  resolveBreakpoints,
  serializeBreakpoints,
  type BreakpointList,
  type ResolvedBreakpoint,
} from '../../shared/properties/projectBreakpoints';
import { readMetadata, writeMetadata } from './projectMetadataBridge';
import { onWindowReturn } from '../lib/windowReturn';

export type BreakpointsState =
  /** Nothing read yet: the defaults show until the file answers (a few milliseconds). */
  | { readonly kind: 'loading'; readonly list: BreakpointList; readonly resolved: readonly ResolvedBreakpoint[] }
  | {
      readonly kind: 'ready';
      readonly list: BreakpointList;
      readonly resolved: readonly ResolvedBreakpoint[];
      readonly source: string | undefined;
    }
  /** The file could not be read or is not valid: the defaults show, and the file is never written over. */
  | {
      readonly kind: 'blocked';
      readonly list: BreakpointList;
      readonly resolved: readonly ResolvedBreakpoint[];
      readonly message: string;
    };

/** The project file transport. Both calls throw an Error when the file cannot be read or written. */
export interface BreakpointsStorage {
  readonly read: () => Promise<{ readonly source?: string }>;
  readonly write: (write: { readonly source: string; readonly base?: string }) => Promise<{ readonly source?: string }>;
}

/** Projects whose state is kept; the least recently opened one that nothing shows is dropped past this. */
const STORES_MAX = 8;

// `widths` always comes from `resolveBreakpointWidths`: the one place settings become canvas widths.
const DEFAULT_RESOLVED = resolveBreakpoints(BREAKPOINT_DEFAULT_LIST);
const LOADING: BreakpointsState = { kind: 'loading', list: BREAKPOINT_DEFAULT_LIST, resolved: DEFAULT_RESOLVED };

export function projectBreakpointsStorage(projectPath: string): BreakpointsStorage {
  assert(projectPath.length > 0, 'projectBreakpointsStorage: a project is open');
  return {
    read: () => readMetadata(projectPath, 'breakpoints'),
    write: ({ source, base }) => writeMetadata(projectPath, { kind: 'breakpoints', source, ...(base === undefined ? {} : { base }) }),
  };
}

export class BreakpointsStore {
  private current: BreakpointsState = LOADING;
  private readonly listeners = new Set<() => void>();
  // Reads and writes run one after another, so a write never starts from a state an earlier one is about to replace.
  private chain: Promise<unknown> = Promise.resolve();
  private retainers = 0;
  private stopWatching: (() => void) | undefined;

  constructor(private readonly storage: BreakpointsStorage) {}

  /** The latest state; the same object until something changes, as `useSyncExternalStore` requires. */
  getState = (): BreakpointsState => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  isRetained(): boolean {
    return this.retainers > 0;
  }

  /** Reads the file now and again when the window returns, while held. Release when done. */
  retain(): () => void {
    this.retainers += 1;
    if (this.retainers === 1) {
      this.stopWatching = onWindowReturn(() => void this.load());
    }
    void this.load();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.retainers -= 1;
        assert(this.retainers >= 0, 'BreakpointsStore: more releases than retains');
        if (this.retainers === 0) {
          this.stopWatching?.();
          this.stopWatching = undefined;
        }
      }
    };
  }

  /** Reads the file and publishes it. Safe to call often: an unchanged file publishes nothing. */
  load(): Promise<void> {
    return this.enqueue(() => this.refresh()).then(() => undefined);
  }

  /** Saves the three breakpoints. An error value (never a throw) when the set is invalid, the file is blocked, or the write fails. */
  save(list: BreakpointList): Promise<Result<void>> {
    return this.enqueue(() => this.change(list));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private publish(next: BreakpointsState): void {
    const before = this.current;
    const same =
      before.kind === next.kind &&
      breakpointsEqual(before.list, next.list) &&
      (before.kind === 'ready' && next.kind === 'ready'
        ? before.source === next.source
        : before.kind === 'blocked' && next.kind === 'blocked'
          ? before.message === next.message
          : true);
    if (!same) {
      this.current = next;
      for (const listener of [...this.listeners]) {
        listener();
      }
    }
  }

  private async refresh(): Promise<Result<Extract<BreakpointsState, { kind: 'ready' }>, AppError>> {
    let source: string | undefined;
    try {
      source = (await this.storage.read()).source;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ kind: 'blocked', list: BREAKPOINT_DEFAULT_LIST, resolved: DEFAULT_RESOLVED, message });
      return err({ code: 'breakpoints-unreadable', message });
    }
    const parsed = parseBreakpointsSource(source);
    if (!parsed.ok) {
      this.publish({ kind: 'blocked', list: BREAKPOINT_DEFAULT_LIST, resolved: DEFAULT_RESOLVED, message: parsed.error.message });
      return parsed;
    }
    const ready = { kind: 'ready', list: parsed.value, resolved: resolveBreakpoints(parsed.value), source } as const;
    this.publish(ready);
    return ok(ready);
  }

  private async change(list: BreakpointList): Promise<Result<void>> {
    const checked = checkedList(list);
    if (!checked.ok) {
      return checked;
    }
    // The first read has not landed, or the last one failed: read the file now, since writing needs its bytes as the base.
    let base = this.current.kind === 'ready' ? this.current : undefined;
    if (base === undefined) {
      const read = await this.refresh();
      if (!read.ok) {
        return read;
      }
      base = read.value;
    }
    const first = await this.write(base, checked.value);
    if (first.ok || first.error.code !== 'breakpoints-write') {
      return first;
    }
    // The file moved under us (another window, a pull): apply the same edit to what is there now, once.
    const reread = await this.refresh();
    if (!reread.ok) {
      return reread;
    }
    return this.write(reread.value, checked.value);
  }

  private async write(base: Extract<BreakpointsState, { kind: 'ready' }>, list: BreakpointList): Promise<Result<void>> {
    const text = serializeBreakpoints(list);
    if (base.source === undefined) {
      if (breakpointsEqual(list, BREAKPOINT_DEFAULT_LIST)) {
        // No file and nothing to say: the defaults are already what every reader sees, so no file is made.
        return ok(undefined);
      }
    } else if (base.source === text) {
      return ok(undefined);
    }
    // Shown at once; the write confirms it or the next read puts the file's truth back.
    this.publish({ kind: 'ready', list, resolved: resolveBreakpoints(list), source: base.source });
    try {
      const saved = await this.storage.write({ source: text, ...(base.source === undefined ? {} : { base: base.source }) });
      assert(saved.source === text, 'BreakpointsStore.write: the file holds what was written');
      this.publish({ kind: 'ready', list, resolved: resolveBreakpoints(list), source: saved.source });
      return ok(undefined);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AssertionError') {
        throw error;
      }
      this.publish({ kind: 'ready', list: base.list, resolved: base.resolved, source: base.source });
      return err({ code: 'breakpoints-write', message: error instanceof Error ? error.message : String(error) });
    }
  }
}

const stores = new Map<string, BreakpointsStore>();

/** The project's store, made on first use. The storage argument is for tests; the app uses the project file. */
export function breakpointsStore(projectPath: string, storage?: BreakpointsStorage): BreakpointsStore {
  assert(projectPath.length > 0, 'breakpointsStore: a project is open');
  const kept = stores.get(projectPath);
  if (kept !== undefined && storage === undefined) {
    // Most recently used goes last, so the eviction below drops the one used longest ago.
    stores.delete(projectPath);
    stores.set(projectPath, kept);
    return kept;
  }
  const made = new BreakpointsStore(storage ?? projectBreakpointsStorage(projectPath));
  stores.set(projectPath, made);
  for (const [key, store] of stores) {
    if (stores.size <= STORES_MAX) {
      break;
    }
    if (key !== projectPath && !store.isRetained()) {
      stores.delete(key);
    }
  }
  return made;
}

/** Forgets every kept store. Tests only: the app keeps them for the session. */
export function forgetBreakpointStores(): void {
  stores.clear();
}
