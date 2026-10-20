// Bringing a Feedback pin on screen when the Feedback list asks for it. The
// pin may sit on a page that is still loading, so the request waits until the
// frame showing that page has measured the pin, then scrolls to it once.
import { useEffect, useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import type { CanvasFeedback, PinOverlay, RectMap } from './PreviewOverlays';

export function useFeedbackReveal(
  feedback: CanvasFeedback | undefined,
  rects: RectMap,
  url: string | undefined,
  post: (message: unknown) => void,
): void {
  // The rects held when the frame last changed pages. They name the previous
  // page's nodes, and index paths repeat across pages, so a match among them
  // would scroll to the wrong element; the reload clears them shortly after.
  const reload = useRef<{ readonly url: string | undefined; readonly stale?: RectMap }>({ url });
  if (reload.current.url !== url) {
    reload.current = { url, stale: rects };
  }
  const stale = reload.current.stale;
  const revealId = feedback?.revealId;
  const pins = feedback?.pins;
  const onRevealed = feedback?.onRevealed;
  useEffect(() => {
    if (revealId === undefined || pins === undefined || onRevealed === undefined) {
      return;
    }
    const pin = revealTarget({ revealId, pins, rects, stale });
    if (pin !== undefined) {
      // The frame scrolls only when the element is out of sight.
      post({ type: 'avb:scroll-to', path: pin.path, occ: pin.occurrence });
      onRevealed();
    }
  }, [onRevealed, pins, post, rects, revealId, stale]);
}

/**
 * The pin to scroll to, once it can be: it is on the open page (it has a pin)
 * and the frame showing that page has measured it. Undefined means wait.
 */
export function revealTarget(input: {
  readonly revealId: string;
  readonly pins: readonly PinOverlay[];
  readonly rects: RectMap;
  readonly stale: RectMap | undefined;
}): PinOverlay | undefined {
  const pin = input.pins.find((candidate) => candidate.id === input.revealId);
  if (pin === undefined) {
    return undefined; // Its page has not opened yet.
  }
  assert(pin.id === input.revealId, 'The pin found is the one asked for');
  if (input.rects === input.stale) {
    return undefined; // These rects are the previous page's.
  }
  const measured = input.rects[pin.path];
  if (measured === undefined) {
    return undefined;
  }
  if (measured.length === 0) {
    return undefined;
  }
  return pin;
}
