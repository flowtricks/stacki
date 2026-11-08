import { useEffect, type RefObject } from 'react';
import { assert } from '../../../vendor/stacki/shared/core/assert';

// Reordering the Navigator by touch, on a phone or a tablet.
//
// The Navigator's rows drag with HTML drag and drop, which a mouse drives and a touch
// does not: Safari on iPhone starts no drag from a touch on a row, so a held touch here
// becomes one, by dispatching the same dragstart, dragover, drop and dragend the rows
// already handle. The drop goes through the same path as a mouse drop, including the
// canvas move that shows the new order at once (frameMove.ts).
//
// The touch is the panel's scroll until a hold says otherwise. A row allows a vertical
// pan (`touch-action: pan-y`), so a swipe scrolls the list; a press held still for
// HOLD_MS becomes a drag. Measured on the iOS Simulator (Safari, iOS 26): with no
// non-passive touch listener, the first touchmove after a hold is not cancelable, the
// list scrolls, and Safari sends pointercancel, which ended the drag before it moved;
// that was the report ("drag and drop isn't working on iphone"). Cancelling touchmove
// once the drag has started keeps the touch: no scroll, no pointercancel, and the
// pointerup arrives. A move past SLOP_PX before the hold is a scroll, and the drag
// never starts. Near the list's top or bottom edge, the list scrolls itself.
//
// A mouse or pen is left alone: their drags are the browser's own.

export const TOUCH_TREE = {
  /** A held press becomes a drag: past a tap, short of the platform long press (~500 ms). */
  holdMs: 280,
  /** Travel before the hold that means a scroll. A finger settling wobbles a few pixels. */
  slopPx: 8,
  /** The band at the list's top and bottom where a dragging finger scrolls it. */
  edgePx: 48,
  /** The fastest the list scrolls under a finger at its very edge, per frame. */
  scrollPxPerFrameMax: 16,
  /** Frames one drag may auto-scroll: a minute at 60 Hz, then the finger must move. */
  autoScrollFramesMax: 3_600,
} as const satisfies Record<string, number>;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** A press held still, or one that moved enough to be the list's scroll. */
export function pressOutcome(start: Point, now: Point): 'holding' | 'scrolling' {
  assert(Number.isFinite(now.x), 'pressOutcome: the finger has a position');
  assert(Number.isFinite(now.y), 'pressOutcome: the finger has a position');
  return Math.hypot(now.x - start.x, now.y - start.y) > TOUCH_TREE.slopPx ? 'scrolling' : 'holding';
}

/** How far the list scrolls this frame for a finger at `y`: negative up, positive down. */
export function autoScrollStep(input: { readonly y: number; readonly top: number; readonly bottom: number }): number {
  assert(input.bottom >= input.top, 'autoScrollStep: a list has a top above its bottom');
  assert(Number.isFinite(input.y), 'autoScrollStep: the finger has a position');
  const band = Math.min(TOUCH_TREE.edgePx, Math.floor((input.bottom - input.top) / 3));
  if (band <= 0) {
    return 0;
  }
  const speed = (depth: number): number => Math.ceil((Math.min(band, Math.max(0, depth)) / band) * TOUCH_TREE.scrollPxPerFrameMax);
  if (input.y < input.top + band) {
    return -speed(input.top + band - input.y);
  }
  if (input.y > input.bottom - band) {
    return speed(input.y - (input.bottom - band));
  }
  return 0;
}

