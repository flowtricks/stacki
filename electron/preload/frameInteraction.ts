import { assert } from '../../shared/core/assert';
import { isCanvasSitePage, type CanvasInteraction, type CanvasSitePages } from '../../shared/properties/canvasInteraction';

// The canvas pointer in two modes. Both select: hover outlines, click to select,
// double-click to edit text or open a component, the context menu. Interact mode
// differs in one thing only: the page also receives the activation, so a link
// navigates, a button runs its script, a form submits and a field takes focus.

let canvas = location.hash.includes('avb-design');
let mode: CanvasInteraction = 'select';
let gesture: { readonly x: number; readonly y: number; dragged: boolean } | undefined;
const DRAG_DISTANCE_PX = 6;
// A link click waits this long for a second click before it navigates, so a
// double-click on the link's words still opens them for editing instead of
// leaving the page. Long enough for a brisk double-click, short enough that a
// single click still feels like following a link.
export const LINK_HOLD_MS = 350;
let heldLink: ReturnType<typeof setTimeout> | undefined;
// The site's pages, once the host has said (useCanvasInteraction). Until then every
// same-origin link counts as one, as it did before the host could say.
let sitePages: CanvasSitePages | undefined;
let replaying = false;

// The canvas turns the pointer into selection, in either mode.
export function canvasSelects(): boolean {
  return canvas;
}

// The canvas keeps the page from acting on a press: links, submits, focus.
export function canvasInert(): boolean {
  if (canvas) {
    return mode === 'select';
  }
  return false;
}

export function trackCanvas(): void {
  canvas = true;
}

export function setCanvasInteraction(next: CanvasInteraction): void {
  canvas = true;
  mode = next;
  gesture = undefined;
  releaseHeldLink();
  const style = document.getElementById('avb-design-style');
  if (style instanceof HTMLStyleElement) {
    style.textContent = canvasCursorCSS();
    style.disabled = !canvasSelects();
  }
}

// The canvas's cursor. Select mode shows the editor's arrow everywhere. Interact
// mode shows the same arrow, never the I-beam over words: it is still the editor,
// and a page's text is selected and edited as in select mode. What acts on a
// click shows the pointer, so it is plain what will navigate or run: links,
// buttons, <summary>, labels, form controls, and whatever the page itself gives a
// cursor (`cursor: pointer` on a card). Fields typed into keep their I-beam,
// since interact mode lets them take focus and keystrokes.
//
// Interact mode's rules have no specificity (`:where`) and no !important, so a
// cursor the page sets on an element wins over them; the arrow on <html> is
// inherited by everything the page leaves alone, which is where the I-beam came
// from (`cursor: auto` over text).
const DESIGN_CURSOR_CSS = '*, *::before, *::after { cursor: default !important; }';
const INTERACT_CURSOR_CSS = [
  ':where(html) { cursor: default; }',
  ':where(a[href], area[href], button, summary, label, select, [role="button"], [role="link"], [onclick]) { cursor: pointer; }',
  ':where(input:is([type="button" i], [type="submit" i], [type="reset" i], [type="checkbox" i], [type="radio" i], [type="file" i], [type="image" i], [type="color" i], [type="range" i])) { cursor: pointer; }',
  ':where(textarea, input:not([type="button" i], [type="submit" i], [type="reset" i], [type="checkbox" i], [type="radio" i], [type="file" i], [type="image" i], [type="color" i], [type="range" i], [type="hidden" i]), [contenteditable]:not([contenteditable="false" i])) { cursor: text; }',
].join('\n');

/** The canvas cursor stylesheet for the current mode. Desktop and Studio both apply it. */
export function canvasCursorCSS(): string {
  return mode === 'interact' ? INTERACT_CURSOR_CSS : DESIGN_CURSOR_CSS;
}

/** The host's list of the site's pages (`avb:site-pages`). */
export function setCanvasSitePages(next: CanvasSitePages): void {
  sitePages = next;
}

export function canvasDragged(): boolean {
  return gesture?.dragged ?? false;
}

// The held link's own click, replayed for the page: the canvas lets it through
// untouched, and it has already been selected.
export function replayingLinkClick(): boolean {
  return replaying;
}

