// Scrolling the canvas for a Stacki app (`canvas.scrollTo`, docs/apps.md): to a
// point of the page, or to align an element the editor just measured. The
// editor says `{ type: 'avb:app-scroll', space, x, y, w, h, block }`: `space`
// is `page` for a point in the document's CSS pixels, or `viewport` for a box
// measured in the viewport now; `block` puts it at the top (`start`) or in the
// middle (`center`). The page scrolls at once, so the next measurement is where
// it landed. Desktop's preload (frameQueries.ts) and Studio's preview client
// both hand host messages here.
//
// The same channel carries a wheel that landed on an app's overlay item
// (`avb:app-wheel`, AppOverlayLayer.tsx). An interactive or draggable item sits
// over the frame and takes the pointer for its clicks, so the wheel under it is
// the editor's, not the page's; the editor hands it here and the page gets it
// as if it had landed on the page itself. The element under the point hears a
// `wheel` first, so a page that handles wheels (a carousel, a map, a pinch zoom)
// still can; one that does not cancel it scrolls the nearest scroller that can
// move that way, else the page. A pinch (`ctrlKey`) never scrolls: over the
// frame it is the page's to zoom or ignore, so it is here too.

/** A coordinate past this is not a point on any page (APP_RPC_LIMITS.coordinatePxMax). */
const COORDINATE_PX_MAX = 1_000_000;

interface AppScroll {
  readonly space: 'page' | 'viewport';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly block: 'start' | 'center';
}

/** Scroll containers a forwarded wheel looks through, from the element under the point up. */
const SCROLL_ANCESTORS_MAX = 256;

/** Chromium's pixels per wheel line (kPixelsPerLineStep), for a wheel that counts lines. */
const WHEEL_LINE_PX = 40;

/** A wheel's delta modes (WheelEvent.DOM_DELTA_*): pixels, lines, pages. */
const WHEEL_DELTA_MODES = [0, 1, 2] as const;
type WheelDeltaMode = (typeof WHEEL_DELTA_MODES)[number];

/** A wheel forwarded from an overlay item, at a point of the canvas viewport. */
export interface AppWheel {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: WheelDeltaMode;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** Applies an app scroll message; false when the message is not one. */
export function receiveAppScroll(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Reflect.get(data, 'type') !== 'avb:app-scroll') {
    return false;
  }
  const scroll = parseAppScroll(data);
  if (scroll === undefined) {
    return true; // Ours, but malformed: the page stays where it is.
  }
  const target = scrollTarget(scroll, { x: window.scrollX, y: window.scrollY }, { width: window.innerWidth, height: window.innerHeight });
  window.scrollTo({ left: target.left, top: target.top, behavior: 'instant' });
  return true;
}

/** Where the page scrolls to, before the browser clamps it to the page: pure, for the tests. */
export function scrollTarget(
  scroll: AppScroll,
  scrolled: { readonly x: number; readonly y: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } {
  const originX = scroll.space === 'viewport' ? scrolled.x : 0;
  const originY = scroll.space === 'viewport' ? scrolled.y : 0;
  if (scroll.block === 'start') {
    return { left: originX + scroll.x, top: originY + scroll.y };
  }
  return { left: originX + scroll.x + scroll.w / 2 - viewport.width / 2, top: originY + scroll.y + scroll.h / 2 - viewport.height / 2 };
}

/** Applies a forwarded wheel; false when the message is not one. */
export function receiveAppWheel(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Reflect.get(data, 'type') !== 'avb:app-wheel') {
    return false;
  }
  const wheel = parseAppWheel(data);
  if (wheel === undefined) {
    return true; // Ours, but malformed: nothing moves.
  }
  const target = document.elementFromPoint(wheel.x, wheel.y) ?? document.documentElement;
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: wheel.x,
    clientY: wheel.y,
    deltaX: wheel.deltaX,
    deltaY: wheel.deltaY,
    deltaMode: wheel.deltaMode,
    ctrlKey: wheel.ctrlKey,
    shiftKey: wheel.shiftKey,
    altKey: wheel.altKey,
    metaKey: wheel.metaKey,
  });
  const unhandled = target.dispatchEvent(event);
  if (unhandled) {
    if (wheel.ctrlKey) {
      return true; // A pinch the page did not take: it zooms nothing, as over the frame.
    }
    const pixels = wheelPixels(wheel, { width: window.innerWidth, height: window.innerHeight });
    const scroller = wheelScroller(target, pixels);
    if (scroller === undefined) {
      window.scrollBy({ left: pixels.x, top: pixels.y, behavior: 'instant' });
    } else {
      scroller.scrollBy({ left: pixels.x, top: pixels.y, behavior: 'instant' });
    }
  }
  return true;
}

