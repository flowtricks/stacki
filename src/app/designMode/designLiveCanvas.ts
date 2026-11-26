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
  type DesignWalking,
} from '../../../shared/ipc/designSnapshot';

/** How long the canvas may take to say it heard a request: one still loading hears nothing and never answers. */
const SNAPSHOT_HEARD_MS_MAX = 3_000;
/** How long a snapshot may take once heard: past the canvas's longest walk of a page. */
const SNAPSHOT_WAIT_MS_MAX = 25_000;

export type SnapshotResult =
  { readonly ok: true; readonly snapshot: DesignSnapshot } | { readonly ok: false; readonly failure: DesignSnapshotFailure | 'no-canvas' | 'timed-out' };

// The selector names iframes only, so the element needs no check of its kind against the window's globals.
const SHOWN_PREVIEW = '.preview-frame-wrap iframe[aria-hidden="false"]';

function shownPreview(): HTMLIFrameElement | undefined {
  return document.querySelector<HTMLIFrameElement>(SHOWN_PREVIEW) ?? undefined;
}

/** Whether the canvas may walk the page: not while the pointer button shows the preview itself to the person. */
export function walkingNow(): DesignWalking {
  return document.querySelector('.preview-frame-wrap[data-canvas-interactive="true"]') === null ? 'allowed' : 'held';
}

/** The editor's current preview frame; its previous page, still shown while a new one loads, is hidden from readers. */
export function liveCanvasWindow(): Window | undefined {
  return shownPreview()?.contentWindow ?? undefined;
}

/** The path of the page the preview is asked to show, as its address spells it. */
export function livePagePath(): string | undefined {
  const frame = shownPreview();
  return frame === undefined ? undefined : pathOfAddress(frame.src);
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

function isCanvasReady(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'avb:canvas-ready';
}

export function requestSnapshot(walking: DesignWalking): Promise<SnapshotResult> {
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
      // A new document in the preview will never answer what the one before it was asked.
      if (isCanvasReady(event.data)) {
        finish({ ok: false, failure: 'timed-out' });
        return;
      }
      const message = parseDesignCanvasMessage(event.data);
      if (message?.type === 'stacki:design-snapshot-started' && message.nonce === asked) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => finish({ ok: false, failure: 'timed-out' }), SNAPSHOT_WAIT_MS_MAX);
        return;
      }
      if (message?.type !== 'stacki:design-snapshot-reply' || message.nonce !== asked) {
        return;
      }
      finish(message.ok ? { ok: true, snapshot: message.snapshot } : { ok: false, failure: message.failure });
    };
    let timer = window.setTimeout(() => finish({ ok: false, failure: 'timed-out' }), SNAPSHOT_HEARD_MS_MAX);
    window.addEventListener('message', receive);
    target.postMessage({ type: 'stacki:design-watch' }, '*');
    target.postMessage({ type: 'stacki:design-snapshot', nonce: asked, walking }, '*');
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