// Interact mode only, after the click has been selected: a click on a link is
// held back from the page until the double-click window passes. A link to one
// of the site's own pages is then replayed so the page's own handlers (a
// client-side router included) and the browser's navigation see exactly one
// click. Any other link never navigates the canvas (canvasLinkDestination): a
// web link opens in a new browser tab, which Desktop's window-open handler
// turns into the system browser, as it does for every link in the app. The
// second click of a double-click cancels either. Any other click goes straight
// through.
export function holdLinkClick(event: MouseEvent): void {
  assert(!canvasInert(), 'Only interact mode passes clicks to the page');
  assert(!replaying, 'A replayed click is never held again');
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const anchor = target.closest('a[href]');
  if (anchor === null) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  releaseHeldLink();
  if (event.detail > 1) {
    return; // The second click of a double-click: the text editor takes it.
  }
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: event.button,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    detail: 1,
  };
  const destination = canvasLinkDestination(
    { href: anchor.getAttribute('href') ?? '', target: anchor.getAttribute('target') ?? '', download: anchor.hasAttribute('download') },
    location.href,
    { newContext: event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0, pages: sitePages },
  );
  heldLink = setTimeout(() => {
    heldLink = undefined;
    // Switching back to select mode cancels the held click (setCanvasInteraction).
    assert(!canvasInert(), 'A held link click outlives interact mode');
    switch (destination.kind) {
      case 'page': {
        // Another page of the site: the canvas loads it itself (see canvasPageAddress).
        const address = canvasPageAddress(anchor.getAttribute('href') ?? '', location.href, sitePages);
        if (address !== undefined) {
          location.assign(address);
          return;
        }
        // Within the page, or a script: the page's own handlers run it. A morph may
        // have replaced the words clicked; the link still stands for them.
        const receiver = target.isConnected ? target : anchor;
        if (receiver.isConnected) {
          replayLinkClick(receiver, init);
        }
        return;
      }
      case 'browser': {
        // `noopener`: the site gets no handle on the editor's window.
        window.open(destination.url, '_blank', 'noopener,noreferrer');
        return;
      }
      case 'none': {
        return;
      }
      default: {
        const exhaustive: never = destination;
        return exhaustive;
      }
    }
  }, LINK_HOLD_MS);
}

// The interactive preview, where the page is the visitor's: no selection, no held
// click, and a link goes where it goes on the live site, as a full page load. Two
// listeners, so the page keeps every decision a browser would leave to it:
// - In capture, before anything else on the page, a same-origin path that is none of
//   the site's pages (a download route the site's server answers, a file) opens in a
//   new tab. Followed inside the frame it would land on another site that refuses to
//   be framed, and the static demo's link guard would hold it as a page it lacks.
// - After the page's own handlers (window, bubbling), a click nobody took on a link
//   off the site opens in a new tab, as the canvas's interact mode does
//   (canvasLinkDestination). A lightbox's link script or a link within the page has
//   already said what the click does.
// A link to one of the site's pages is the browser's to follow; under the static demo's
// base the demo's own runtime moves it under the base (studio staticHot.ts).
// Studio's frame client installs these before any other module runs (previewLinks.ts);
// Desktop's main process holds its preview frame to the same rule (previewNavigation.ts).
export function installPreviewLinks(): void {
  window.addEventListener('click', previewLinkCapture, true);
  window.addEventListener('click', previewLinkBubble, false);
}

function previewLinkCapture(event: MouseEvent): void {
  const link = previewLinkOf(event);
  if (link === undefined) {
    return;
  }
  if (link.destination.kind === 'browser') {
    if (new URL(link.destination.url).origin === location.origin) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openPreviewTab(link.destination.url);
    }
  }
}

function previewLinkBubble(event: MouseEvent): void {
  if (event.defaultPrevented) {
    return; // The page, its router or the demo's link guard took it.
  }
  const link = previewLinkOf(event);
  if (link === undefined) {
    return;
  }
  if (link.destination.kind === 'browser') {
    event.preventDefault();
    openPreviewTab(link.destination.url);
  }
  // A page link and a `mailto:` link: the browser's own business.
}

