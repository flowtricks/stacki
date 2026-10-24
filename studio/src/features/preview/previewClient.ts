import {
  freezeViewportHeight,
  report as reportPageHeight,
} from '../../../vendor/stacki/electron/preload/frameViewport';
import { receiveLiveNumericStyles, applyLiveNumericStyles } from './liveNumericStyles';
import { receiveLiveText, applyLiveText } from './liveTextClient';
import { installCursorPresence } from '../collaboration/cursorClient';
import { receiveRenderPush } from './renderPushClient';
import { rectsForPath } from '../../../vendor/stacki/electron/preload/frameMeasure';
import { startGuide } from '../../../vendor/stacki/electron/preload/frameGuide';
import {
  taggedPlaces,
  inFocus,
  setTracking,
  resetFocusCache,
} from '../../../vendor/stacki/electron/preload/frameRegions';
import { forwardPreviewKeys } from './previewKeys';
import { forwardStyleModifiers } from './styleModifiers';
import { answerPreviewQuery } from './previewQueries';
import { createHotContext } from '/@vite/client';
import { createOutlines, type OutlineTarget } from './previewOutlines';
const studioOrigin =
  document.querySelector<HTMLMetaElement>('meta[name=studio-parent-origin]')?.content ||
  location.origin;
const post = (message: unknown) => window.parent.postMessage(message, studioOrigin);
const cursorPresence = installCursorPresence(post);
const columnGuide = startGuide(post);
// This async module is appended after page markup. Reveal that markup without
// waiting for slow images or the separate morph module to finish loading.
requestAnimationFrame(() => post({ type: 'studio:preview-ready' }));
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
let selected: OutlineTarget | undefined;
let hovered: OutlineTarget | undefined;
let scope = '';
let interactive = !location.hash.includes('avb-design');
const selectionCursor = new CSSStyleSheet();
selectionCursor.replaceSync('* { cursor: default !important; }');
selectionCursor.disabled = interactive || window.parent === window;
document.adoptedStyleSheets = [...document.adoptedStyleSheets, selectionCursor];
let collaborators: string[] = [];
forwardPreviewKeys(post, () => interactive);
const reportNavigation = () =>
  post({ type: 'avb:navigated', path: location.pathname + location.search });
reportNavigation();
window.addEventListener('popstate', reportNavigation);
document.addEventListener('astro:page-load', reportNavigation);
document.addEventListener('keydown', (event) => {
  if (interactive && event.key === 'Escape' && !event.isComposing) {
    event.preventDefault();
    post({ type: 'studio:exit-preview' });
  }
});
forwardStyleModifiers(post);
let labels: Record<string, { label: string; component: boolean; nodeKind: string }> = {};
const paint = createOutlines(post);
const draw = () =>
  paint(
    interactive ? undefined : selected,
    interactive ? undefined : hovered,
    interactive ? [] : collaborators,
  );
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
    const id = ids
      .filter((value) => value.startsWith(scope) && /^\d+(\.\d+)*$/.test(value.slice(scope.length)))
      .at(-1);
    if (id) {
      return id.slice(scope.length);
    }
  }
  return undefined;
}
document.addEventListener(
  'pointermove',
  (event) => {
    if (
      interactive ||
      !(event.target instanceof Element) ||
      event.target.closest('#studio-live-cursors')
    ) {
      return;
    }
    const id = pageId(event.target) ?? '';
    const occurrence = occurrenceAt(id, event.clientX, event.clientY);
    if (hovered?.id !== scope + id || hovered?.occurrence !== occurrence) {
      hovered = target(id, occurrenceAt(id, event.clientX, event.clientY));
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
  document.addEventListener(
    type,
    (event) => {
      if (
        interactive ||
        window.parent === window ||
        !(event.target instanceof Element) ||
        event.target.closest('#studio-live-cursors')
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type === 'dblclick') {
        window.getSelection()?.removeAllRanges();
      }
      if (type === 'click' && !inFocus(event.target)) {
        post({ type: 'studio:outside-focus' });
        return;
      }
      const id = pageId(event.target);
      if (type === 'contextmenu') {
        if (id && event instanceof MouseEvent) {
          post({
            type: 'avb:context-node',
            path: id,
            outside: false,
            occurrence: occurrenceAt(id, event.clientX, event.clientY),
            left: event.clientX,
            top: event.clientY,
          });
        }
        return;
      }
      if (id) {
        post({
          type: type === 'click' ? 'studio:select' : 'studio:open',
          id,
          occurrence:
            event instanceof MouseEvent ? occurrenceAt(id, event.clientX, event.clientY) : 0,
        });
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
  receiveLiveText(data);
  receiveLiveNumericStyles(data);
  cursorPresence.receive(data);
  columnGuide.receive(data);
  if (data.type === 'studio:collaborators' && 'paths' in data && Array.isArray(data.paths)) {
    collaborators = data.paths
      .filter((path: unknown): path is string => typeof path === 'string' && path.length <= 1000)
      .slice(0, 30);
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
  if (data.type === 'studio:labels' && 'labels' in data && Array.isArray(data.labels)) {
    setLabels(data.labels);
  }
  if ('id' in data && typeof data.id === 'string') {
    if (data.type === 'studio:select') {
      selected = target(
        data.id,
        'occurrence' in data &&
          typeof data.occurrence === 'number' &&
          Number.isSafeInteger(data.occurrence)
          ? Math.max(0, data.occurrence)
          : 0,
      );
    }
    if (data.type === 'studio:hover') {
      hovered = target(data.id, 0);
    }
  }
  if (data.type === 'studio:interactive' && 'enabled' in data) {
    interactive = data.enabled === true;
    selectionCursor.disabled = interactive || window.parent === window;
  }
  draw();
});
function revealSelection(data: object): void {
  if (!('id' in data) || typeof data.id !== 'string') {
    return;
  }
  const occurrence =
    'occurrence' in data && typeof data.occurrence === 'number' ? data.occurrence : 0;
  const rect = rectsForPath(data.id)?.[occurrence];
  if (rect) {
    window.scrollBy({
      left: rect.x - innerWidth / 2 + rect.w / 2,
      top: rect.y - innerHeight / 2 + rect.h / 2,
      behavior: 'instant',
    });
  }
}
function focusScope(data: object) {
  setTracking({
    paths: [],
    scope,
    focus: 'focus' in data && typeof data.focus === 'string' ? data.focus.slice(0, 1000) : '',
    occurrence:
      'occurrence' in data &&
      typeof data.occurrence === 'number' &&
      Number.isSafeInteger(data.occurrence)
        ? Math.max(0, Math.min(9999, data.occurrence))
        : 0,
  });
  resetFocusCache();
}
document.addEventListener('avb:morphed', (event) => {
  applyLiveNumericStyles(
    event instanceof CustomEvent && event.detail instanceof Document ? event.detail : undefined,
  );
  resetFocusCache();
  applyLiveText();
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

function occurrenceAt(id: string, x: number, y: number): number {
  const places = taggedPlaces(scope + id);
  const index = places.findIndex(
    ({ rect }) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h,
  );
  return Math.max(0, index);
}

function setLabels(values: readonly unknown[]) {
  labels = {};
  for (const input of values.slice(0, 10_000)) {
    const value: unknown = input;
    if (
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'label' in value &&
      typeof value.label === 'string'
    ) {
      labels[value.id] = {
        label: value.label.slice(0, 100),
        component: 'component' in value && value.component === true,
        nodeKind:
          'nodeKind' in value && typeof value.nodeKind === 'string' ? value.nodeKind : 'element',
      };
    }
  }
}
