// Astro renders components on the server, so Vite cannot hot-swap one: any
// edit ends in "reload the document". A reload restarts every CSS animation,
// rewinds every video, drops scroll position and closes whatever was open —
// in an editor, that is the state you were looking at when you made the edit.
// The dev plugin catches that reload and sends a message here instead.
//
// What arrives is a NEW server rendering of the page. The obvious thing is to
// diff it against the live DOM, and that is wrong: the live DOM is not the
// server's to command. A slider has cloned its slides, a menu has set
// aria-expanded, an analytics tag has appended an iframe. Diffing against the
// live DOM treats all of that as content the server deleted, and removes it.
//
// So the diff is between the server's PREVIOUS rendering and its new one, and
// only that difference is applied to the live page. Anything the client did
// appears in neither rendering, so nothing here has an opinion about it, and
// it survives untouched. Three trees, and the live one is only ever written
// where the other two disagree.

// This module is the client's entry: fetching renderings, update() and the
// two ways the news arrives. It and the modules it imports reach the browser
// as one module's text: main reads the bundle (scripts/build/bundleClients.ts)
// and hands it to the dev plugin as virtual:avb-morph, which has no folder for
// an import to resolve against.

import { stripTemplateMarkers, asDocument } from './morphNodes';
import { parsePreviewRoute } from '../../shared/properties/previewRoute';
import { type ReloadReason, OverCap, refillMorphWork, checkMarkerCap } from './morphBudget';
import {
  previewHost,
  stripAnchors,
  stripPreviewInstrumentation,
  syncAnchors,
  syncStamps,
} from './morphAnchors';
import { patchAttrs, patchChildren } from './morphPatch';
import {
  addedScripts,
  noteScripts,
  runScripts,
  noteStyles,
  loadStyles,
  refreshDevStyles,
} from './morphAssets';

declare global {
  // Vite's import.meta.hot; only .on is used here, so only .on is declared.
  interface ImportMeta {
    readonly hot?: {
      readonly on: (event: string, handler: () => void) => void;
    };
  }
}

interface FetchedDocument {
  readonly withAnchors: Document;
  readonly clean: Document;
}

const host = previewHost(location.hash);
if (host === 'browser') {
  stripPreviewInstrumentation(document);
}

function fetchDocument(initialHTML?: string): Promise<FetchedDocument> {
  const rendering =
    initialHTML === undefined
      ? fetch(location.href, { cache: 'no-store' }).then((response) => {
          // Studio edits authored 404 pages too. Reject transport/server failures,
          // but retain Astro's intentional 404 status for an HTML page rendering.
          const html404 =
            response.status === 404 && response.headers.get('content-type')?.includes('text/html');
          if (!response.ok && !html404) {
            throw new Error('dev server answered ' + response.status);
          }
          return response.text();
        })
      : Promise.resolve(initialHTML);
  return rendering.then((html) => {
    const withAnchors = new DOMParser().parseFromString(html, 'text/html');
    withAnchors.getElementById('studio-render-baseline')?.remove();
    stripTemplateMarkers(withAnchors);
    const clone = withAnchors.cloneNode(true);
    // A cloned document is a Document; the guard is the types' only honest
    // way to say nodeType 9 without an assertion.
    if (!asDocument(clone)) {
      throw new Error('cloned rendering is not a document');
    }
    const clean = clone;
    stripAnchors(clean);
    return { withAnchors, clean };
  });
}

// The server's own rendering of this page, captured before any client code can
// alter it. The live DOM is not a substitute: a script that appends during
// parse has already run by the time this module does, and mistaking its work
// for server output would delete it on the first patch.
// Studio adaptation: use the initial response, even if edits arrive before this
// module loads. Never use an already-mutated live DOM as the server baseline.
function initialRendering(): string | undefined {
  const element = document.getElementById('studio-render-baseline');
  if (!element) {
    return undefined;
  }
  const value: unknown = JSON.parse(element.textContent || 'null');
  element.remove();
  return typeof value === 'string' ? value : undefined;
}
let previousDocument: Document | undefined = undefined;
const ready =
  host === 'stacki'
    ? fetchDocument(initialRendering()).then(
        (fetched) => {
          previousDocument = fetched.clean;
          noteStyles(fetched.clean);
          noteScripts(fetched.clean);
        },
        () => {
          previousDocument = undefined;
        },
      )
    : Promise.resolve();

// A reload is honest: the app hears why before the page goes, and shows it when
// a cap was the reason — the canvas lost its running state on purpose, not by
// accident.
function reloadFor(reason: ReloadReason): void {
  try {
    window.parent.postMessage({ type: 'avb:preview-reload', reason }, '*');
  } catch {
    /* no parent to tell */
  }
  location.reload();
}

let busy = false;
let again = false;
let pushedHTML: string | undefined;
let pushReady = false;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