// The link a preview click is on, and where it leads; undefined in a canvas frame
// (its clicks are the canvas's) and for a click on anything that is not a link.
function previewLinkOf(event: MouseEvent): { readonly destination: CanvasLinkDestination } | undefined {
  if (canvas) {
    return undefined;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return undefined;
  }
  const anchor = target.closest('a[href]');
  if (anchor === null) {
    return undefined;
  }
  const href = anchor.getAttribute('href') ?? '';
  const destination = canvasLinkDestination({ href, target: anchor.getAttribute('target') ?? '', download: anchor.hasAttribute('download') }, location.href, {
    newContext: event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0,
    pages: sitePages,
  });
  return { destination };
}

function openPreviewTab(url: string): void {
  assert(!canvas, 'Only the interactive preview opens its links for the visitor');
  // `noopener`: the site gets no handle on the editor's window.
  window.open(url, '_blank', 'noopener,noreferrer');
}

// A link within the page (`#pricing`, `href="#"` opening a menu) or a
// `javascript:` link: the page's own handlers and the browser see one click.
function replayLinkClick(receiver: Element, init: MouseEventInit): void {
  replaying = true;
  try {
    receiver.dispatchEvent(new MouseEvent('click', init));
  } finally {
    replaying = false;
  }
}

const DESIGN_HASH = '#avb-design';

// The address a same-origin page link loads in the canvas: the link's page with
// the design hash, loaded in full. Left to the browser, the link's own URL drops the
// hash, and a page loaded without it is a plain visitor's page: the morph client
// strips every marker (morphAnchors.ts), so nothing on it could be selected. Left
// to the page, a client-side router (Astro's <ClientRouter />) fetches the page and
// swaps it in, and the swapped-in page is no rendering the canvas can address
// either. So the page's handlers do not see a click that leaves the page.
//
// Under a base (the static demo serves its pages at /demo/site/), a link written
// from the site root (`/features`) moves under it, at the folder its baked
// `index.html` is served from (`/demo/site/features/`).
//
// Undefined for a link within the page itself (`#pricing`), which the browser
// scrolls to without loading anything, and for one that is not a page of this site.
export function canvasPageAddress(href: string, frameURL: string, pages?: CanvasSitePages): string | undefined {
  assert(URL.canParse(frameURL), 'canvasPageAddress: the frame has a URL');
  if (!URL.canParse(href, frameURL)) {
    return undefined;
  }
  const destination = new URL(href, frameURL);
  const current = new URL(frameURL);
  if (destination.origin !== current.origin) {
    return undefined; // A `javascript:` link runs its script and goes nowhere.
  }
  destination.pathname = canvasBasePath(destination.pathname, pages?.base ?? '');
  if (destination.pathname === current.pathname) {
    if (destination.search === current.search) {
      // A fragment, empty or not (`href="#"` opening a menu): the same document.
      if (destination.href.includes('#')) {
        return undefined;
      }
    }
  }
  destination.hash = DESIGN_HASH;
  return destination.href;
}

// A root path moved under the base; a path already under it, or no base, is kept.
function canvasBasePath(pathname: string, base: string): string {
  if (base === '') {
    return pathname;
  }
  if (pathname === base || pathname.startsWith(`${base}/`)) {
    return pathname;
  }
  const last = pathname.split('/').at(-1) ?? '';
  const folder = pathname.endsWith('/') || last.includes('.') ? pathname : `${pathname}/`;
  return `${base}${folder}`;
}

/** Where a followed link goes from the canvas. Only `page` ever navigates the frame. */
export type CanvasLinkDestination = { readonly kind: 'page' } | { readonly kind: 'browser'; readonly url: string } | { readonly kind: 'none' };

const SCRIPT_PROTOCOL = 'javascript:';

