// First: the preview's link listeners go on before any other module's (previewLinks.ts).
import './previewLinks';
import { receiveLiveVariables } from '../../../vendor/stacki/electron/preload/frameLiveVariables';
import { receiveLiveRules } from '../../../vendor/stacki/electron/preload/frameLiveRules';
import { installCanvasText } from '../../../vendor/stacki/electron/preload/frameText';
import { parseCanvasInteraction, parseCanvasSitePages, type CanvasInteraction } from '../../../vendor/stacki/shared/properties/canvasInteraction';
import {
  canvasCursorCSS,
  canvasDragged,
  guardCanvasNavigation,
  holdLinkClick,
  replayingLinkClick,
  setCanvasInteraction,
  setCanvasSitePages,
  trackCanvasGesture,
} from '../../../vendor/stacki/electron/preload/frameInteraction';
import { freezeViewportHeight, report as reportPageHeight } from '../../../vendor/stacki/electron/preload/frameViewport';
import { receiveLiveNumericStyles, applyLiveNumericStyles } from './liveNumericStyles';
import { receiveLiveText, applyLiveText } from './liveTextClient';
import { installCursorPresence } from '../collaboration/cursorClient';
import { receiveRenderPush } from './renderPushClient';
import { cancelReveal, revealPath } from '../../../vendor/stacki/electron/preload/frameReveal';
import { inlineTextPathAt } from '../../../vendor/stacki/electron/preload/inlineText';
import { forgetUnionBoxes, unionTargetAt } from '../../../vendor/stacki/electron/preload/frameUnionTarget';
import { startGuide } from '../../../vendor/stacki/electron/preload/frameGuide';
import { taggedPlaces, inFocus, setTracking, resetFocusCache } from '../../../vendor/stacki/electron/preload/frameRegions';
import { forwardPreviewKeys } from './previewKeys';
import { forwardStyleModifiers } from './styleModifiers';
import { answerPreviewQuery } from './previewQueries';
import { createHotContext } from '/@vite/client';
import { createOutlines, type OutlineTarget } from './previewOutlines';
import { listenForCanvasMoves, revertCanvasMoves, showCanvasMove } from '../../../vendor/stacki/electron/preload/frameMove';
import { parseCanvasMove, renumberedCanvasPath, type CanvasMove } from '../../../vendor/stacki/shared/page/canvasMove';
const studioOrigin = document.querySelector<HTMLMetaElement>('meta[name=studio-parent-origin]')?.content || location.origin;
const post = (message: unknown) => window.parent.postMessage(message, studioOrigin);
const cursorPresence = installCursorPresence(post);
const columnGuide = startGuide(post);
// Recreating a Vite hot context clears its earlier event listeners.
const hot = createHotContext('/studio/preview.js');
const variants = receiveRenderPush(hot);
hot.on('avb:page-changed', () => post({ type: 'studio:invalidate' }));
hot.on('studio:cms-changed', () => post({ type: 'studio:cms-changed' }));
hot.on('studio:css-changed', () => post({ type: 'studio:css-changed' }));
let lastInteraction = 0;
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(
    type,
    () => {
      if (Date.now() - lastInteraction > 1000) {
        lastInteraction = Date.now();
        post({ type: 'studio:interaction' });
      }
    },
    { passive: true },
  );
}
trackCanvasGesture();
// The canvas stays on the site: off-origin navigations are refused, and the host
// hears when this document goes (frameInteraction.ts, useCanvasInteraction).
guardCanvasNavigation();
window.addEventListener('pagehide', () => post({ type: 'avb:leaving' }));
let selected: OutlineTarget | undefined;
let hovered: OutlineTarget | undefined;
let scope = '';
// The full-site preview (no #avb-design) leaves the page to the visitor. The
// canvas's interact mode is not that: it selects as select mode does, and the
// page also receives each click (frameInteraction.ts).
let interactive = !location.hash.includes('avb-design');
let canvasMode: CanvasInteraction = 'select';
installCanvasText(
  post,
  () => !interactive && window.parent !== window,
  (target, element) => {
    const id = target.parent.slice(scope.length);
    const box = element.getBoundingClientRect();
    post({ type: 'studio:select', id, occurrence: occurrenceAt(id, box.x, box.y) });
  },
);
const selectionCursor = new CSSStyleSheet();
// Clip the document root while editing; interactive preview keeps the site's own scrolling.
paintSelectionCursor();
document.adoptedStyleSheets = [...document.adoptedStyleSheets, selectionCursor];
let collaborators: string[] = [];
forwardPreviewKeys(post, () => interactive);
const reportNavigation = () => post({ type: 'avb:navigated', path: location.pathname + location.search });
reportNavigation();
window.addEventListener('popstate', reportNavigation);
document.addEventListener('astro:page-load', reportNavigation);
document.addEventListener('keydown', (event) => {
  if (interactive && event.key === 'Escape' && !event.isComposing) {
    if (pageClaimsEscape(event)) {
      return;
    }
    event.preventDefault();
    post({ type: 'studio:exit-preview' });
  }
});
// An Escape the site is using stays the site's: one its own script already handled, or
// the one that closes its modal dialog or leaves full screen. Exiting preview on it
// called preventDefault, which also blocks the dialog's close request, so a lightbox
// stayed open while the editor left preview underneath it.
function pageClaimsEscape(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) {
    return true;
  }
  if (document.fullscreenElement) {
    return true;
  }
  return document.querySelector('dialog:modal') !== null;
}
forwardStyleModifiers(post);
let labels: Record<string, { label: string; component: boolean; nodeKind: string }> = {};
const paint = createOutlines(post);
const draw = () => paint(selected, hovered, collaborators);
function target(id: string, occurrence?: number): OutlineTarget | undefined {
  return id
    ? {
        id: scope + id,
        label: labels[id]?.label ?? 'Element',
        component: labels[id]?.component ?? false,
        nodeKind: labels[id]?.nodeKind ?? 'element',
        ...(occurrence === undefined ? {} : { occurrence }),
      }
    : undefined;
}
function pageId(element: Element): string | undefined {
  if (!inFocus(element)) {
    return undefined;
  }
  for (let current: Element | null = element; current; current = current.parentElement) {
    const ids = current.getAttribute('data-avb-p')?.split(' ') ?? [];
    // The deepest path, as Desktop's hit-testing picks (frameTargets.ts): a loop's
    // markers tag each item with the loop's path beside the item's own.
    const id = ids
      .filter((value) => value.startsWith(scope) && /^\d+(\.\d+)*$/.test(value.slice(scope.length)))
      .reduce<string | undefined>((deepest, value) => (deepest === undefined || depthOf(value) > depthOf(deepest) ? value : deepest), undefined);
    if (id) {
      return id.slice(scope.length);
    }
  }
  return undefined;
}
document.addEventListener(
  'pointermove',
  (event) => {
    if (!(event.target instanceof Element) || event.target.closest('#studio-live-cursors')) {
      return;
    }
    const { id, occurrence } = locate(event.target, event.clientX, event.clientY) ?? { id: '', occurrence: 0 };
    if (hovered?.id !== scope + id || hovered?.occurrence !== occurrence) {
      hovered = target(id, occurrence);
      draw();
    }
  },
  { passive: true },
);
document.addEventListener('pointerleave', () => {
  hovered = undefined;
  draw();
});
for (const type of ['click', 'dblclick', 'contextmenu']) {
  window.addEventListener(
    type,
    (event) => {
      if (interactive || window.parent === window || !(event.target instanceof Element) || event.target.closest('#studio-live-cursors')) {
        return;
      }
      if (type === 'click' && canvasMode === 'interact' && event instanceof MouseEvent) {
        selectThenPass(event, event.target);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type === 'click' && canvasDragged()) {
        return;
      }
      if (type === 'dblclick') {
        window.getSelection()?.removeAllRanges();
      }
      if (type === 'click' && !inFocus(event.target)) {
        post({ type: 'studio:outside-focus' });
        return;
      }
      if (!(event instanceof MouseEvent)) {
        return;
      }
      // A click measures afresh: the boxes kept for hover may be stale.
      forgetUnionBoxes();
      const id = pageId(event.target);
      if (type === 'contextmenu') {
        // Words beside a tagged sibling have no element to hit, so the menu
        // finds their run as Desktop's does (frameTargets.ts). Only the menu:
        // a click still selects the element.
        const text = id === undefined ? undefined : inlineTextPathAt(scope + id, event.clientX, event.clientY)?.slice(scope.length);
        const located =
          text === undefined
            ? locate(event.target, event.clientX, event.clientY)
            : { id: text, occurrence: occurrenceAt(id ?? '', event.clientX, event.clientY) };
        if (located) {
          post({
            type: 'avb:context-node',
            path: located.id,
            outside: false,
            occurrence: located.occurrence,
            left: event.clientX,
            top: event.clientY,
          });
        }
        return;
      }
      const located = locate(event.target, event.clientX, event.clientY);
      if (located) {
        post({ type: type === 'click' ? 'studio:select' : 'studio:open', id: located.id, occurrence: located.occurrence });
      }
    },
    true,
  );
}
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== studioOrigin) {
    return;
  }
  const data: unknown = event.data;
  if (!data || typeof data !== 'object' || !('type' in data)) {
    return;
  }
  if (data.type === 'studio:variant' && 'command' in data) {
    variants?.receive(data.command);
  }
  if (data.type === 'avb:set-vh' && 'px' in data) {
    freezeViewportHeight(data.px);
    return;
  }
  if (receiveLiveVariables(data)) {
    return;
  }
  if (receiveLiveRules(data)) {
    return;
  }
  receiveLiveText(data);
  receiveLiveNumericStyles(data);
  cursorPresence.receive(data);
  columnGuide.receive(data);
  if (data.type === 'studio:collaborators' && 'paths' in data && Array.isArray(data.paths)) {
    collaborators = data.paths.filter((path: unknown): path is string => typeof path === 'string' && path.length <= 1000).slice(0, 30);
  }
  if (data.type === 'studio:reveal') {
    revealSelection(data);
  }
  if (data.type === 'avb:query') {
    try {
      post(answerPreviewQuery(data, selectionCursor));
    } catch {
      /* Ignore invalid frame queries. */
    }
    return;
  }
  if (data.type === 'studio:scope' && 'scope' in data && typeof data.scope === 'string') {
    scope = data.scope;
    focusScope(data);
    labels = {};
    selected = undefined;
    hovered = undefined;
  }
  if (data.type === 'avb:optimistic-move' && 'move' in data) {
    showMove(data.move);
  }
  if (data.type === 'avb:move-revert') {
    revertCanvasMoves();
  }
  if (data.type === 'studio:labels' && 'labels' in data && Array.isArray(data.labels)) {
    setLabels(data.labels);
  }
  if ('id' in data && typeof data.id === 'string') {
    if (data.type === 'studio:select') {
      // A new selection leaves any earlier reveal stale (frameReveal.ts).
      cancelReveal();
      selected = target(
        data.id,
        'occurrence' in data && typeof data.occurrence === 'number' && Number.isSafeInteger(data.occurrence) ? Math.max(0, data.occurrence) : 0,
      );
    }
    if (data.type === 'studio:hover') {
      hovered = target(data.id, 0);
    }
  }
  const sitePages = parseCanvasSitePages(data);
  if (sitePages !== undefined) {
    setCanvasSitePages(sitePages);
  }
  const interaction = parseCanvasInteraction(data);
  if (interaction !== undefined) {
    // Only the canvas sends a mode, so this frame is the canvas whatever its URL says.
    interactive = false;
    canvasMode = interaction;
    setCanvasInteraction(interaction);
    paintSelectionCursor();
  }
  if (data.type === 'studio:interactive' && 'enabled' in data) {
    interactive = data.enabled === true;
    paintSelectionCursor();
  }
  draw();
});
// A reorder shown at once (frameMove.ts), in this frame's scope: the Navigator plans it
// over the open file's own paths. The selection, hover and labels follow the paths it
// renumbers, so the outline stays on the moved node until the server's answer names it.
listenForCanvasMoves();
function showMove(input: unknown): void {
  const parsed = parseCanvasMove(input);
  if (parsed === undefined) {
    return;
  }
  const move: CanvasMove = { ...parsed, scope };
  if (!showCanvasMove(move)) {
    return;
  }
  const renumbered = (outline: OutlineTarget | undefined): OutlineTarget | undefined =>
    outline === undefined ? undefined : { ...outline, id: renumberedCanvasPath(outline.id, move) };
  selected = renumbered(selected);
  hovered = renumbered(hovered);
  labels = Object.fromEntries(Object.entries(labels).map(([id, label]) => [renumberedCanvasPath(scope + id, move).slice(scope.length), label]));
}
// Interact mode: a click selects exactly as in select mode, then the page has it
// too, a link after the double-click window (frameInteraction.ts).
function selectThenPass(event: MouseEvent, element: Element): void {
  if (replayingLinkClick()) {
    return; // Selected when it was first clicked.
  }
  if (canvasDragged()) {
    return;
  }
  if (inFocus(element)) {
    forgetUnionBoxes();
    const located = locate(element, event.clientX, event.clientY);
    if (located) {
      post({ type: 'studio:select', id: located.id, occurrence: located.occurrence });
    }
  } else {
    post({ type: 'studio:outside-focus' });
  }
  holdLinkClick(event);
}
// The canvas cursor for the mode, the same rules as Desktop's (canvasCursorCSS): the
// editor's arrow, and in interact mode the pointer over what acts on a click. The root
// clip holds in both: Safari can scroll the iframe sideways even when the site's body
// clips overflow.
function paintSelectionCursor(): void {
  selectionCursor.replaceSync(`html { overflow-x: clip !important; }\n${canvasCursorCSS()}`);
  selectionCursor.disabled = interactive || window.parent === window;
}
function revealSelection(data: object): void {
  if (!('id' in data) || typeof data.id !== 'string') {
    return;
  }
  const occurrence =
    'occurrence' in data && typeof data.occurrence === 'number' && Number.isSafeInteger(data.occurrence) ? Math.max(0, Math.min(9999, data.occurrence)) : 0;
  // The Desktop canvas reveals through the same code (frameReports.ts): only when
  // the box is out of sight, only vertically, in the element's own scroller, with
  // instant scrolls that a smooth-scroll library on the site does not undo.
  revealPath(data.id.slice(0, 1000), occurrence);
}
function focusScope(data: object) {
  setTracking({
    paths: [],
    scope,
    focus: 'focus' in data && typeof data.focus === 'string' ? data.focus.slice(0, 1000) : '',
    occurrence:
      'occurrence' in data && typeof data.occurrence === 'number' && Number.isSafeInteger(data.occurrence) ? Math.max(0, Math.min(9999, data.occurrence)) : 0,
  });
  resetFocusCache();
}
document.addEventListener('avb:morphed', (event) => {
  applyLiveNumericStyles(event instanceof CustomEvent && event.detail instanceof Document ? event.detail : undefined);
  resetFocusCache();
  applyLiveText(event instanceof CustomEvent && event.detail instanceof Document ? event.detail : undefined);
  draw();
});
window.addEventListener('resize', draw);
window.addEventListener('scroll', draw, true);
const pageHeightObserver = new ResizeObserver(() => {
  draw();
  reportPageHeight();
});
function observePageHeight(): void {
  pageHeightObserver.disconnect();
  pageHeightObserver.observe(document.documentElement);
  pageHeightObserver.observe(document.body);
  reportPageHeight();
}
observePageHeight();
document.addEventListener('avb:morphed', observePageHeight);
// Readiness means the markup and preview client are initialized, not painted.
// Chrome pauses animation frames in hidden cross-origin iframes. Waiting for one
// before revealing this frame would deadlock the cloud canvas behind its loader.
// With the page it is, so a URL change that does not reload the frame keeps it ready (PreviewLoading.tsx).
post({ type: 'studio:preview-ready', path: location.pathname + location.search });