// The hosted preview receives Astro renders on its existing socket. Keep the
// pull path for old servers, disconnected sockets and failed pushed renders.
function requestUpdate(priority: 'push-first' | 'immediate' = 'push-first'): void {
  if (priority === 'immediate' || !pushReady) {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
    void update();
  } else if (!fallbackTimer) {
    fallbackTimer = setTimeout(() => {
      fallbackTimer = undefined;
      void update();
    }, 1500);
  }
}
document.addEventListener('studio:render-push', (event) => {
  pushReady = event instanceof CustomEvent && event.detail === true;
});
document.addEventListener('studio:render-html', (event) => {
  if (
    !(event instanceof CustomEvent) ||
    typeof event.detail !== 'string' ||
    event.detail.length > 4_000_000
  ) {
    return;
  }
  clearTimeout(fallbackTimer);
  fallbackTimer = undefined;
  pushedHTML = event.detail;
  void update();
});
document.addEventListener('studio:render-fallback', () => {
  clearTimeout(fallbackTimer);
  fallbackTimer = undefined;
  void update();
});
document.dispatchEvent(new window.Event('studio:render-listening'));

// It calls itself only once the last patch has settled (see the end), so the
// stack never grows: that is event re-entry, bounded by `busy`, not recursion.
// eslint-disable-next-line stacki/bounded-recursion -- Event re-entry after settling.
async function update(): Promise<void> {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    await ready;
    if (!previousDocument) {
      throw new Error('no baseline rendering to compare against');
    }
    const html = pushedHTML;
    pushedHTML = undefined;
    if (html !== undefined) {
      again = false;
    }
    const renderingURL = location.href;
    const next = await fetchDocument(html);
    // A newer push arrived while a fallback fetch was in flight.
    if (pushedHTML === undefined && location.href === renderingURL) {
      applyRendering(next);
    } else {
      again = true;
    }
  } catch (error: unknown) {
    // Whatever went wrong, the page must still end up showing what the file
    // says. Falling back to the reload this replaced is always safe.
    // The original called console.warn, which no browser implements — the
    // throw it caused skipped the reload line below, which is the whole point
    // of the catch. Log and reload.
    console.error('[stacki] could not patch the page, reloading:', error);
    reloadFor(error instanceof OverCap ? error.reason : 'patch-failed');
    return;
  } finally {
    busy = false;
  }
  if (again) {
    again = false;
    // Not a nested call: this runs after the last patch has settled and returns
    // at its first await. update() reports its own failures and reloads.
    void update();
  }
}

function applyRendering(next: FetchedDocument): void {
  if (!previousDocument) {
    throw new Error('no baseline rendering to compare against');
  }
  checkMarkerCap(next.withAnchors);
  const added = addedScripts(previousDocument, next.clean);
  if (added === undefined) {
    reloadFor('scripts-changed');
    return;
  }
  refillMorphWork();
  const liveRoot = document.documentElement;
  const previousRoot = previousDocument.documentElement;
  const nextRoot = next.clean.documentElement;
  if (!liveRoot || !previousRoot || !nextRoot) {
    throw new Error('missing <html> in one of the renderings');
  }
  patchAttrs(liveRoot, previousRoot, nextRoot);
  patchChildren(document.head, previousDocument.head, next.clean.head);
  patchChildren(document.body, previousDocument.body, next.clean.body);
  const renderedBefore = previousDocument;
  previousDocument = next.clean;
  // After the patch, so a component that has just appeared is styled by the
  // time anything measures it — and running by the time anything clicks it.
  loadStyles(next.clean);
  refreshDevStyles(renderedBefore, next.clean);
  runScripts(added);
  const liveBody = document.body;
  const serverBody = next.withAnchors.body;
  if (!liveBody || !serverBody) {
    throw new Error('missing <body> in one of the renderings');
  }
  syncAnchors(liveBody, serverBody);
  syncStamps(document, next.withAnchors);
  document.dispatchEvent(new CustomEvent('avb:morphed', { detail: next.withAnchors }));
}

// Two ways the news arrives, because one of them is not reliable enough on its
// own. HMR is the fast path: the dev server saw the file change and said so.
// But that message rides a WebSocket the page opened when it loaded, and a
// socket has ways of going quiet — a dev server restarted under a canvas that
// stayed open, a laptop that slept, a reconnect that landed on something else
// listening on the same port. Nothing tells the page it has stopped hearing;
// it simply never updates again, and the only way to see an edit is to press
// refresh.
//
// The app watches the file system itself, for its own reasons, so it knows
// about every change either way — and it can say so straight to this frame.
// Patching twice for one edit costs a fetch and a diff that finds nothing.
if (import.meta.hot) {
  import.meta.hot.on('avb:page-changed', () => {
    if (host === 'stacki') {
      // update() reports its own failures and reloads; nothing is left to catch.
      requestUpdate();
    } else {
      // The dev plugin turns Astro's broadcast full reload into this event for every
      // client. A normal browser wants Astro's normal behavior, not Stacki's DOM patch.
      location.reload();
    }
  });
}
window.addEventListener('message', (event: MessageEvent) => {
  if (host === 'browser') {
    return;
  }
  const data: unknown = event.data;
  if (event.source === window.parent) {
    const route = parsePreviewRoute(data, location.href);
    if (route && route !== location.pathname + location.search + location.hash) {
      // Reset queued renders before changing subscriptions so an old response cannot
      // repaint the previous mode after the source has changed.
      pushedHTML = undefined;
      history.replaceState(history.state, '', route);
      document.dispatchEvent(new Event('avb:preview-route'));
      void update();
      return;
    }
  }
  if (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data['type'] === 'avb:patch-now'
  ) {
    // update() reports its own failures and reloads; nothing is left to catch.
    const immediate =
      event.source === window.parent && 'immediate' in data && data.immediate === true;
    requestUpdate(immediate ? 'immediate' : 'push-first');
  }
});