// Pure, so each kind of link is pinned without a page. A link may navigate the
// canvas only when it stays in this frame and on the frame's own origin: the
// project's dev server, or the static demo's site. Another origin would show a
// site that refuses to be framed under the editor's outlines; `_top`/`_parent`
// would navigate the editor itself; `_blank`, a named window or a modifier
// asked for a new one. Those open in the browser when they are web links. Any
// other scheme (mailto:, tel:, an app's own) does nothing, the rule Desktop's
// window-open handler keeps (windowSecurity.ts isBrowserLink). A same-origin
// path that is not a project page still navigates; the host takes the frame
// back to the page it was on (useCanvasInteraction).
export function canvasLinkDestination(
  link: { readonly href: string; readonly target: string; readonly download: boolean },
  frameURL: string,
  options: { readonly newContext: boolean; readonly pages: CanvasSitePages | undefined },
): CanvasLinkDestination {
  assert(URL.canParse(frameURL), 'canvasLinkDestination: the frame has a URL');
  if (!URL.canParse(link.href, frameURL)) {
    return { kind: 'none' };
  }
  const destination = new URL(link.href, frameURL);
  if (destination.protocol === SCRIPT_PROTOCOL) {
    return { kind: 'page' }; // Runs the page's script; it navigates nothing.
  }
  const web = destination.protocol === 'http:' || destination.protocol === 'https:';
  if (web) {
    const sameFrame = !options.newContext && ['', '_self'].includes(link.target.trim().toLowerCase());
    if (sameFrame) {
      if (destination.origin === new URL(frameURL).origin) {
        if (canvasLinkStays(destination, new URL(frameURL), link, options.pages)) {
          return { kind: 'page' };
        }
      }
    }
    return { kind: 'browser', url: destination.href };
  }
  return { kind: 'none' };
}

// A same-origin, same-frame link the canvas follows itself. Once the host has
// listed the site's pages, a path that is none of them (a download route the
// site's server answers, a file, an API) opens in the browser instead, as it
// would on the live site, and so does a link marked `download`. A link within
// the page (`#pricing`) always stays.
function canvasLinkStays(destination: URL, frame: URL, link: { readonly download: boolean }, pages: CanvasSitePages | undefined): boolean {
  if (destination.pathname === frame.pathname) {
    if (destination.search === frame.search) {
      return true; // Within the page: a scroll, never a download.
    }
  }
  if (link.download) {
    return false;
  }
  if (pages === undefined) {
    return true;
  }
  return isCanvasSitePage(destination.pathname, pages);
}

// The canvas never leaves its origin on its own either: a page script setting
// `location.href`, or a form posting to another site, is cancelled before it
// starts wherever the browser has the Navigation API. Desktop's main process
// refuses the same navigations for every browser (previewNavigation.ts), and
// Studio's host takes back a frame that left anyway (useCanvasInteraction).
// Back and forward are left alone: they are the browser's, and not cancelable.
export function guardCanvasNavigation(): void {
  const navigation: unknown = Reflect.get(window, 'navigation');
  if (typeof navigation !== 'object' || navigation === null) {
    return;
  }
  const listen: unknown = Reflect.get(navigation, 'addEventListener');
  if (typeof listen !== 'function') {
    return;
  }
  Reflect.apply(listen, navigation, ['navigate', guardCanvasNavigationEvent]);
}

function guardCanvasNavigationEvent(event: Event): void {
  if (!canvas) {
    return;
  }
  if (!event.cancelable) {
    return;
  }
  const destination: unknown = Reflect.get(event, 'destination');
  const url: unknown = typeof destination === 'object' && destination !== null ? Reflect.get(destination, 'url') : undefined;
  if (typeof url !== 'string') {
    return;
  }
  if (canvasLeavesOrigin(url, location.href)) {
    event.preventDefault();
  }
}

// Whether a navigation to `url` takes the frame off its own origin. A URL that
// does not parse is refused too: nothing the canvas can show.
export function canvasLeavesOrigin(url: string, frameURL: string): boolean {
  assert(URL.canParse(frameURL), 'canvasLeavesOrigin: the frame has a URL');
  if (URL.canParse(url, frameURL)) {
    return new URL(url, frameURL).origin !== new URL(frameURL).origin;
  }
  return true;
}

function releaseHeldLink(): void {
  if (heldLink !== undefined) {
    clearTimeout(heldLink);
    heldLink = undefined;
  }
}

export function trackCanvasGesture(): void {
  // Observe, never cancel, pointer events: slider libraries must receive their drag stream.
  window.addEventListener(
    'pointerdown',
    (event) => {
      gesture = event.button === 0 ? { x: event.clientX, y: event.clientY, dragged: false } : undefined;
    },
    true,
  );
  window.addEventListener(
    'pointermove',
    (event) => {
      if (gesture) {
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= DRAG_DISTANCE_PX) {
          gesture.dragged = true;
        }
      }
    },
    true,
  );
  window.addEventListener(
    'pointercancel',
    () => {
      gesture = undefined;
    },
    true,
  );
}
