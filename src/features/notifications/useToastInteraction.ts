import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject, PointerEvent } from 'react';

export const TOAST_DURATION_MS = 5000;
export const TOAST_EXIT_MS = 180;
const DRAG_DISMISS_PX = 72;
const DRAG_LOCK_PX = 6;
type Drag = {
  readonly pointer: number;
  readonly startX: number;
};

export function useToastInteraction({ paused }: { readonly paused: boolean }, dismiss: () => void) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const interaction = useToastDrag({ leaving }, () => setLeaving(true));
  useToastTimer({ leaving, paused: paused || hovered || focused || interaction.dragging }, dismiss, () => setLeaving(true));
  return {
    ...interaction,
    leaving,
    dismiss: () => setLeaving(true),
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
}

function useToastDrag({ leaving }: { readonly leaving: boolean }, dismiss: () => void) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<Drag>();
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) {
      return;
    }
    const x = event.clientX - current.startX;
    const next = { x: Math.abs(x) >= DRAG_LOCK_PX ? x : 0, y: 0 };
    setOffset(next);
    if (Math.abs(next.x) >= DRAG_DISMISS_PX) {
      toastDragFinish(drag, event);
      dismiss();
    }
  };
  return {
    offset,
    dragging: drag.current !== undefined,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (leaving) {
        return;
      }
      if (drag.current !== undefined) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      if (!event.isPrimary) {
        return;
      }
      if (event.target instanceof Element) {
        if (event.target.closest('button, a')) {
          return;
        }
      }
      drag.current = {
        pointer: event.pointerId,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setOffset({ x: 0, y: 0 });
    },
    onPointerMove: move,
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      move(event);
      if (drag.current?.pointer === event.pointerId) {
        toastDragFinish(drag, event);
        setOffset({ x: 0, y: 0 });
      }
    },
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.pointer === event.pointerId) {
        toastDragFinish(drag, event);
        setOffset({ x: 0, y: 0 });
      }
    },
  };
}

function toastDragFinish(dragRef: MutableRefObject<Drag | undefined>, event: PointerEvent<HTMLDivElement>) {
  // Clear ownership before releasing capture so its loss cannot reset the exit position.
  dragRef.current = undefined;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
}

function useToastTimer({ leaving, paused }: { readonly leaving: boolean; readonly paused: boolean }, dismiss: () => void, expire: () => void) {
  const latestExpire = useRef(expire);
  latestExpire.current = expire;
  const remaining = useRef(TOAST_DURATION_MS);
  const latestDismiss = useRef(dismiss);
  latestDismiss.current = dismiss;
  useEffect(() => {
    if (leaving) {
      const timer = setTimeout(() => latestDismiss.current(), TOAST_EXIT_MS);
      return () => clearTimeout(timer);
    }
    if (paused) {
      return undefined;
    }
    const started = performance.now();
    const timer = setTimeout(() => latestExpire.current(), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
    };
  }, [leaving, paused]);
}
