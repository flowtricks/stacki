// Why the design canvas can still be showing its loader, in terms a person can report.
// The shell waits for two things before it hides the loader: the frame loads a page, and
// that page's editor script says it is ready. When the wait runs long, saying which of
// the two is missing turns "it spins forever" into a cause.

export const HANDSHAKE_LIMITS = {
  /** The loader names the missing step after this long without a ready message. */
  slowAfterMs: 15_000,
  /** Retry offers a fresh grant this many times; after that the loader keeps showing why it is stuck. */
  retriesMax: 5,
} as const satisfies Record<string, number>;

export type HandshakeWait =
  | { readonly kind: 'address' } // No preview address has been granted yet.
  | { readonly kind: 'frame' } // The address exists but the frame has not finished loading a page.
  | { readonly kind: 'script' }; // A page loaded in the frame and its editor script has not said ready.

export function handshakeWait(input: { readonly url: string | undefined; readonly frames: number; readonly framesLoaded: number }): HandshakeWait {
  if (!Number.isSafeInteger(input.frames) || !Number.isSafeInteger(input.framesLoaded)) {
    throw new Error('Assertion failed: frame counts are integers');
  }
  if (input.framesLoaded > input.frames) {
    throw new Error('Assertion failed: no more frames have loaded than exist');
  }
  if (input.url === undefined) {
    return { kind: 'address' };
  }
  if (input.framesLoaded > 0) {
    return { kind: 'script' };
  }
  return { kind: 'frame' };
}

// The frame's own report of a failure before its editor script could say ready. A script that
// throws, or fails to load, cannot report itself, so a tiny inline script ahead of it does
// (previewErrorBeacon). The shell shows the text; the bounds keep a hostile frame's message short.
export const PREVIEW_ERROR_LIMITS = {
  messageCharsMax: 300,
} as const satisfies Record<string, number>;

export function parsePreviewError(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'studio:preview-error') {
    return undefined;
  }
  if (!('message' in input) || typeof input.message !== 'string' || input.message.length === 0) {
    return undefined;
  }
  return input.message.slice(0, PREVIEW_ERROR_LIMITS.messageCharsMax);
}

// Runs before the module scripts. A failed script load fires `error` on the element, which does not
// bubble, so the listener is a capturing one: it sees both thrown errors and failed loads.
export const PREVIEW_ERROR_BEACON =
  '(function(){var m=document.querySelector("meta[name=studio-parent-origin]"),o=(m&&m.content)||location.origin,n=0;' +
  'function s(t){if(n++<5){try{parent.postMessage({type:"studio:preview-error",message:String(t).slice(0,300)},o)}catch(e){}}}' +
  'addEventListener("error",function(e){var t=e.target;s(t&&t.src?"Script failed to load: "+t.src.replace(location.origin,""):(e.message||"Script error")+(e.filename?" ("+e.filename.replace(location.origin,"")+":"+e.lineno+")":""))},true);' +
  'addEventListener("unhandledrejection",function(e){s("Unhandled: "+(e.reason&&e.reason.message||e.reason))})})();';

/** Whether another Retry is offered after `attempt` of them: the count is bounded so a dead preview cannot loop. */
export function retryOffered(attempt: number): boolean {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error('Assertion failed: the retry count is a non-negative integer');
  }
  return attempt < HANDSHAKE_LIMITS.retriesMax;
}

/**
 * The page an address means to show: its path and query, without the editor's fragment. A hosted frame is first
 * opened at the preview host's entry address, which carries the page it leads to; the frame then reports that page,
 * so the page is what the loader compares. Comparing the entry address itself never matched, and a ready frame
 * stayed behind its loader.
 */
export const PREVIEW_ENTRY_PATH = '/__studio-entry';
export function pagePath(url: string, base = 'https://preview.invalid/'): string {
  const parsed = new URL(url, base);
  if (parsed.pathname === PREVIEW_ENTRY_PATH) {
    const page = parsed.searchParams.get('page') ?? '/';
    return page.startsWith('/') && !page.startsWith('//') ? page : '/';
  }
  return parsed.pathname + parsed.search;
}
