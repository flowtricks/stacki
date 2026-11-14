// Which variables the suggestion dropdowns leave out, as the rest of the renderer sees it: one store per project,
// backed by `.stacki/variables.json` (shared/properties/variableVisibility.ts says what the file holds).
//
// Why a store and not component state: the Variables panel toggles a name and the style panel's variable picker must
// drop it in the same frame, from a different part of the tree, with no await. The store keeps the last state read or
// saved per project, so a reader gets the set synchronously (`HiddenVariablesStore.getState`) and subscribes for changes
// (`useHiddenVariables`).
//
// Writes are serialized (one chain per project) and each re-derives the new list from the latest state when it runs,
// so two quick toggles cannot lose one another. The file is witnessed (the metadata transport refuses a write whose base
// is no longer on disk): on that refusal the store reads the file again and applies the same change to it once, so a
// `git pull` between two toggles does not lose either. A file that cannot be read or parsed is never written over: the
// state is `blocked`, suggestions show every variable, and a toggle answers an error value instead of touching the file.
// The file is created by the first hide, never before.
import { assert } from '../../../shared/core/assert';
import { err, ok, type AppError, type Result } from '../../../shared/core/result';
import {
  EMPTY_VARIABLE_VISIBILITY,
  hiddenNameSet,
  parseVariableVisibilitySource,
  serializeVariableVisibility,
  withHidden,
  withShown,
  type VariableVisibility,
} from '../../../shared/properties/variableVisibility';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import { onWindowReturn } from '../../lib/windowReturn';

export type HiddenVariablesState =
  /** Nothing read yet: every variable is suggested until the file answers (a few milliseconds). */
  | { readonly kind: 'loading'; readonly hidden: ReadonlySet<string> }
  | { readonly kind: 'ready'; readonly hidden: ReadonlySet<string>; readonly value: VariableVisibility; readonly source: string | undefined }
  /** The file could not be read or is not valid: reads as nothing hidden, and is never written over. */
  | { readonly kind: 'blocked'; readonly hidden: ReadonlySet<string>; readonly message: string };

/** The project file transport. Both calls throw an Error when the file cannot be read or written. */
export interface VisibilityStorage {
  readonly read: () => Promise<{ readonly source?: string }>;
  readonly write: (write: { readonly source: string; readonly base?: string }) => Promise<{ readonly source?: string }>;
}

/** Projects whose state is kept; the least recently opened one that nothing shows is dropped past this. */
const STORES_MAX = 8;

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();
const LOADING: HiddenVariablesState = { kind: 'loading', hidden: NOTHING_HIDDEN };

export function projectStorage(projectPath: string): VisibilityStorage {
  assert(projectPath.length > 0, 'projectStorage: a project is open');
  return {
    read: () => readMetadata(projectPath, 'variables'),
    write: ({ source, base }) => writeMetadata(projectPath, { kind: 'variables', source, ...(base === undefined ? {} : { base }) }),
  };
}

export class HiddenVariablesStore {
  private current: HiddenVariablesState = LOADING;
  private readonly listeners = new Set<() => void>();
  // Reads and writes run one after another, so a write never starts from a state an earlier one is about to replace.
  private chain: Promise<unknown> = Promise.resolve();
  private retainers = 0;
  private stopWatching: (() => void) | undefined;
  private started = false;

  constructor(private readonly storage: VisibilityStorage) {}

  /** The latest state; the same object until something changes, as `useSyncExternalStore` requires. */
  getState = (): HiddenVariablesState => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** True while something that draws the state is mounted. */
  isRetained(): boolean {
    return this.retainers > 0;
  }

