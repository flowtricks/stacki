import { assert } from '../../../shared/core/assert';
import { ByteLru, PREVIEW_CACHE_BUDGETS } from '../../../shared/properties/previewLru';
import {
  cancelAll,
  EMPTY_PREVIEW_QUEUE,
  enqueue,
  finish,
  PREVIEW_QUEUE_LIMITS,
  reprioritize,
  startNext,
  type PreviewPriority,
  type PreviewQueue,
} from '../../../shared/properties/previewQueue';
import { PREVIEW_SNAPSHOT_LIMITS, type PreviewSnapshotMessage } from '../../../shared/properties/previewSnapshot';
import { nextTileState, readPageReason, TILE_IDLE, type TileEvent, type TileState, type TileUnavailable } from '../../../shared/properties/previewTile';
import { NO_PERSISTENCE, type HeldSnapshot, type SnapshotPersistence } from './snapshotPersistence';

// The palette's component pictures, rendered once and kept. A tile asks the store for its snapshot; the store
// answers from memory, then from the app's cache on disk, and renders (through the dev server's preview
// route, a few at a time, visible tiles first) only what it does not have or has not checked lately. A tile's
// state lives here and not in the tile, so scrolling a tile away and back, or closing and reopening the
// palette, finds the same picture waiting: nothing mounts, loads or flickers.

/** The token the preview page writes in place of the dev server's origin (its port changes between runs). */
export const ORIGIN_TOKEN = '__AVB_ORIGIN__';

/** How long a checked snapshot is trusted before the next palette open asks the route again. */
export const REVALIDATE_AFTER_MS = 60_000;

/** How long one render may take before the tile is given up on with a reason. */
export const RENDER_TIMEOUT_MS = 20_000;

export interface TileSource {
  /** Stable name of the tile within the project: the component's file. */
  readonly id: string;
  /** The component's display name. */
  readonly name: string;
  /** The preview route's address for this component with `layout=snapshot`, before any session resolves it. */
  readonly url: string;
}

