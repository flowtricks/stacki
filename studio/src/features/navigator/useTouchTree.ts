import { useEffect, type RefObject } from 'react';

// Native Stacki dragging also accepts a held touch in the browser edition.
export function useTouchTree(root: RefObject<HTMLDivElement>) {
  useEffect(() => {
    const element = root.current;
    if (!element) {
      return;
    }
    const { down, move, up, reset } = touchHandlers(element);
    element.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', reset);
    return () => {
      reset();
      element.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', reset);
    };
  }, [root]);
}

function touchHandlers(element: HTMLDivElement) {
  let timer: ReturnType<typeof setTimeout>;
  let source: HTMLElement | undefined;
  let over: Element | null = null;
  let data: DataTransfer | undefined;
  let start = { x: 0, y: 0 };
  const reset = () => {
    clearTimeout(timer);
    element.classList.remove('touch-dragging');
    source?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    source = undefined;
    data = undefined;
    over = null;
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !(event.target instanceof Element)) {
      return;
    }
    source = event.target.closest<HTMLElement>('[draggable="true"]') ?? undefined;
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      if (source) {
        data = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
        element.classList.add('touch-dragging');
      }
    }, 180);
  };
  const move = (event: PointerEvent) => {
    if (!source) {
      return;
    }
    if (!data) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
        reset();
      }
      return;
    }
    event.preventDefault();
    over = document.elementFromPoint(event.clientX, event.clientY);
    over?.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
        clientX: event.clientX,
        clientY: event.clientY,
      }),
    );
  };
  const up = () => {
    if (data) {
      over?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }
    element.classList.remove('touch-dragging');
    reset();
  };
  return { down, move, up, reset };
}
