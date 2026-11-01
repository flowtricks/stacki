import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent } from 'react';
import { TOAST_LIMIT, type ToastNotice } from './useToastStack';

const TOAST_HEIGHT_PX = 58;
const TOAST_GAP_PX = 10;
const TOAST_MORE_PX = 40;
const VIEWPORT_MARGIN_PX = 40;

export function useToastLayout(notices: readonly ToastNotice[]) {
  const [hovered, setHovered] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(collapseTimer.current), []);
  const [focused, setFocused] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const expanded = hovered || focused;
  const measurement = useToastMeasurements(notices);
  const positions = toastPositions(notices, measurement.heights);
  const totalHeight = toastListHeight(positions);
  const overflow = totalHeight > measurement.available;
  const visibleCount = expanded && overflow && !showAll ? toastVisibleCount(positions, measurement.available - TOAST_MORE_PX) : positions.length;
  const height = expanded ? toastListHeight(positions.slice(0, visibleCount)) + (overflow ? TOAST_MORE_PX : 0) : (positions[0]?.height ?? 0);
  useLayoutEffect(() => {
    // Removing a focused dismiss button may not emit blur; do not retain stale focus ownership.
    if (!measurement.ref.current?.contains(document.activeElement)) {
      setFocused(false);
    }
  }, [notices, measurement.ref]);
  useEffect(() => {
    if (!expanded) {
      setShowAll(false);
    }
  }, [expanded]);
  return {
    ref: measurement.ref,
    expanded,
    showAll,
    overflow,
    scrollable: expanded && overflow && (showAll || height > measurement.available),
    height,
    positions,
    visibleCount,
    loadMore: () => setShowAll(true),
    showLess: () => setShowAll(false),
    onMouseEnter: () => {
      clearTimeout(collapseTimer.current);
      setHovered(true);
    },
    onMouseLeave: () => {
      // Keep the list stable while a dismissed card leaves or the pointer crosses its former space.
      clearTimeout(collapseTimer.current);
      collapseTimer.current = setTimeout(() => setHovered(false), 400);
    },
    onFocus: () => setFocused(true),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setFocused(false);
      }
    },
  };
}

function useToastMeasurements(notices: readonly ToastNotice[]) {
  const ref = useRef<HTMLElement>(null);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const [available, setAvailable] = useState(() => Math.max(TOAST_HEIGHT_PX, window.innerHeight - VIEWPORT_MARGIN_PX));
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    const measure = () => {
      const next = new Map<string, number>();
      // Only the bounded, mounted notices contribute to layout or retained measurements.
      for (const slot of Array.from(element.querySelectorAll('.toast-slot')).slice(0, TOAST_LIMIT)) {
        if (slot instanceof HTMLElement) {
          const id = slot.dataset['toastId'];
          if (id !== undefined) {
            const card = slot.firstElementChild;
            if (card instanceof HTMLElement) {
              next.set(id, card.offsetHeight || TOAST_HEIGHT_PX);
            }
          }
        }
      }
      setHeights((previous) => (next.size === previous.size && [...next].every(([id, height]) => previous.get(id) === height) ? previous : next));
      setAvailable(Math.max(TOAST_HEIGHT_PX, window.innerHeight - VIEWPORT_MARGIN_PX));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    for (const card of Array.from(element.querySelectorAll('.toast')).slice(0, TOAST_LIMIT)) {
      observer?.observe(card);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [notices]);
  return { ref, heights, available };
}

interface ToastPosition {
  readonly height: number;
  readonly offset: number;
}

function toastPositions(notices: readonly ToastNotice[], heights: ReadonlyMap<string, number>): readonly ToastPosition[] {
  // This accumulator owns the ordered layout; measured heights keep multiline cards separate.
  let offset = 0;
  return notices.slice(0, TOAST_LIMIT).map((notice) => {
    const height = heights.get(notice.id) ?? TOAST_HEIGHT_PX;
    const position = { height, offset };
    offset += height + TOAST_GAP_PX;
    return position;
  });
}

function toastListHeight(positions: readonly ToastPosition[]): number {
  const last = positions.at(-1);
  return last === undefined ? 0 : last.offset + last.height;
}

function toastVisibleCount(positions: readonly ToastPosition[], available: number): number {
  const count = positions.filter((position) => position.offset + position.height <= available).length;
  return Math.max(1, count);
}