// The node under the pointer, by Desktop's rule for the space between a loop's
// items (frameTargets.ts, frameUnionTarget.ts). The browser can only name the
// element holding them, but the point is inside the loop's outline, so the loop
// takes it. Any element actually under the pointer still wins: the union is only
// asked about nodes below the one the element resolved to.
function locate(element: Element, x: number, y: number): { readonly id: string; readonly occurrence: number } | undefined {
  const id = pageId(element);
  const union = unionTargetAt(id === undefined ? undefined : scope + id, element, x, y);
  if (union !== undefined) {
    if (union.path.startsWith(scope)) {
      return { id: union.path.slice(scope.length), occurrence: union.occurrence };
    }
  }
  return id === undefined ? undefined : { id, occurrence: occurrenceAt(id, x, y) };
}
function depthOf(path: string): number {
  return path.split('.').length;
}
function occurrenceAt(id: string, x: number, y: number): number {
  const places = taggedPlaces(scope + id);
  const index = places.findIndex(({ rect }) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h);
  return Math.max(0, index);
}

function setLabels(values: readonly unknown[]) {
  labels = {};
  for (const input of values.slice(0, 10_000)) {
    const value: unknown = input;
    if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && 'label' in value && typeof value.label === 'string') {
      labels[value.id] = {
        label: value.label.slice(0, 100),
        component: 'component' in value && value.component === true,
        nodeKind: 'nodeKind' in value && typeof value.nodeKind === 'string' ? value.nodeKind : 'element',
      };
    }
  }
}
