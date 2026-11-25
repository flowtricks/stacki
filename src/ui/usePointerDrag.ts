import { useCallback, useEffect, useRef } from 'react';

interface DragOptions {
  readonly onMove: (event: PointerEvent) => void;
  readonly onEnd?: (event?: Event) => void;
  readonly cursor?: string;
}
interface DragStart {
  readonly pointerId?: number;
}

// One session owns the listeners and one animation frame. Starting another drag
// releases the previous one before applying its cursor or scheduling more work.
export function usePointerDrag() {
  const stopRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopRef.current?.(), []);
  return useCallback((event: DragStart, options: DragOptions): void => {
    stopRef.current?.();
    stopRef.current = startPointerDrag(event, options, () => {
      stopRef.current = undefined;
    });
  }, []);
}

function startPointerDrag(event: DragStart, options: DragOptions, release: () => void): () => void {
  const previousCursor = document.body.style.cursor;
  if (options.cursor) {
    document.body.style.cursor = options.cursor;
  }
  let frame: number | undefined;
  let latest: PointerEvent | undefined;
  // A platform event may carry a null pointerId; either side missing one matches anything.
  const matches = (next: Event): boolean =>
    !('pointerId' in next) || next.pointerId === undefined || next.pointerId === null || event.pointerId === undefined || next.pointerId === event.pointerId;
  const apply = (): void => {
    frame = undefined;
    if (!latest) {
      return;
    }
    const next = latest;
    latest = undefined;
    options.onMove(next);
  };
  const move = (next: PointerEvent): void => {
    if (!matches(next)) {
      return;
    }
    latest = next;
    if (frame === undefined) {
      frame = requestAnimationFrame(apply);
    }
  };
  const stop = (next?: Event): void => {
    if (next && !matches(next)) {
      return;
    }
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
    apply();
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', stop);
    window.removeEventListener('blur', stop);
    if (options.cursor) {
      document.body.style.cursor = previousCursor;
    }
    release();
    options.onEnd?.(next);
  };
  const up = (next: PointerEvent): void => {
    if (!matches(next)) {
      return;
    }
    latest = next;
    stop(next);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
  return stop;
}
