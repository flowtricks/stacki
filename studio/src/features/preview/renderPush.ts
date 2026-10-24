export interface RenderTarget {
  readonly gzip?: boolean;
  readonly send: (event: string, data: unknown) => void;
}
interface Subscription {
  readonly targets: Set<RenderTarget>;
  wanted: number;
  running: boolean;
}

// Render each open URL once, regardless of how many editors or breakpoints show it.
// Rapid prop hovers replace queued work; an obsolete render never reaches the canvas.
export class RenderPush {
  private readonly pages = new Map<string, Subscription>();
  private revision = 0;
  private running = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly render: (path: string) => Promise<string>) {}

  subscribe(path: string, target: RenderTarget): boolean {
    this.unsubscribe(target);
    if (!this.pages.has(path) && this.pages.size >= 10) {
      return false;
    }
    const page = this.pages.get(path) ?? { targets: new Set(), wanted: 0, running: false };
    if (page.targets.size >= 30) {
      return false;
    }
    page.targets.add(target);
    this.pages.set(path, page);
    target.send('studio:render-ready', { path });
    // Reconnecting frames may have missed invalidations while the container slept.
    // Read current source even when no subsequent edit triggers another render.
    page.wanted = ++this.revision;
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
    for (const page of this.pages.values()) {
      page.wanted = ++this.revision;
    }
    this.schedule();
  }

  private schedule() {
    // Vite can invalidate multiple environments for the same source edit.
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, 0);
  }

  close() {
    clearTimeout(this.timer);
    this.pages.clear();
  }

  private pump() {
    for (const [path, page] of this.pages) {
      if (this.running >= 2) {
        return;
      }
      if (page.wanted && !page.running) {
        void this.renderPage(path, page);
      }
    }
  }

  private async renderPage(path: string, page: Subscription) {
    const revision = page.wanted;
    page.running = true;
    this.running++;
    try {
      const html = await this.render(path);
      if (page.wanted === revision) {
        const payload = { path, ...encodeRenderedHTML(html) };
        for (const target of page.targets) {
          target.send('studio:render', target.gzip ? payload : { path, html });
        }
      }
    } catch {
      if (page.wanted === revision) {
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
}
import { encodeRenderedHTML } from './renderEncoding';
