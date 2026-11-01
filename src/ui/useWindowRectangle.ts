import { useEffect, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { usePointerDrag } from './usePointerDrag';
import { fitWindowRectangle, resizeWindowRectangle, type WindowEdge, type WindowSize } from './windowGeometry';
import { readWindowRectangle, storeWindowRectangle } from './windowPreferences';

// Tool windows and the code editor share geometry, without knowing their dock location.
export function useWindowRectangle(minimum: WindowSize, storageKey?: string) {
  const [dragging, setDragging] = useState(false);
  const [rectangle, setRectangle] = useWindowPlacement(minimum, { storageKey, dragging });
  const startPointer = usePointerDrag();
  const start = (event: PointerEvent<HTMLDivElement>, edge?: WindowEdge): void => {
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    if (event.target instanceof Element && event.target.closest('button, input, select, textarea, a, [contenteditable], [role=button]')) {
      return;
    }
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY };
    setDragging(true);
    startPointer(event, {
      cursor: edge ? `${edge}-resize` : 'move',
      onMove: (next) => {
        const delta = { x: next.clientX - origin.x, y: next.clientY - origin.y };
        setRectangle(
          edge
            ? resizeWindowRectangle(rectangle, edge, delta, viewportSize(), minimum)
            : fitWindowRectangle({ ...rectangle, x: rectangle.x + delta.x, y: rectangle.y + delta.y }, viewportSize(), minimum),
        );
      },
      onEnd: () => setDragging(false),
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, edge?: WindowEdge): void => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const delta = keyDelta(event);
    if (!delta) {
      return;
    }
    event.preventDefault();
    setRectangle((current) =>
      edge
        ? resizeWindowRectangle(current, edge, delta, viewportSize(), minimum)
        : fitWindowRectangle({ ...current, x: current.x + delta.x, y: current.y + delta.y }, viewportSize(), minimum),
    );
  };
  return { rectangle, dragging, start, onKeyDown };
}

function useWindowPlacement(
  minimum: WindowSize,
  {
    storageKey,
    dragging,
  }: {
    readonly storageKey: string | undefined;
    readonly dragging: boolean;
  },
) {
  const [rectangle, setRectangle] = useState(() => readWindowRectangle(storageKey, viewportSize(), minimum));
  const { width, height } = minimum;
  useEffect(() => {
    const fit = (): void => {
      setRectangle((current) => fitWindowRectangle(current, viewportSize(), { width, height }));
    };
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [width, height]);
  useEffect(() => {
    if (!dragging) {
      storeWindowRectangle(storageKey, rectangle);
    }
  }, [storageKey, rectangle, dragging]);
  return [rectangle, setRectangle] as const;
}

function viewportSize(): WindowSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

function keyDelta(event: KeyboardEvent): { readonly x: number; readonly y: number } | undefined {
  const step = event.shiftKey ? 50 : 10;
  switch (event.key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 };
    case 'ArrowRight':
      return { x: step, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -step };
    case 'ArrowDown':
      return { x: 0, y: step };
    default:
      return undefined;
  }
}
