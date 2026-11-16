// What inserting a component reads before it can place it: the project's component defaults and
// the import path of each component in it. They are read while the palette is still open on that
// component, so choosing it finds the answers ready. The read is the same call the insert would
// make; only its start moves earlier. Only the answers are kept, never the node built from them:
// each insert makes its own node and ids.
//
// Bounded and short-lived: few reads are kept and each expires, and anything that changes the
// defaults (a metadata write) forgets them all, so a kept read is never older than the person's
// last edit to the settings it read.

export const WARM_READ_LIMITS = {
  /** Reads kept at once per kind: the palette's highlight moves one component at a time. */
  entriesMax: 32,
  /** How long a read is trusted after it started. */
  ageMsMax: 10_000,
} as const satisfies Record<string, number>;

interface Entry<Value> {
  readonly startedMs: number;
  readonly promise: Promise<Value>;
}

export class WarmReads<Value> {
  private readonly kept = new Map<string, Entry<Value>>();

  /** The kept read for `key` when fresh, else a new one, which is then kept for the next ask. */
  read(key: string, nowMs: number, start: () => Promise<Value>): Promise<Value> {
    const found = this.kept.get(key);
    if (found !== undefined && nowMs - found.startedMs <= WARM_READ_LIMITS.ageMsMax) {
      return found.promise;
    }
    this.kept.delete(key);
    const promise = start();
    // A read that fails is not kept: the insert asks again and reports the failure itself.
    promise.catch(() => {
      if (this.kept.get(key)?.promise === promise) {
        this.kept.delete(key);
      }
    });
    this.kept.set(key, { startedMs: nowMs, promise });
    for (const oldest of this.kept.keys()) {
      if (this.kept.size <= WARM_READ_LIMITS.entriesMax) {
        break;
      }
      this.kept.delete(oldest);
    }
    return promise;
  }

  forget(): void {
    this.kept.clear();
  }
}
