import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { assert } from '../../shared/core/assert';
import {
  clampFloatingOffset,
  FLOATING_CLICK_SLOP_PX,
  FLOATING_DRAG_HANDLE_ATTRIBUTE,
  FLOATING_DRAG_IGNORE_SELECTOR,
  FLOATING_OFFSET_NONE,
  type FloatingOffset,
} from './floatingDrag';
import { usePointerDrag } from './usePointerDrag';

// Moves a floating editor by its header. The editor keeps the placement its own
// CSS gives it; the drag adds an offset, held here, so the position lasts while the
// editor stays open and resets when it is opened again. The offset is applied as
// margins: the editor's centring is a `translate` and its open motion a
// `transform`, and a margin moves a fixed box without touching either.
export function useFloatingDrag() {
  const [offset, setOffset] = useState<FloatingOffset>(FLOATING_OFFSET_NONE);
  const startPointer = usePointerDrag();
  const surface = useRef<HTMLElement | undefined>(undefined);
  // Whether the latest press on the handle went far enough to be a drag (FLOATING_CLICK_SLOP_PX).
  const dragged = useRef(false);
  useEffect(() => {
    // A smaller window must not leave a moved editor hanging past its edge.
    const refit = (): void => {
      const element = surface.current;
      if (element?.isConnected) {
        setOffset((current) => clampFloatingOffset(element.getBoundingClientRect(), current, current, viewportSize()));
      }
    };
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, []);
  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }
    const handle = event.target.closest(`[${FLOATING_DRAG_HANDLE_ATTRIBUTE}]`);
    if (!handle) {
      return;
    }
    // A control in the header keeps its press; a handle that is itself a button (a header that toggles) still drags.
    const control = event.target.closest(FLOATING_DRAG_IGNORE_SELECTOR);
    if (control !== null && control !== handle) {
      return;
    }
    const element = event.currentTarget;
    assert(element.contains(event.target), 'A floating drag starts inside its own surface');
    event.preventDefault();
    surface.current = element;
    const box = element.getBoundingClientRect();
    const origin = { x: event.clientX, y: event.clientY };
    const start = offset;
    dragged.current = false;
    startPointer(event, {
      cursor: 'move',
      onMove: (next) => {
        // A press that wobbles is a click: nothing moves until the pointer has gone past the slop.
        dragged.current ||= Math.hypot(next.clientX - origin.x, next.clientY - origin.y) > FLOATING_CLICK_SLOP_PX;
        if (!dragged.current) {
          return;
        }
        const desired = { x: start.x + next.clientX - origin.x, y: start.y + next.clientY - origin.y };
        setOffset(clampFloatingOffset(box, start, desired, viewportSize()));
      },
    });
  };
  // For a handle that is also a button: whether this click only ends a drag. A keyboard's click (no pointer, so no
  // click count) never does.
  const endedDrag = (event: { readonly detail: number }): boolean => event.detail !== 0 && dragged.current;
  return { offset, onPointerDown, endedDrag };
}

function viewportSize(): { readonly width: number; readonly height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}
