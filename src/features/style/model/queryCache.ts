import { assert } from '../../../../shared/core/assert';

/** What the page said about one key: its value, or undefined when it could not answer. */
export type Answer = string | undefined;

/** A read of one key: still being asked, or settled on the page's answer. */
export type CachedAnswer = { readonly kind: 'pending' } | { readonly kind: 'settled'; readonly answer: Answer };

// The page's reply for a batch of keys. Values stay `unknown` here because the bridge
// reports a missing value as `null`; each one is narrowed to a string or "no answer".
type Query = (path: string, keys: string[]) => Promise<Readonly<Record<string, unknown>> | undefined>;
type Batches = Map<string, Map<string, Entry>>;

const PENDING: CachedAnswer = { kind: 'pending' };

// One key's answer: pending until settled, exactly once, by a reply or an invalidation.
class Entry {
  readonly promise: Promise<Answer>;
  readonly #resolve: (value: Answer) => void;
  #state: CachedAnswer = PENDING;

  constructor() {
    // The executor runs synchronously inside the constructor, so the settle
    // function exists on return.
    const settle: { resolve?: (value: Answer) => void } = {};
    this.promise = new Promise<Answer>((done) => {
      settle.resolve = done;
    });
    assert(settle.resolve !== undefined, 'A promise executor runs synchronously');
    this.#resolve = settle.resolve;
  }

  get state(): CachedAnswer {
    return this.#state;
  }

  settle(answer: Answer): void {
    assert(this.#state.kind === 'pending', 'An entry settles once');
    this.#state = { kind: 'settled', answer };
    this.#resolve(answer);
  }
}

// Settle every still-pending entry as "no answer": invalidation must not leave a
// caller waiting on a reply that will be discarded.
function settleOutstanding(entries: Batches): void {
  for (const values of entries.values()) {
    for (const entry of values.values()) {
      if (entry.state.kind === 'pending') {
        entry.settle(undefined);
      }
    }
  }
}

function queueKey(queued: Map<string, Set<string>>, path: string, key: string): void {
  const keys = queued.get(path);
  if (keys) {
    keys.add(key);
  } else {
    queued.set(path, new Set([key]));
  }
}

function answerOf(reply: Readonly<Record<string, unknown>> | undefined, key: string): Answer {
  const value = reply?.[key];
  return typeof value === 'string' ? value : undefined;
}

// Run one path's batch. A reply from before an invalidation (the cache's `entries`
// map was replaced) is dropped: `isCurrent` compares against the generation it ran in.
function runBatch(
  query: Query,
  path: string,
  keys: ReadonlySet<string>,
  generation: Batches,
  isCurrent: (generation: Batches) => boolean,
  notify: () => void,
): void {
  // Promise.resolve also contains a bridge that throws before returning.
  void Promise.resolve()
    .then(() => query(path, [...keys]))
    .catch(() => undefined)
    .then((reply) => {
      if (!isCurrent(generation)) {
        return;
      }
      // Same generation, so every queued key still has the entry `request` made for it.
      const values = generation.get(path);
      assert(values !== undefined, `Queued path ${path} has entries`);
      for (const key of keys) {
        const entry = values.get(key);
        assert(entry !== undefined, `Queued key ${key} has an entry`);
        entry.settle(answerOf(reply, key));
      }
      notify();
    });
}

/** Batch a render's requests by element, deduplicate outstanding work, and discard
 * replies from before an invalidation. A settled answer of undefined means the page
 * could not answer, so consumers can settle on their fallback. */
export function createQueryCache(query: Query) {
  let entries: Batches = new Map();
  let queued = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scope: readonly unknown[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const isCurrent = (generation: Batches) => generation === entries;

  // Drop every answer and cancel the batch that has not started, without telling anyone.
  function reset() {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = undefined;
    settleOutstanding(entries);
    entries = new Map();
    queued = new Map();
  }

  function flush() {
    const batch = queued;
    queued = new Map();
    timer = undefined;
    for (const [path, keys] of batch) {
      runBatch(query, path, keys, entries, isCurrent, notify);
    }
  }

  function request(path: string, key: string): Promise<Answer> {
    let values = entries.get(path);
    if (!values) {
      entries.set(path, (values = new Map<string, Entry>()));
    }
    const existing = values.get(key);
    if (existing) {
      return existing.promise;
    }
    const entry = new Entry();
    values.set(key, entry);
    queueKey(queued, path, key);
    if (timer === undefined) {
      timer = setTimeout(flush, 0);
    }
    return entry.promise;
  }

  return {
    clear() {
      reset();
      notify();
    },
    // Called during render as well as effects: paths are reused by different
    // documents. Never show a cached value from the previously open file.
    setScope(next: readonly unknown[]) {
      if (scope.length === next.length && scope.every((value, i) => value === next[i])) {
        return;
      }
      scope = next;
      reset();
    },
    read(path: string, key: string): CachedAnswer {
      return entries.get(path)?.get(key)?.state ?? PENDING;
    },
    request,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
