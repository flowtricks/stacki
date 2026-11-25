import { assert } from '../../../vendor/stacki/shared/core/assert';
import { encodeRenderedHTML } from './renderEncoding';
import type { SourceRenderMode } from './sourceRenderMode';

const PAGES_MAX = 10;
const RENDERS_MAX = 2;
const TYPING_QUIET_MS = 300;
const TYPING_WAIT_MS_MAX = 2000;
// How long a render dropped for a newer write waits for Vite's invalidation before it is
// rendered again anyway: a write Vite does not watch must not leave the page unrendered.
const WATCHER_WAIT_MS_MAX = 500;

export interface RenderTarget {
  readonly gzip?: boolean;
  readonly send: (event: string, data: unknown) => void;
}
interface Subscription {
  readonly targets: Set<RenderTarget>;
  wanted: number;
  running: boolean;
  /** Its last render was dropped for a newer write and waits for that write's invalidation. */
  dropped: boolean;
}

// Render each open URL once, regardless of how many editors or breakpoints show it.
// Rapid prop hovers replace queued work; an obsolete render never reaches the canvas.
export class RenderPush {
  private readonly pages = new Map<string, Subscription>();
  private revision = 0;
  private running = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private typingStarted: number | undefined;
  private typingUntil = 0;
  // Accepted source writes so far. A render that started before the latest one renders a file
  // the room has since replaced: delivered, it would show the canvas an older page than the
  // edits it is already showing (a shown delete would come back until the next render).
  private writes = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly watcherWaitMsMax: number;
  constructor(
    private readonly render: (path: string) => Promise<string>,
    options: { readonly watcherWaitMsMax?: number } = {},
  ) {
    this.watcherWaitMsMax = options.watcherWaitMsMax ?? WATCHER_WAIT_MS_MAX;
    assert(Number.isSafeInteger(this.watcherWaitMsMax), 'The watcher wait is whole milliseconds');
    assert(this.watcherWaitMsMax >= 0, 'The watcher wait is not negative');
  }

  subscribe(path: string, target: RenderTarget): boolean {
    // Vite can announce connection after sending a queued subscription. The same
    // live frame has missed no edits, so its duplicate must not discard running work.
    if (this.pages.get(path)?.targets.has(target)) {
      target.send('studio:render-ready', { path });
      return true;
    }
    this.unsubscribe(target);
    if (!this.pages.has(path) && this.pages.size >= PAGES_MAX) {
      return false;
    }
    const page = this.pages.get(path) ?? { targets: new Set(), wanted: 0, running: false, dropped: false };
    if (page.targets.size >= 30) {
      return false;
    }
    page.targets.add(target);
    this.pages.set(path, page);
    target.send('studio:render-ready', { path });
    if (performance.now() < this.typingUntil) {
      target.send('studio:render-pending', { path });
    }
    // A new connection needs current source, but can share work already requested.
    // Only source invalidation supersedes that work; joining editors do not.
    if (!page.wanted) {
      page.wanted = ++this.revision;
    }
    this.schedule();
    return true;
  }

  unsubscribe(target: RenderTarget) {
    for (const [path, page] of this.pages) {
      page.targets.delete(target);
      if (!page.targets.size) {
        this.pages.delete(path);
      }
    }
  }

  invalidate() {
    for (const [path, page] of this.pages) {
      page.wanted = ++this.revision;
      page.dropped = false;
      if (performance.now() < this.typingUntil) {
        // Acknowledged queued work suppresses redundant browser fallback pulls.
        for (const target of page.targets) {
          target.send('studio:render-pending', { path });
        }
      }
    }
    this.schedule();
  }

  sourceWritten(mode: SourceRenderMode): void {
    this.writes++;
    const now = performance.now();
    if (mode === 'typing') {
      // Literal text is already streamed. Leave the event loop available for
      // keystrokes instead of executing the entire site after every character.
      this.typingStarted ??= now;
      this.typingUntil = Math.min(now + TYPING_QUIET_MS, this.typingStarted + TYPING_WAIT_MS_MAX);
    } else {
      this.typingStarted = undefined;
      this.typingUntil = 0;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule();
  }

  private schedule() {
    // Vite can invalidate multiple environments for the same source edit.
    this.timer ??= setTimeout(
      () => {
        this.timer = undefined;
        this.pump();
      },
      Math.max(0, this.typingUntil - performance.now()),
    );
  }

  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.typingStarted = undefined;
    this.typingUntil = 0;
    for (const page of this.pages.values()) {
      page.targets.clear();
    }
    this.pages.clear();
  }

  private pump() {
    assert(this.pages.size <= PAGES_MAX, 'Preview subscriptions stay bounded');
    assert(this.running <= RENDERS_MAX, 'Preview renders stay within the concurrency limit');
    if (performance.now() < this.typingUntil) {
      this.schedule();
      return;
    }
    this.typingStarted = undefined;
    // Snapshot before rotating: iterating a Map while reinserting its entries can
    // revisit them forever. Waiting collaborators get a turn before a page restarts.
    for (const [path, page] of [...this.pages]) {
      if (this.running >= RENDERS_MAX) {
        return;
      }
      if (page.wanted && !page.running) {
        this.pages.delete(path);
        this.pages.set(path, page);
        void this.renderPage(path, page);
      }
    }
  }

  private async renderPage(path: string, page: Subscription) {
    assert(!page.running, 'A preview page owns at most one running render');
    assert(this.running < RENDERS_MAX, 'A preview render starts only with a free slot');
    const revision = page.wanted;
    const writes = this.writes;
    page.running = true;
    this.running++;
    for (const target of page.targets) {
      target.send('studio:render-pending', { path });
    }
    try {
      const html = await this.render(path);
      if (this.isCurrent(path, page, revision)) {
        if (writes !== this.writes) {
          this.renderAgainSoon(page);
          return;
        }
        const payload = { path, ...(await encodeRenderedHTML(html)) };
        // Source can change while compression yields to collaboration messages.
        if (!this.isCurrent(path, page, revision)) {
          return;
        }
        if (writes !== this.writes) {
          this.renderAgainSoon(page);
          return;
        }
        for (const target of page.targets) {
          target.send('studio:render', target.gzip ? payload : { path, html });
        }
      }
    } catch {
      if (this.isCurrent(path, page, revision)) {
        for (const target of page.targets) {
          target.send('studio:render-failed', { path });
        }
      }
    } finally {
      if (page.wanted === revision) {
        page.wanted = 0;
      }
      page.running = false;
      this.running--;
      this.pump();
    }
  }

  // A render outdated by a write is dropped. Vite's invalidation of that write normally starts the
  // next one; should it not come (a file Vite does not watch), the page renders again after a bound.
  private renderAgainSoon(page: Subscription): void {
    assert(page.running, 'Only a running render is dropped for a newer write');
    page.dropped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      for (const waiting of this.pages.values()) {
        if (waiting.dropped && !waiting.wanted) {
          waiting.wanted = ++this.revision;
        }
        waiting.dropped = false;
      }
      this.schedule();
    }, this.watcherWaitMsMax);
  }

  /** Whether a render is in flight. */
  busy(): boolean {
    return this.running > 0;
  }

  private isCurrent(path: string, page: Subscription, revision: number): boolean {
    if (this.pages.get(path) === page) {
      return page.wanted === revision;
    }
    return false;
  }
}
