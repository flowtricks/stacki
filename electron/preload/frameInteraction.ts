import type { CanvasInteraction } from '../../shared/properties/canvasInteraction';

let canvas = location.hash.includes('avb-design');
let mode: CanvasInteraction = 'select';
let gesture: { readonly x: number; readonly y: number; dragged: boolean } | undefined;
const DRAG_DISTANCE_PX = 6;

export function canvasSelects(): boolean {
  return canvas && mode === 'select';
}

export function trackCanvas(): void {
  canvas = true;
}

export function setCanvasInteraction(next: CanvasInteraction): void {
  canvas = true;
  mode = next;
  gesture = undefined;
  const style = document.getElementById('avb-design-style');
  if (style instanceof HTMLStyleElement) {
    style.disabled = !canvasSelects();
  }
}

export function canvasDragged(): boolean {
  return gesture?.dragged ?? false;
}

export function trackCanvasGesture(): void {
  // Observe, never cancel, pointer events: slider libraries must receive their drag stream.
  window.addEventListener(
    'pointerdown',
    (event) => {
      gesture = event.button === 0 ? { x: event.clientX, y: event.clientY, dragged: false } : undefined;
    },
    true,
  );
  window.addEventListener(
    'pointermove',
    (event) => {
      if (gesture) {
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= DRAG_DISTANCE_PX) {
          gesture.dragged = true;
        }
      }
    },
    true,
  );
  window.addEventListener(
    'pointercancel',
    () => {
      gesture = undefined;
    },
    true,
  );
}