export type ProduceOutcome =
  | { readonly kind: 'snapshot'; readonly message: PreviewSnapshotMessage }
  | { readonly kind: 'unchanged'; readonly key: string }
  | { readonly kind: 'empty'; readonly reason: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unresolved' };

/** Renders one tile. `knownKey` is the key already held: the route answers `unchanged` without drawing when it still matches. */
export type Producer = (source: TileSource, knownKey: string | undefined) => Promise<ProduceOutcome>;

export interface TileRequest {
  readonly source: TileSource;
  readonly priority: PreviewPriority;
  /** The tile's position in the grid; ties in priority render top to bottom. */
  readonly order: number;
}

export interface StoreOptions {
  readonly persistence?: SnapshotPersistence;
  readonly now?: () => number;
  readonly concurrency?: number;
}

export class PreviewSnapshotStore {
  private readonly states = new Map<string, TileState>();
  private readonly held = new ByteLru<HeldSnapshot>(PREVIEW_CACHE_BUDGETS.memoryBytes);
  private readonly sources = new Map<string, TileSource>();
  private readonly listeners = new Set<() => void>();
  private readonly checkedAtMs = new Map<string, number>();
  private readonly reading = new Set<string>();
  // Tiles a person asked to try again: their next render skips the project's own instance and uses sample data.
  private readonly sampleOnly = new Set<string>();
  private queue: PreviewQueue = EMPTY_PREVIEW_QUEUE;
  private version = 0;
  private closed = false;
  private readonly persistence: SnapshotPersistence;
  private readonly now: () => number;
  private readonly concurrency: number;

  constructor(
    private readonly projectKey: string,
    private readonly produce: Producer,
    options: StoreOptions = {},
  ) {
    this.persistence = options.persistence ?? NO_PERSISTENCE;
    this.now = options.now ?? Date.now;
    this.concurrency = options.concurrency ?? PREVIEW_QUEUE_LIMITS.concurrencyMax;
    assert(this.concurrency >= 1, 'The store renders at least one at a time');
    assert(this.concurrency <= PREVIEW_QUEUE_LIMITS.concurrencyMax, 'The store renders within the queue bound');
  }

  /** A number that changes whenever any tile does; what a subscriber compares. */
  snapshotVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  tile(id: string): TileState {
    return this.states.get(id) ?? TILE_IDLE;
  }

  snapshot(id: string): HeldSnapshot | undefined {
    return this.held.peek(id);
  }

  /** Marks tiles as wanted, in the order and priority given; a tile with a picture is checked, never blanked. */
  request(requests: readonly TileRequest[]): void {
    if (this.closed) {
      return;
    }
    for (const { source, priority, order } of requests) {
      this.sources.set(source.id, source);
      const state = this.tile(source.id);
      if (state.kind === 'unavailable') {
        continue;
      }
      if (state.kind === 'idle' || (state.kind === 'ready' && this.held.peek(source.id) === undefined)) {
        // Idle: a stored picture may exist. Ready without its picture in memory: it was evicted, bring it back.
        this.load(source.id);
      }
      if (this.needsRender(source.id)) {
        const before = this.queue;
        this.queue = enqueue(this.queue, { id: source.id, priority, order });
        if (this.queue !== before && this.tile(source.id).kind === 'idle') {
          this.dispatch(source.id, { kind: 'enqueue' });
        }
      }
    }
    this.pump();
  }

  /** The tiles on screen changed: re-rank what waits so the visible ones render first. */
  prioritize(priorities: ReadonlyMap<string, PreviewPriority>): void {
    this.queue = reprioritize(this.queue, priorities);
  }

  /** A person asked again for a tile that failed. */
  retry(id: string): void {
    const state = this.tile(id);
    const source = this.sources.get(id);
    if (state.kind !== 'unavailable' || source === undefined) {
      return;
    }
    this.sampleOnly.add(id);
    this.dispatch(id, { kind: 'retry' });
    this.queue = enqueue(this.queue, { id, priority: 'visible', order: -1 });
    this.pump();
  }

  /** Forgets what is waiting, for a project that closed or a dev server that restarted; pictures are kept. */
  cancelWaiting(): void {
    this.queue = cancelAll(this.queue);
    for (const [id, state] of this.states) {
      if (state.kind === 'queued') {
        this.states.set(id, TILE_IDLE);
      }
    }
    this.changed();
  }

  /** The dev server moved: every kept picture is checked again on its next request, and failures may be retried. */
  invalidateChecks(): void {
    this.checkedAtMs.clear();
    for (const [id, state] of this.states) {
      if (state.kind === 'unavailable') {
        this.states.set(id, TILE_IDLE);
      }
    }
    this.changed();
  }

  close(): void {
    this.closed = true;
    this.queue = cancelAll(this.queue);
    this.listeners.clear();
  }

  private needsRender(id: string): boolean {
    const state = this.tile(id);
    if (state.kind === 'rendering' || state.kind === 'queued') {
      return false;
    }
    if (state.kind === 'ready' && state.refreshing) {
      return false;
    }
    const checked = this.checkedAtMs.get(id);
    return checked === undefined || this.now() - checked > REVALIDATE_AFTER_MS;
  }

  /** Brings a stored snapshot into memory and shows it, without waiting for any render. */
  private load(id: string): void {
    const inMemory = this.held.get(id);
    if (inMemory !== undefined) {
      this.dispatch(id, { kind: 'rendered', key: inMemory.key, attempt: inMemory.attempt });
      return;
    }
    if (this.reading.has(id)) {
      return;
    }
    this.reading.add(id);
    void this.persistence.read(`${this.projectKey}::${id}`).then((stored) => {
      this.reading.delete(id);
      if (this.closed || stored === undefined) {
        return;
      }
      if (this.held.peek(id) === undefined) {
        this.held.set(id, stored, stored.bytes);
      }
      if (this.tile(id).kind !== 'ready') {
        this.dispatch(id, { kind: 'rendered', key: stored.key, attempt: stored.attempt });
      }
    });
  }

  private pump(): void {
    const { queue, started } = startNext(this.queue, this.concurrency);
    this.queue = queue;
    for (const entry of started) {
      void this.run(entry.id);
    }
  }

  private async run(id: string): Promise<void> {
    const listed = this.sources.get(id);
    assert(listed !== undefined, 'A queued tile has a source');
    const source = this.sampleOnly.has(id) ? { ...listed, url: `${listed.url}&attempts=sample` } : listed;
    this.dispatch(id, { kind: 'start' });
    const known = this.held.peek(id)?.key;
    let outcome: ProduceOutcome;
    try {
      outcome = await this.produce(source, known);
    } catch (error: unknown) {
      outcome = { kind: 'empty', reason: 'Threw: ' + String(error) };
    }
    this.queue = finish(this.queue, id);
    if (!this.closed) {
      this.settle(id, outcome);
      this.pump();
    }
  }

  private settle(id: string, outcome: ProduceOutcome): void {
    switch (outcome.kind) {
      case 'snapshot': {
        const message = outcome.message;
        const held: HeldSnapshot = { key: message.key, html: message.html, box: message.box, attempt: message.attempt, bytes: message.html.length };
        assert(held.bytes <= PREVIEW_SNAPSHOT_LIMITS.htmlCharsMax, 'A parsed snapshot is within its bound');
        if (!this.held.set(id, held, held.bytes)) {
          this.dispatch(id, { kind: 'failed', reason: { kind: 'too-large' } });
          return;
        }
        this.checkedAtMs.set(id, this.now());
        this.dispatch(id, { kind: 'rendered', key: held.key, attempt: held.attempt });
        void this.persistence.write(`${this.projectKey}::${id}`, held);
        return;
      }
      case 'unchanged':
        this.checkedAtMs.set(id, this.now());
        this.dispatch(id, { kind: 'unchanged' });
        return;
      case 'empty':
        this.dispatch(id, { kind: 'failed', reason: readPageReason(outcome.reason) });
        return;
      case 'timeout':
        this.dispatch(id, { kind: 'failed', reason: { kind: 'timeout' } });
        return;
      case 'unresolved':
        this.dispatch(id, { kind: 'failed', reason: { kind: 'no-server' } });
        return;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  /** Marks a tile unavailable at once, for a reason known before any render (no server, no file). */
  markUnavailable(id: string, reason: TileUnavailable): void {
    this.dispatch(id, { kind: 'failed', reason });
  }

  private dispatch(id: string, event: TileEvent): void {
    const before = this.tile(id);
    const after = nextTileState(before, event);
    if (after !== before) {
      this.states.set(id, after);
      this.changed();
    }
  }

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** The stores, one per project, so a palette that closes and opens finds the pictures it left. */
const stores = new Map<string, PreviewSnapshotStore>();
const STORES_MAX = 8;

export function storeFor(projectKey: string, create: () => PreviewSnapshotStore): PreviewSnapshotStore {
  const existing = stores.get(projectKey);
  if (existing !== undefined) {
    return existing;
  }
  assert(stores.size < STORES_MAX + 1, 'Stores are bounded');
  if (stores.size >= STORES_MAX) {
    const oldest = stores.keys().next().value;
    if (oldest !== undefined) {
      stores.get(oldest)?.close();
      stores.delete(oldest);
    }
  }
  const created = create();
  stores.set(projectKey, created);
  return created;
}
