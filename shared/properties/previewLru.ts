// A cache with a byte budget, least recently used out first. Snapshots are text of very different sizes, so
// the bound is the total bytes held and not the count. The same eviction rule serves the in-memory copy and
// the copy kept on disk (the app's own cache folder, never the project), which hold entries as plain lists.

import { assert } from '../core/assert';

/** What the cache may hold. The disk budget is larger: it survives a restart, memory only lasts a session. */
export const PREVIEW_CACHE_BUDGETS = {
  memoryBytes: 24 * 1024 * 1024,
  diskBytes: 96 * 1024 * 1024,
} as const;

export interface CacheEntryInfo {
  readonly id: string;
  readonly bytes: number;
  /** Milliseconds since the epoch of its last use. */
  readonly usedAtMs: number;
}

/**
 * The ids to drop so the rest fit in `budgetBytes`, oldest use first. An entry bigger than the whole
 * budget is dropped whatever its age (it could never be kept). Ties go to the id, so the answer is stable.
 */
export function evictionOrder(entries: readonly CacheEntryInfo[], budgetBytes: number): readonly string[] {
  assert(budgetBytes >= 0, 'A cache budget is not negative');
  const dropped: string[] = [];
  const kept = entries.filter((entry) => {
    if (entry.bytes > budgetBytes) {
      dropped.push(entry.id);
      return false;
    }
    return true;
  });
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
  const oldestFirst = [...kept].sort((left, right) => left.usedAtMs - right.usedAtMs || (left.id < right.id ? -1 : 1));
  for (const entry of oldestFirst) {
    if (total <= budgetBytes) {
      break;
    }
    dropped.push(entry.id);
    total -= entry.bytes;
  }
  assert(total <= budgetBytes, 'Eviction leaves the cache within its budget');
  return dropped;
}

/** An in-memory cache within a byte budget; reading an entry makes it the most recent. */
export class ByteLru<V> {
  private readonly entries = new Map<string, { readonly value: V; readonly bytes: number }>();
  private totalBytes = 0;

  constructor(private readonly budgetBytes: number) {
    assert(budgetBytes > 0, 'A cache budget is positive');
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  get(id: string): V | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  /** Reads without making the entry recent, for a check that should not keep a tile alive. */
  peek(id: string): V | undefined {
    return this.entries.get(id)?.value;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Stores an entry and evicts the oldest to fit; false (and nothing stored) when it alone exceeds the budget. */
  set(id: string, value: V, bytes: number): boolean {
    assert(bytes >= 0, 'An entry has a size');
    this.delete(id);
    if (bytes > this.budgetBytes) {
      return false;
    }
    this.entries.set(id, { value, bytes });
    this.totalBytes += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.totalBytes <= this.budgetBytes) {
        break;
      }
      this.entries.delete(oldest);
      this.totalBytes -= entry.bytes;
    }
    assert(this.totalBytes <= this.budgetBytes, 'The cache stays within its budget');
    assert(this.entries.has(id), 'The entry just stored is the most recent and survives');
    return true;
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      this.entries.delete(id);
      this.totalBytes -= entry.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  keys(): readonly string[] {
    return [...this.entries.keys()];
  }
}
