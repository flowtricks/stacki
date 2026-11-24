// The canvas's own scrollbar for the page in a frame (shared/properties/canvasScrollbar.ts): a sized frame, and each
// frame of the all-breakpoints canvas.
//
// The frame draws no scrollbar of its own, so the page keeps the frame's whole width, as on a phone; this bar shows
// where the person is in the page instead, and moves it. It sits in the gutter just outside the frame's inline end,
// solid, never over the page: a framed device has its gutter, and a frame that fills the canvas (Desktop) keeps one
// for it (previewViewport.ts). An all-breakpoints frame grows to its page's height, so its bar shows only for a page
// taller than that frame may grow.
//
// The frame is told to hide its own bar on every page load; it reports its scroll at most once per animation frame;
// a drag or a click on the track tells it where to scroll.

import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  CANVAS_SCROLLBAR_LIMITS,
  canvasScrollbarMessage,
  pageScrollToMessage,
  parsePageScrollMessage,
  scrollThumb,
  scrollTopForThumb,
  type PageScroll,
} from '../../../shared/properties/canvasScrollbar';
import { usePointerDrag } from '../../ui/usePointerDrag';

/** The bar's look in screen pixels, whatever the canvas zoom: the frame's scale is divided out. */
const BAR_SCREEN_PX = {
  /** The thumb's width. */
  width: 5,
  /** The gap between the frame's edge and the thumb. Gap and thumb fit the narrowest gutter, a fluid frame's 9px. */
  gap: 2,
} as const satisfies Record<string, number>;

export interface CanvasScrollbarProps {
  /** The element that holds the page's iframe, the bar's positioned parent. */
  readonly frameRef: RefObject<HTMLDivElement>;
  /** The frame's scale on screen: 1 or less on a sized frame, the zoom on the all-breakpoints canvas. */
  readonly scale: number;
}

export function CanvasScrollbar(props: CanvasScrollbarProps) {
  assert(props.scale > 0, 'CanvasScrollbar: the frame has a scale');
  assert(Number.isFinite(props.scale), 'CanvasScrollbar: the frame scale is finite');
  const scroll = usePageScroll(props.frameRef);
  const startDrag = usePointerDrag();
  if (scroll === undefined) {
    return undefined;
  }
  if (scroll.chromium) {
    return undefined; // The frame draws Chromium's own bar.
  }
  // The track spans the frame's height, which is the page's view height, in the frame's own pixels.
  const trackPx = scroll.viewHeightPx;
  const lengthPxMin = CANVAS_SCROLLBAR_LIMITS.thumbScreenPxMin / props.scale;
  const thumb = scrollThumb(scroll, trackPx, lengthPxMin);
  if (thumb === undefined) {
    return undefined; // The page does not scroll.
  }
  const widthPx = BAR_SCREEN_PX.width / props.scale;
  const endPx = -(BAR_SCREEN_PX.gap / props.scale) - widthPx;
  const scrollTo = (offsetPx: number): void => {
    const topPx = scrollTopForThumb(scroll, trackPx, lengthPxMin, offsetPx);
    frameOf(props.frameRef)?.contentWindow?.postMessage(pageScrollToMessage(topPx), frameOrigin(props.frameRef));
  };
  // A press on the thumb drags it; a press on the track puts the thumb's middle under the pointer, then drags.
  const press = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const track = event.currentTarget.getBoundingClientRect();
    const pointerPx = (event.clientY - track.top) / props.scale;
    const onThumb = pointerPx >= thumb.offsetPx && pointerPx <= thumb.offsetPx + thumb.lengthPx;
    const grabPx = onThumb ? pointerPx - thumb.offsetPx : thumb.lengthPx / 2;
    if (!onThumb) {
      scrollTo(pointerPx - grabPx);
    }
    const frame = props.frameRef.current;
    frame?.classList.add('canvas-scrolling'); // The iframe would take the pointer as the drag crosses it.
    startDrag(event, {
      onMove: (move) => scrollTo((move.clientY - track.top) / props.scale - grabPx),
      onEnd: () => frame?.classList.remove('canvas-scrolling'),
    });
  };
  return (
    <div className="canvas-scrollbar" style={{ width: widthPx, insetInlineEnd: endPx }} onPointerDown={press} aria-hidden="true">
      <div className="canvas-scrollbar-thumb" style={{ top: thumb.offsetPx, height: thumb.lengthPx, borderRadius: widthPx }} />
    </div>
  );
}

// The page's scroll as the frame last reported it. Each page load is told to hide its own bar, and so is the page
// already there when the bar mounts; a load listens in the capture phase, since `load` does not bubble.
function usePageScroll(frameRef: RefObject<HTMLDivElement>): PageScroll | undefined {
  const [scroll, setScroll] = useState<PageScroll | undefined>(undefined);
  useEffect(() => {
    const holder = frameRef.current;
    if (holder === null) {
      return undefined;
    }
    const tell = (): void => {
      frameOf(frameRef)?.contentWindow?.postMessage(canvasScrollbarMessage(), frameOrigin(frameRef));
    };
    const loaded = (event: Event): void => {
      if (event.target === frameOf(frameRef)) {
        setScroll(undefined); // A new page: nothing is known of its scroll until it reports.
        tell();
      }
    };
    const heard = (event: MessageEvent<unknown>): void => {
      const frame = frameOf(frameRef);
      if (frame === undefined || event.source !== frame.contentWindow) {
        return;
      }
      const message = parsePageScrollMessage(event.data);
      if (message !== undefined) {
        setScroll({ topPx: message.topPx, heightPx: message.heightPx, viewHeightPx: message.viewHeightPx, chromium: message.chromium });
      }
    };
    holder.addEventListener('load', loaded, true);
    window.addEventListener('message', heard);
    tell();
    return () => {
      holder.removeEventListener('load', loaded, true);
      window.removeEventListener('message', heard);
    };
  }, [frameRef]);
  return scroll;
}

function frameOf(frameRef: RefObject<HTMLDivElement>): HTMLIFrameElement | undefined {
  const frame = frameRef.current?.querySelector('iframe');
  return frame ?? undefined;
}

// The page's origin, so a message reaches that page only; '*' for a frame whose address has no origin of its own.
function frameOrigin(frameRef: RefObject<HTMLDivElement>): string {
  const source = frameOf(frameRef)?.src ?? '';
  try {
    const origin = new URL(source, window.location.href).origin;
    return origin === 'null' ? '*' : origin;
  } catch {
    return '*';
  }
}
