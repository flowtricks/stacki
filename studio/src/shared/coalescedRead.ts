import { assert } from '../../vendor/stacki/shared/core/assert';

// Share overlapping reads without retaining a cache after they finish. A change
// during a read queues one fresh read; new consumers cannot join the old revision.
export class CoalescedRead<T> {
  private revision = 0;
  private active: { readonly revision: number; readonly promise: Promise<T> } | undefined;
  private queued: Promise<T> | undefined;
  constructor(private readonly readValue: () => Promise<T>) {}

  invalidate = (): void => {
    assert(this.revision < Number.MAX_SAFE_INTEGER, 'Read revision stays within safe integers');
    this.revision++;
  };

  read = (): Promise<T> => {
    if (this.queued) {
      return this.queued;
    }
    if (!this.active) {
      return this.start();
    }
    if (this.active.revision === this.revision) {
      return this.active.promise;
    }
    const next = () => {
      this.queued = undefined;
      return this.start();
    };
    this.queued = this.active.promise.then(next, next);
    return this.queued;
  };

  private start(): Promise<T> {
    assert(this.active === undefined, 'Only one catalog read runs at a time');
    assert(this.queued === undefined, 'A queued catalog read takes ownership before starting');
    // Start in a microtask so synchronous failures use the same cleanup path.
    const job = { revision: this.revision, promise: Promise.resolve().then(this.readValue) };
    this.active = job;
    const release = () => {
      assert(this.active === job, 'Only the active catalog read can release its slot');
      this.active = undefined;
    };
    void job.promise.then(release, release);
    return job.promise;
  }
}