  /** Starts reading the file and follows it while held: the file is read again when the window returns. Release when done. */
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
        assert(this.retainers >= 0, 'HiddenVariablesStore: more releases than retains');
        if (this.retainers === 0) {
          this.stopWatching?.();
          this.stopWatching = undefined;
        }
      }
    };
  }

  /** Reads the file and publishes it. Safe to call often: an unchanged file publishes nothing. */
  load(): Promise<void> {
    this.started = true;
    return this.enqueue(() => this.refresh()).then(() => undefined);
  }

  /** True once a read was asked for, so a synchronous reader asks once. */
  hasStarted(): boolean {
    return this.started;
  }

  /** Leaves `name` out of suggestions. An error value (never a throw) when the file is blocked or the write fails. */
  hide(name: string): Promise<Result<void>> {
    return this.enqueue(() => this.change(name, { hide: true }));
  }

  /** Puts `name` back into suggestions. */
  show(name: string): Promise<Result<void>> {
    return this.enqueue(() => this.change(name, { hide: false }));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private publish(next: HiddenVariablesState): void {
    const before = this.current;
    const same =
      before.kind === next.kind &&
      (before.kind === 'ready' && next.kind === 'ready'
        ? before.source === next.source && before.value.hiddenFromSuggestions.join('\n') === next.value.hiddenFromSuggestions.join('\n')
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

  /** Reads the file into the state and answers what it found. */
  private async refresh(): Promise<Result<Extract<HiddenVariablesState, { kind: 'ready' }>, AppError>> {
    let source: string | undefined;
    try {
      source = (await this.storage.read()).source;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.publish({ kind: 'blocked', hidden: NOTHING_HIDDEN, message });
      return err({ code: 'variables-visibility-unreadable', message });
    }
    const parsed = parseVariableVisibilitySource(source);
    if (!parsed.ok) {
      this.publish({ kind: 'blocked', hidden: NOTHING_HIDDEN, message: parsed.error.message });
      return parsed;
    }
    const ready = { kind: 'ready', hidden: hiddenNameSet(parsed.value), value: parsed.value, source } as const;
    this.publish(ready);
    return ok(ready);
  }

  private async change(name: string, change: { readonly hide: boolean }): Promise<Result<void>> {
    assert(name.length > 0, 'HiddenVariablesStore.change: a name');
    // The first read has not landed, or the last one failed: read the file now, since writing needs its bytes as the base.
    let base = this.current.kind === 'ready' ? this.current : undefined;
    if (base === undefined) {
      const read = await this.refresh();
      if (!read.ok) {
        return read;
      }
      base = read.value;
    }
    const first = await this.write(base, name, change);
    if (first.ok || first.error.code !== 'variables-visibility-write') {
      return first;
    }
    // The file moved under us (another window, a pull): apply the same change to what is there now, once.
    const reread = await this.refresh();
    if (!reread.ok) {
      return reread;
    }
    return this.write(reread.value, name, change);
  }

  private async write(base: Extract<HiddenVariablesState, { kind: 'ready' }>, name: string, change: { readonly hide: boolean }): Promise<Result<void>> {
    const next = change.hide ? withHidden(base.value, name) : withShown(base.value, name);
    if (!next.ok) {
      return next;
    }
    if (base.source === undefined && next.value.hiddenFromSuggestions.length === 0) {
      // Showing a name in a project with no file: there is nothing to say, so no file is made.
      return ok(undefined);
    }
    if (next.value.hiddenFromSuggestions.join('\n') === base.value.hiddenFromSuggestions.join('\n') && base.source !== undefined) {
      return ok(undefined);
    }
    // Shown at once; the write confirms it or the next read puts the file's truth back.
    this.publish({ kind: 'ready', hidden: hiddenNameSet(next.value), value: next.value, source: base.source });
    const text = serializeVariableVisibility(next.value);
    try {
      const saved = await this.storage.write({ source: text, ...(base.source === undefined ? {} : { base: base.source }) });
      assert(saved.source === text, 'HiddenVariablesStore.write: the file holds what was written');
      this.publish({ kind: 'ready', hidden: hiddenNameSet(next.value), value: next.value, source: saved.source });
      return ok(undefined);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AssertionError') {
        throw error;
      }
      this.publish({ kind: 'ready', hidden: hiddenNameSet(base.value), value: base.value, source: base.source });
      return err({ code: 'variables-visibility-write', message: error instanceof Error ? error.message : String(error) });
    }
  }
}

const stores = new Map<string, HiddenVariablesStore>();

/** The project's store, made on first use. The storage argument is for tests; the app uses the project file. */
export function hiddenVariablesStore(projectPath: string, storage?: VisibilityStorage): HiddenVariablesStore {
  assert(projectPath.length > 0, 'hiddenVariablesStore: a project is open');
  const kept = stores.get(projectPath);
  if (kept !== undefined && storage === undefined) {
    // Most recently used goes last, so the eviction below drops the one used longest ago.
    stores.delete(projectPath);
    stores.set(projectPath, kept);
    return kept;
  }
  const made = new HiddenVariablesStore(storage ?? projectStorage(projectPath));
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

/**
 * The names hidden from suggestions in `projectPath`, right now: the cached set, no await. The first call for a project
 * starts reading its file, so a reader that is not a hook (an event handler) sees the real set from the next call on.
 * A project that is not open has nothing hidden.
 */
export function getHiddenVariables(projectPath: string | undefined): ReadonlySet<string> {
  if (projectPath === undefined || projectPath.length === 0) {
    return NOTHING_HIDDEN;
  }
  const store = hiddenVariablesStore(projectPath);
  if (!store.hasStarted()) {
    void store.load();
  }
  return store.getState().hidden;
}

/** Forgets every kept store. Tests only: the app keeps them for the session. */
export function forgetHiddenVariables(): void {
  stores.clear();
}

export { EMPTY_VARIABLE_VISIBILITY };
