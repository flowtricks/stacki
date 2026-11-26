// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the one live canvas, which every frame on
// Design mode's canvas is drawn from.
//
// The editor's own preview frame keeps rendering the site's copy underneath Design mode's canvas. This asks it for
// snapshots (shared/ipc/designSnapshot.ts) and says when what it shows may have changed.
import {
  parseDesignCanvasMessage,
  type DesignCanvasMessage,
  type DesignPageHtmlFailure,
  type DesignSnapshot,
  type DesignSnapshotFailure,
} from '../../../shared/ipc/designSnapshot';

/** How long a snapshot may take before the request is given up. */
const SNAPSHOT_WAIT_MS_MAX = 6_000;

export type SnapshotResult =
  { readonly ok: true; readonly snapshot: DesignSnapshot } | { readonly ok: false; readonly failure: DesignSnapshotFailure | 'no-canvas' | 'timed-out' };

/** The editor's current preview frame; its previous page, still shown while a new one loads, is hidden from readers. */
export function liveCanvasWindow(): Window | undefined {
  const frame = document.querySelector('.preview-frame-wrap iframe[aria-hidden="false"]');
  return frame instanceof HTMLIFrameElement ? (frame.contentWindow ?? undefined) : undefined;
}

/** The path of the page the preview is asked to show, as its address spells it. */
export function livePagePath(): string | undefined {
  const frame = document.querySelector('.preview-frame-wrap iframe[aria-hidden="false"]');
  return frame instanceof HTMLIFrameElement ? pathOfAddress(frame.src) : undefined;
}

export function pathOfAddress(address: string): string | undefined {
  try {
    return new URL(address).pathname;
  } catch {
    return undefined;
  }
}

/** Whether two paths name one page: escapes and a trailing slash aside. */
export function samePage(left: string, right: string): boolean {
  const plain = (value: string): string => {
    let decoded = value;
    try {
      decoded = decodeURI(value);
    } catch {
      // A path that is not well formed is compared as it is written.
    }
    return decoded.replace(/\/+$/, '');
  };
  return plain(left) === plain(right);
}

let nonce = 0;

export function requestSnapshot(): Promise<SnapshotResult> {
  const target = liveCanvasWindow();
  if (target === undefined) {
    return Promise.resolve({ ok: false, failure: 'no-canvas' });
  }
  nonce += 1;
  const asked = `dm-${String(nonce)}`;
  return new Promise((resolve) => {
    const finish = (result: SnapshotResult): void => {
      window.clearTimeout(timer);
      window.removeEventListener('message', receive);
      resolve(result);
    };
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== target) {
        return;
      }
      const message = parseDesignCanvasMessage(event.data);
      if (message?.type !== 'stacki:design-snapshot-reply' || message.nonce !== asked) {
        return;
      }
      finish(message.ok ? { ok: true, snapshot: message.snapshot } : { ok: false, failure: message.failure });
    };
    const timer = window.setTimeout(() => finish({ ok: false, failure: 'timed-out' }), SNAPSHOT_WAIT_MS_MAX);
    window.addEventListener('message', receive);
    target.postMessage({ type: 'stacki:design-watch' }, '*');
    target.postMessage({ type: 'stacki:design-snapshot', nonce: asked }, '*');
  });
}

/** How long the dev server may take to render the page again for a read of its text. */
const PAGE_HTML_WAIT_MS_MAX = 20_000;

export type PageHtmlResult =
  { readonly ok: true; readonly html: string } | { readonly ok: false; readonly failure: DesignPageHtmlFailure | 'no-canvas' | 'timed-out' };

/** The page the live canvas shows, as the dev server renders it now (its text, markers and all). */
export function requestPageHtml(): Promise<PageHtmlResult> {
  const target = liveCanvasWindow();
  if (target === undefined) {
    return Promise.resolve({ ok: false, failure: 'no-canvas' });
  }
  nonce += 1;
  const asked = `dm-${String(nonce)}`;
  return new Promise((resolve) => {
    const finish = (result: PageHtmlResult): void => {
      window.clearTimeout(timer);
      window.removeEventListener('message', receive);
      resolve(result);
    };
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== target) {
        return;
      }
      const message = parseDesignCanvasMessage(event.data);
      if (message?.type !== 'stacki:design-page-html-reply' || message.nonce !== asked) {
        return;
      }
      finish(message.ok ? { ok: true, html: message.html } : { ok: false, failure: message.failure });
    };
    const timer = window.setTimeout(() => finish({ ok: false, failure: 'timed-out' }), PAGE_HTML_WAIT_MS_MAX);
    window.addEventListener('message', receive);
    target.postMessage({ type: 'stacki:design-page-html', nonce: asked }, '*');
  });
}

/** The canvas's own messages that say it shows something new: a rendering, or its styles replaced. */
const CHANGE_TYPES: ReadonlySet<string> = new Set(['avb:render', 'avb:canvas-ready', 'stacki:design-changed']);

/** Calls `report` with what each live preview changes on the preview's page. */
export function watchLivePreviews(report: (message: Extract<DesignCanvasMessage, { readonly type: 'stacki:design-live' }>) => void): () => void {
  const receive = (event: MessageEvent<unknown>): void => {
    if (event.source === null || event.source !== liveCanvasWindow()) {
      return;
    }
    const message = parseDesignCanvasMessage(event.data);
    if (message?.type === 'stacki:design-live') {
      report(message);
    }
  };
  window.addEventListener('message', receive);
  return () => window.removeEventListener('message', receive);
}

/** Calls `changed` whenever the live canvas may show something new. Asks the canvas to say what it shows now. */
export function watchLiveCanvas(changed: () => void): () => void {
  const receive = (event: MessageEvent<unknown>): void => {
    if (event.source === null || event.source !== liveCanvasWindow()) {
      return;
    }
    const data = event.data;
    if (typeof data !== 'object' || !data || !('type' in data) || typeof data.type !== 'string' || !CHANGE_TYPES.has(data.type)) {
      return;
    }
    liveCanvasWindow()?.postMessage({ type: 'stacki:design-watch' }, '*');
    changed();
  };
  window.addEventListener('message', receive);
  liveCanvasWindow()?.postMessage({ type: 'avb:request-render' }, '*');
  return () => window.removeEventListener('message', receive);
}
