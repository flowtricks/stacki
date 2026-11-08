// Stands in for `/@vite/client` in a baked page's preview client, which has no dev
// server to talk to. Four things change, and only here: the hot channel carries
// nothing but prop hover previews, which the parent window renders from the bake's
// templates in place of the dev server's variant renders (variantClient.ts);
// morph.js's pull of the current page goes to the parent window, which holds the
// current rendering; and the parent's style-only updates land the way Vite's CSS
// hot update does. Everything else in previewClient.ts runs as it always does.
import { BAKE_MESSAGES, BAKE_SECTION_ATTRIBUTE } from './bakeProtocol';
import { bakedLinkPath } from './bakeLinks';
import { applySectionUpdates, parseSectionUpdates } from './bakeStyleUpdate';
import { record, string } from '../../shared/validation';

const RENDER_TIMEOUT_MS = 5_000;
const RENDER_BYTES_MAX = 8_000_000;
const RENDERS_PENDING_MAX = 8;
// previewClient.ts and the modules it loads listen for a handful of events.
const HOT_LISTENERS_MAX = 64;

interface StaticHot {
  readonly on: (event: string, callback: (data: unknown) => void) => void;
  readonly send: (event: string, data: unknown) => void;
}

const nativeFetch = window.fetch.bind(window);
const pending = new Map<number, (html: string | undefined) => void>();
let nextRender = 0;

function requestRendering(): Promise<string | undefined> {
  if (pending.size >= RENDERS_PENDING_MAX) {
    return Promise.resolve(undefined);
  }
  const id = ++nextRender;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(undefined);
    }, RENDER_TIMEOUT_MS);
    pending.set(id, (html) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(html);
    });
    window.parent.postMessage({ type: BAKE_MESSAGES.renderRequest, id, path: location.pathname }, location.origin);
  });
}

const hotListeners = new Map<string, ((data: unknown) => void)[]>();
let hotListenerCount = 0;

function emitHot(event: string, data: unknown): void {
  for (const listener of hotListeners.get(event) ?? []) {
    listener(data);
  }
}

// The dev server's variant protocol (variantServer.ts), answered by the parent window.
// Every other event the client sends has nothing to answer it here.
function sendHot(event: string, data: unknown): void {
  if (window.parent === window) {
    return;
  }
  if (event === 'studio:variants-prepare') {
    window.parent.postMessage({ type: BAKE_MESSAGES.variantRequest, data }, location.origin);
  } else if (event === 'studio:variants-prioritize') {
    const message = record(data);
    window.parent.postMessage({ type: BAKE_MESSAGES.variantPriority, request: message['request'], value: message['value'] }, location.origin);
  } else if (event === 'studio:variants-cancel') {
    window.parent.postMessage({ type: BAKE_MESSAGES.variantCancel }, location.origin);
  }
}

function receiveVariant(data: Record<string, unknown>): boolean {
  if (data['type'] === BAKE_MESSAGES.variantRender) {
    emitHot('studio:variant-render', data['render']);
    return true;
  }
  if (data['type'] === BAKE_MESSAGES.variantFailed) {
    emitHot('studio:variant-failed', { request: data['request'] });
    return true;
  }
  return false;
}

function receiveParentMessage(event: MessageEvent<unknown>): void {
  if (event.source !== window.parent || event.origin !== location.origin) {
    return;
  }
  try {
    const data = record(event.data);
    if (receiveVariant(data)) {
      return;
    }
    if (data['type'] === BAKE_MESSAGES.styleUpdate) {
      applySectionUpdates(document.querySelectorAll(`style[${BAKE_SECTION_ATTRIBUTE}]`), BAKE_SECTION_ATTRIBUTE, parseSectionUpdates(data['sections']));
      return;
    }
    if (data['type'] !== BAKE_MESSAGES.renderResult || typeof data['id'] !== 'number') {
      return;
    }
    pending.get(data['id'])?.(data['html'] === undefined ? undefined : string(data['html'], RENDER_BYTES_MAX));
  } catch {
    /* A malformed reply is the same as no reply: the request times out. */
  }
}

function isPageRendering(input: RequestInfo | URL): boolean {
  return input === location.href;
}

// `.../stacki-runtime/preview.js` sits one folder under the baked site's root.
const siteRoot = new URL('../', import.meta.url).pathname;

// The interactive full-site preview lets a visitor click the site's own links. Those are written
// from the site root (`/about`), and the bake is served under a base, so each one is
// moved under the base. A target the bake does not have stays blocked: a preview
// that wandered off the copy would lose the editor.
function holdLinks(event: MouseEvent): void {
  // A canvas frame's links belong to the canvas: it knows the pages and the base, waits
  // out a double click, and keeps `#avb-design` so the next page is selectable.
  if (location.hash === '#avb-design') {
    return;
  }
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement) || link.origin !== location.origin || link.pathname.startsWith(siteRoot)) {
    return;
  }
  event.preventDefault();
  const target = new URL(link.href);
  target.pathname = bakedLinkPath(link.pathname, siteRoot);
  void nativeFetch(target.href, { method: 'HEAD' }).then(
    (response) => {
      if (response.ok) {
        location.assign(target.href);
      }
    },
    () => undefined, // Unreachable: the link stays where it is.
  );
}

if (window.parent !== window) {
  window.addEventListener('click', holdLinks, true);
  window.addEventListener('message', receiveParentMessage);
  window.fetch = async (input, init) => {
    if (isPageRendering(input)) {
      const html = await requestRendering();
      if (html !== undefined) {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      }
    }
    return nativeFetch(input, init);
  };
}

export function createHotContext(_owner: string): StaticHot {
  return {
    on: (event, callback) => {
      if (hotListenerCount >= HOT_LISTENERS_MAX) {
        throw new Error('The baked preview has more hot listeners than it allows');
      }
      hotListenerCount++;
      hotListeners.set(event, [...(hotListeners.get(event) ?? []), callback]);
    },
    send: sendHot,
  };
}
