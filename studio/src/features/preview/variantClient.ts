import type { PreviewHot } from './renderPushClient';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function paint(html: string) {
  document.dispatchEvent(new CustomEvent('studio:render-html', { detail: html }));
}
export function createVariantPreview(hot: PreviewHot) {
  return new VariantPreview(hot);
}
class VariantPreview {
  private connected = true;
  private request = '';
  private key = '';
  private baseline: string | undefined;
  private wanted: string | undefined;
  private showing = false;
  private committed = false;
  private bytes = 0;
  private readonly cache = new Map<string, string>();
  private cancel() {
    this.wanted = undefined;
    if (this.showing && !this.committed && this.baseline) {
      paint(this.baseline);
    }
    this.showing = false;
  }
  private reset() {
    this.cancel();
    this.key = '';
    this.request = '';
    this.cache.clear();
    this.bytes = 0;
    if (this.connected) {
      this.hot.send('studio:variants-cancel', {});
    }
  }
  receive(command: unknown) {
    if (!this.connected || !object(command)) {
      return;
    }
    if (command['action'] === 'prepare') {
      const next = JSON.stringify(command);
      if (this.key === next) {
        return;
      }
      this.reset();
      this.committed = false;
      this.key = next;
      this.request = crypto.randomUUID();
      this.hot.send('studio:variants-prepare', {
        ...command,
        encoding: 'gzip',
        request: this.request,
        path: location.pathname + location.search,
      });
    } else if (command['action'] === 'hover') {
      this.committed = false;
      this.wanted = JSON.stringify(command['value']);
      const html = this.wanted === undefined ? undefined : this.cache.get(this.wanted);
      if (html) {
        this.showing = true;
        paint(html);
      } else if (this.request) {
        this.hot.send('studio:variants-prioritize', {
          request: this.request,
          value: command['value'],
        });
      }
    } else if (command['action'] === 'cancel') {
      this.cancel();
    } else if (command['action'] === 'commit') {
      this.wanted = undefined;
      this.committed = true;
    } else if (command['action'] === 'reset') {
      this.reset();
    }
  }
  private async render(data: unknown) {
    if (!object(data) || data['request'] !== this.request) {
      return;
    }
    const html = await decodeRenderedHTML(data);
    if (html === undefined || data['request'] !== this.request) {
      return;
    }
    if (!('value' in data)) {
      this.baseline = html;
      return;
    }
    this.bytes += html.length;
    if (this.bytes > 16_000_000) {
      this.reset();
      return;
    }
    const option = JSON.stringify(data['value']);
    this.cache.set(option, html);
    if (this.wanted === option) {
      this.showing = true;
      paint(html);
    }
  }
  constructor(private readonly hot: PreviewHot) {
    hot.on('studio:variant-render', (data) => {
      void this.render(data).catch(() => {
        if (object(data) && data['request'] === this.request) {
          this.reset();
        }
      });
    });
    hot.on('studio:variant-failed', (data) => {
      if (object(data) && data['request'] === this.request) {
        this.reset();
      }
    });
    hot.on('studio:variants-invalidated', () => this.reset());
    hot.on('vite:ws:disconnect', () => {
      // A disconnect already discards the server job. Sending its cancellation
      // on a closed Vite transport throws and disrupts preview recovery.
      this.connected = false;
      this.reset();
    });
    hot.on('vite:ws:connect', () => {
      this.connected = true;
    });
  }
  authoritative(html: string) {
    this.baseline = html;
    this.showing = false;
    this.reset();
    this.committed = false;
    paint(html);
  }
}
import { decodeRenderedHTML } from './renderDecoding';