/**
 * How far a wheel moves the page, in CSS pixels: lines and pages turned into
 * pixels, and a vertical wheel with Shift held turned sideways, as browsers do
 * with a mouse that has no horizontal wheel. Pure, for the tests.
 */
export function wheelPixels(
  wheel: Pick<AppWheel, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey'>,
  viewport: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const sideways = wheel.shiftKey && wheel.deltaX === 0;
  const deltaX = sideways ? wheel.deltaY : wheel.deltaX;
  const deltaY = sideways ? 0 : wheel.deltaY;
  switch (wheel.deltaMode) {
    case 0:
      return { x: deltaX, y: deltaY };
    case 1:
      return { x: deltaX * WHEEL_LINE_PX, y: deltaY * WHEEL_LINE_PX };
    case 2:
      return { x: deltaX * viewport.width, y: deltaY * viewport.height };
    default: {
      const exhaustive: never = wheel.deltaMode;
      return exhaustive;
    }
  }
}

// The nearest element from the target up that scrolls itself and can still move the way the wheel goes.
// The root and body scroll as the window, which is the fallback.
function wheelScroller(target: Element, pixels: { readonly x: number; readonly y: number }): Element | undefined {
  let element: Element | undefined = target;
  for (let depth = 0; depth < SCROLL_ANCESTORS_MAX; depth += 1) {
    if (element === undefined || element === document.documentElement || element === document.body) {
      return undefined;
    }
    if (canScroll(element, pixels)) {
      return element;
    }
    element = element.parentElement ?? undefined;
  }
  return undefined;
}

function canScroll(element: Element, pixels: { readonly x: number; readonly y: number }): boolean {
  const style = getComputedStyle(element);
  if (pixels.y !== 0 && scrolls(style.overflowY) && roomFor(pixels.y, element.scrollTop, element.scrollHeight - element.clientHeight)) {
    return true;
  }
  if (pixels.x !== 0 && scrolls(style.overflowX)) {
    return roomFor(pixels.x, element.scrollLeft, element.scrollWidth - element.clientWidth);
  }
  return false;
}

function scrolls(overflow: string): boolean {
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
}

// Whether a scroll position has room left in the delta's direction.
function roomFor(delta: number, position: number, positionMax: number): boolean {
  if (delta < 0) {
    return position > 0;
  }
  return position < positionMax - 0.5;
}

function parseAppWheel(data: object): AppWheel | undefined {
  const x = coordinateOf(Reflect.get(data, 'x'));
  const y = coordinateOf(Reflect.get(data, 'y'));
  const deltaX = coordinateOf(Reflect.get(data, 'deltaX'));
  const deltaY = coordinateOf(Reflect.get(data, 'deltaY'));
  const deltaMode = WHEEL_DELTA_MODES.find((mode) => mode === Reflect.get(data, 'deltaMode'));
  if (x === undefined || y === undefined || deltaX === undefined || deltaY === undefined || deltaMode === undefined) {
    return undefined;
  }
  const ctrlKey: unknown = Reflect.get(data, 'ctrlKey');
  const shiftKey: unknown = Reflect.get(data, 'shiftKey');
  const altKey: unknown = Reflect.get(data, 'altKey');
  const metaKey: unknown = Reflect.get(data, 'metaKey');
  if (typeof ctrlKey !== 'boolean' || typeof shiftKey !== 'boolean' || typeof altKey !== 'boolean' || typeof metaKey !== 'boolean') {
    return undefined;
  }
  return { x, y, deltaX, deltaY, deltaMode, ctrlKey, shiftKey, altKey, metaKey };
}

function parseAppScroll(data: object): AppScroll | undefined {
  const space: unknown = Reflect.get(data, 'space');
  const block: unknown = Reflect.get(data, 'block');
  const x = coordinateOf(Reflect.get(data, 'x'));
  const y = coordinateOf(Reflect.get(data, 'y'));
  const width = coordinateOf(Reflect.get(data, 'w'));
  const height = coordinateOf(Reflect.get(data, 'h'));
  if (space !== 'page' && space !== 'viewport') {
    return undefined;
  }
  if (block !== 'start' && block !== 'center') {
    return undefined;
  }
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  if (width < 0 || height < 0) {
    return undefined;
  }
  return { space, x, y, w: width, h: height, block };
}

function coordinateOf(input: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return undefined;
  }
  return Math.abs(input) <= COORDINATE_PX_MAX ? input : undefined;
}
