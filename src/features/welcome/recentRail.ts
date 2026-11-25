import { assert } from '../../../shared/core/assert';

// The recents rail fades its trailing edge to say "there is more this way".
// Once the user has reached the end there is nothing more, and a fade there
// would leave the last card half hidden, so the fade follows the scroll
// position instead of being painted unconditionally.

// Sub-pixel scroll positions (zoom, fractional device pixels) leave a rail that
// is at its end a fraction of a pixel short of scrollWidth.
const RAIL_END_TOLERANCE_PX = 1;

export const RAIL_MORE_ATTRIBUTE = 'data-more';

export function railHasMoreEnd(scrollLeftPx: number, clientWidthPx: number, scrollWidthPx: number): boolean {
  assert(Number.isFinite(scrollLeftPx), 'recentRail: scrollLeft must be finite');
  assert(Number.isFinite(clientWidthPx), 'recentRail: clientWidth must be finite');
  assert(Number.isFinite(scrollWidthPx), 'recentRail: scrollWidth must be finite');
  assert(clientWidthPx >= 0, 'recentRail: clientWidth must not be negative');
  const remainingPx = scrollWidthPx - clientWidthPx - scrollLeftPx;
  return remainingPx > RAIL_END_TOLERANCE_PX;
}

// How the rail's scrollbar behaves. macOS draws overlay scrollbars that show
// only while scrolling, and the rail matches it there; other platforms keep a
// thin bar that is always visible.
export type RailScrollbar = 'overlay' | 'classic';

export const RAIL_SCROLLBAR_ATTRIBUTE = 'data-scrollbar';
export const RAIL_SCROLLING_ATTRIBUTE = 'data-scrolling';

// As macOS: the bar stays for about a second after the last scroll.
export const RAIL_SCROLLBAR_HIDE_DELAY_MS = 1000;

export function railScrollbarFor(platform: string): RailScrollbar {
  assert(platform.length > 0, 'recentRail: platform must be named');
  if (platform === 'darwin') {
    return 'overlay';
  }
  return 'classic';
}

export interface RailWatchOptions {
  readonly scrollbar: RailScrollbar;
  readonly hideDelayMs?: number;
}

// Mirrors the scroll position into attributes on the rail. It writes them
// directly rather than through React state: a scroll is not a render, and
// re-rendering the cards on every scroll event is wasted work. It never writes
// scrollLeft — the user's position is theirs.
export function watchRailEdges(rail: HTMLElement, options: RailWatchOptions): () => void {
  assert(rail.isConnected, 'recentRail: rail must be mounted before it is watched');
  const hideDelayMs = options.hideDelayMs ?? RAIL_SCROLLBAR_HIDE_DELAY_MS;
  assert(Number.isFinite(hideDelayMs), 'recentRail: hide delay must be finite');
  assert(hideDelayMs >= 0, 'recentRail: hide delay must not be negative');
  // The observers and timers come from the rail's own window, which is the one
  // it is laid out in. A DOM without ResizeObserver still gets the scroll and
  // card-list updates.
  const view = rail.ownerDocument.defaultView;
  assert(view !== null, 'recentRail: rail must belong to a window');
  rail.setAttribute(RAIL_SCROLLBAR_ATTRIBUTE, options.scrollbar);
  const overlay = options.scrollbar === 'overlay' ? watchRailOverlay(rail, view, hideDelayMs) : undefined;
  const update = (): void => {
    if (railHasMoreEnd(rail.scrollLeft, rail.clientWidth, rail.scrollWidth)) {
      rail.setAttribute(RAIL_MORE_ATTRIBUTE, 'end');
    } else {
      rail.removeAttribute(RAIL_MORE_ATTRIBUTE);
    }
  };
  update();
  rail.addEventListener('scroll', update, { passive: true });
  // Cards are added, removed, and the window is resized without a scroll
  // event; any of those can move the end into or out of view.
  const resizeObserver = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(update) : undefined;
  resizeObserver?.observe(rail);
  const mutationObserver = new view.MutationObserver(update);
  mutationObserver.observe(rail, { childList: true });
  return () => {
    rail.removeEventListener('scroll', update);
    resizeObserver?.disconnect();
    mutationObserver.disconnect();
    overlay?.();
  };
}

// The overlay bar shows while any reason for it holds: a scroll within the
// last hide delay, the pointer over the bar's strip, or a drag that started
// there. The fade itself is CSS, keyed on the attribute.
function watchRailOverlay(rail: HTMLElement, view: Window, hideDelayMs: number): () => void {
  assert(rail.getAttribute(RAIL_SCROLLBAR_ATTRIBUTE) === 'overlay', 'recentRail: overlay watcher on a classic rail');
  let hideTimer: number | undefined;
  let hovered = false;
  let held = false;
  const visible = (): boolean => {
    if (hideTimer !== undefined) {
      return true;
    }
    if (hovered) {
      return true;
    }
    return held;
  };
  const render = (): void => {
    if (visible()) {
      rail.setAttribute(RAIL_SCROLLING_ATTRIBUTE, '');
    } else {
      rail.removeAttribute(RAIL_SCROLLING_ATTRIBUTE);
    }
  };
  const scrolled = (): void => {
    if (hideTimer !== undefined) {
      view.clearTimeout(hideTimer);
    }
    hideTimer = view.setTimeout(() => {
      hideTimer = undefined;
      render();
    }, hideDelayMs);
    render();
  };
  // The strip is whatever the scrollbar takes below the content box: zero
  // when the cards fit and there is no bar.
  const overStrip = (event: PointerEvent): boolean => {
    const stripPx = rail.offsetHeight - rail.clientHeight;
    if (stripPx > 0) {
      return event.clientY >= rail.getBoundingClientRect().bottom - stripPx;
    }
    return false;
  };
  const moved = (event: PointerEvent): void => {
    hovered = overStrip(event);
    render();
  };
  const left = (): void => {
    hovered = false;
    render();
  };
  const pressed = (event: PointerEvent): void => {
    held = overStrip(event);
    render();
  };
  const released = (): void => {
    held = false;
    render();
  };
  rail.addEventListener('scroll', scrolled, { passive: true });
  rail.addEventListener('pointermove', moved);
  rail.addEventListener('pointerleave', left);
  rail.addEventListener('pointerdown', pressed);
  // A drag ends wherever the pointer is let go, which is often off the rail.
  view.addEventListener('pointerup', released);
  view.addEventListener('pointercancel', released);
  return () => {
    if (hideTimer !== undefined) {
      view.clearTimeout(hideTimer);
    }
    rail.removeEventListener('scroll', scrolled);
    rail.removeEventListener('pointermove', moved);
    rail.removeEventListener('pointerleave', left);
    rail.removeEventListener('pointerdown', pressed);
    view.removeEventListener('pointerup', released);
    view.removeEventListener('pointercancel', released);
  };
}