export function useTouchTree(root: RefObject<HTMLDivElement>) {
  useEffect(() => {
    const element = root.current;
    if (!element) {
      return;
    }
    return touchTree(element);
  }, [root]);
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pressed'; readonly pointerId: number; readonly source: HTMLElement; readonly start: Point }
  | { readonly kind: 'dragging'; readonly pointerId: number; readonly source: HTMLElement; readonly data: DataTransfer; readonly point: Point };

/** Installs the touch drag on a Navigator; returns what removes it. */
export function touchTree(element: HTMLElement): () => void {
  let phase: Phase = { kind: 'idle' };
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let frames = 0;
  // Only this module changes the phase; the handlers below read it and call these.
  const reset = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
    element.classList.remove('touch-pressing', 'touch-dragging');
    phase = { kind: 'idle' };
  };
  const start = () => {
    if (phase.kind !== 'pressed') {
      return;
    }
    const data = newTransfer();
    if (data === undefined) {
      reset();
      return;
    }
    const begun = phase.source.dispatchEvent(dragEvent('dragstart', data, phase.start));
    if (!begun) {
      reset(); // The row refused the drag.
      return;
    }
    phase = { kind: 'dragging', pointerId: phase.pointerId, source: phase.source, data, point: phase.start };
    element.classList.add('touch-dragging');
    frames = 0;
    frame = requestAnimationFrame(scrollFrame);
  };
  const over = (point: Point, data: DataTransfer) => {
    document.elementFromPoint(point.x, point.y)?.dispatchEvent(dragEvent('dragover', data, point));
  };
  // While a finger rests near an edge, the list scrolls and what is under it is asked again.
  const scrollFrame = () => {
    frame = undefined;
    if (phase.kind !== 'dragging' || frames >= TOUCH_TREE.autoScrollFramesMax) {
      return;
    }
    frames += 1;
    const scroller = scrollerOf(phase.source.isConnected ? phase.source : element);
    if (scroller !== undefined) {
      const box = scroller.getBoundingClientRect();
      const step = autoScrollStep({ y: phase.point.y, top: box.top, bottom: box.bottom });
      if (step !== 0) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + step;
        if (scroller.scrollTop !== before) {
          over(phase.point, phase.data);
        }
      }
    }
    frame = requestAnimationFrame(scrollFrame);
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !event.isPrimary || !(event.target instanceof Element)) {
      return;
    }
    const source = event.target.closest<HTMLElement>('[draggable="true"]');
    if (source === null || !element.contains(source)) {
      return;
    }
    reset();
    phase = { kind: 'pressed', pointerId: event.pointerId, source, start: { x: event.clientX, y: event.clientY } };
    // Long-press callouts, text selection and the system's own drag stay off the rows
    // while a press may become a drag (studio.css).
    element.classList.add('touch-pressing');
    holdTimer = setTimeout(start, TOUCH_TREE.holdMs);
  };
  const move = (event: PointerEvent) => {
    if (phase.kind === 'idle' || event.pointerId !== phase.pointerId) {
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    if (phase.kind === 'pressed') {
      if (pressOutcome(phase.start, point) === 'scrolling') {
        reset();
      }
      return;
    }
    event.preventDefault();
    phase = { ...phase, point };
    over(point, phase.data);
  };
  // The one listener that can keep the touch from becoming the list's scroll.
  const touchMove = (event: TouchEvent) => {
    if (phase.kind === 'dragging' && event.cancelable) {
      event.preventDefault();
    }
  };
  const up = (event: PointerEvent) => {
    if (phase.kind === 'idle' || event.pointerId !== phase.pointerId) {
      return;
    }
    if (phase.kind === 'dragging') {
      const { source, data } = phase;
      const point = { x: event.clientX, y: event.clientY };
      over(point, data);
      document.elementFromPoint(point.x, point.y)?.dispatchEvent(dragEvent('drop', data, point));
      // The drop may have re-rendered the row away; the window still hears the end.
      (source.isConnected ? source : window).dispatchEvent(dragEvent('dragend', data, point));
    }
    reset();
  };
  const cancel = (event: PointerEvent) => {
    if (phase.kind === 'idle' || event.pointerId !== phase.pointerId) {
      return;
    }
    if (phase.kind === 'dragging') {
      const { source, data, point } = phase;
      (source.isConnected ? source : window).dispatchEvent(dragEvent('dragend', data, point));
    }
    reset();
  };
  const menu = (event: Event) => {
    if (phase.kind !== 'idle') {
      event.preventDefault();
    }
  };
  element.addEventListener('pointerdown', down);
  element.addEventListener('touchmove', touchMove, { passive: false });
  element.addEventListener('contextmenu', menu);
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  return () => {
    reset();
    element.removeEventListener('pointerdown', down);
    element.removeEventListener('touchmove', touchMove);
    element.removeEventListener('contextmenu', menu);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  };
}

function newTransfer(): DataTransfer | undefined {
  try {
    return new DataTransfer();
  } catch {
    return undefined; // No constructor (Safari before 14.1): the drag cannot carry its row.
  }
}

// A drag event carrying `data`. Where the engine's DragEvent drops a constructed
// DataTransfer, the transfer is attached to a mouse event of the same type, which is
// all React reads.
function dragEvent(type: 'dragstart' | 'dragover' | 'drop' | 'dragend', data: DataTransfer, point: Point): Event {
  const init = { bubbles: true, cancelable: type !== 'dragend', clientX: point.x, clientY: point.y };
  const event = new DragEvent(type, { ...init, dataTransfer: data });
  if (event.dataTransfer === data) {
    return event;
  }
  const carried = new MouseEvent(type, init);
  Object.defineProperty(carried, 'dataTransfer', { value: data });
  return carried;
}

// The nearest ancestor of the dragged row that scrolls vertically: the Navigator's list.
function scrollerOf(row: HTMLElement): HTMLElement | undefined {
  let depth = 0;
  for (let node: HTMLElement | undefined = row; node !== undefined; node = node.parentElement ?? undefined) {
    depth += 1;
    assert(depth <= SCROLLER_DEPTH_MAX, 'scrollerOf: the panel nests inside the walk bound');
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') {
      if (node.scrollHeight > node.clientHeight) {
        return node;
      }
    }
  }
  return undefined;
}

// The editor's own markup around a Navigator row, far shallower than any page.
const SCROLLER_DEPTH_MAX = 512;
