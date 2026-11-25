import { useEffect, useLayoutEffect, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { assert } from '../../shared/core/assert';

// The sliding pill behind the selected segment of a segmented bar or tab row: one
// indicator that moves and resizes to the active button, instead of a background on
// each button taking its turn. The Style panel's SegmentedControl and the insert
// palette's tabs share it, so both measure, observe and animate the same way.

/** Where the indicator sits inside its track, in CSS pixels from the track's padding edge. */
export interface SegmentBox {
  readonly x: number;
  readonly width: number;
}

/** A bar holds a handful of segments; more is a caller bug, not a layout to measure. */
const segmentsMax = 64;

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

/**
 * The indicator's box for one button. Layout offsets (offsetLeft/Width), not
 * getBoundingClientRect: under a CSS `zoom` ancestor a rect comes back in scaled
 * coordinates while the inline px the indicator is given are re-zoomed, which
 * double-scales it. Offsets are zoom-independent.
 */
export function measureSegmentIndicator(button: HTMLElement): SegmentBox {
  const box = { x: button.offsetLeft, width: button.offsetWidth };
  assert(Number.isFinite(box.x), 'segmentIndicator: offset is finite');
  assert(box.width >= 0, 'segmentIndicator: width is not negative');
  return box;
}

/** Whether the person asked the system for less motion. Absent `matchMedia` (jsdom) reads as no preference. */
export function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(reducedMotionQuery).matches;
}

/** The inline style that parks the indicator on its box, or hides it when nothing is selected. */
export function segmentIndicatorStyle(box: SegmentBox | undefined): { readonly transform?: string; readonly width?: string; readonly opacity?: number } {
  if (box === undefined) {
    return { opacity: 0 };
  }
  return { transform: `translateX(${box.x}px)`, width: `${box.width}px` };
}

interface SegmentIndicatorInput {
  readonly trackRef: RefObject<HTMLElement>;
  readonly buttonsRef: MutableRefObject<Array<HTMLButtonElement | undefined>>;
  /** -1 when nothing is selected; the indicator then hides. */
  readonly selectedIndex: number;
  /** Anything else that moves the buttons (their count, a width mode); a change re-measures. */
  readonly layoutKey: string;
}

/**
 * Measures the active button and parks the indicator over it. Re-runs on selection
 * change and observes both the track and the button, so it keeps up with layout
 * shifts (container resize, font load, label change). `animated` turns on only
 * after the first placement, so the indicator doesn't fly in from the origin on
 * mount, and stays off for reduced motion.
 */
export function useSegmentIndicator({ trackRef, buttonsRef, selectedIndex, layoutKey }: SegmentIndicatorInput): {
  readonly indicator: SegmentBox | undefined;
  readonly animated: boolean;
} {
  assert(selectedIndex >= -1, 'segmentIndicator: selected index is -1 or a position');
  assert(selectedIndex < segmentsMax, 'segmentIndicator: selected index is under the segment limit');
  const [indicator, setIndicator] = useState<SegmentBox | undefined>(undefined);
  const [animated, setAnimated] = useState(false);
  useLayoutEffect(() => {
    const track = trackRef.current;
    const button = selectedIndex >= 0 ? buttonsRef.current[selectedIndex] : undefined;
    if (!track || !button) {
      setIndicator(undefined);
      return;
    }
    const measure = () => setIndicator(measureSegmentIndicator(button));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    observer.observe(button);
    return () => observer.disconnect();
  }, [trackRef, buttonsRef, selectedIndex, layoutKey]);

  useEffect(() => {
    if (prefersReducedMotion()) {
      return;
    }
    if (typeof window.requestAnimationFrame !== 'function') {
      setAnimated(true);
      return;
    }
    const id = window.requestAnimationFrame(() => setAnimated(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  return { indicator, animated };
}
