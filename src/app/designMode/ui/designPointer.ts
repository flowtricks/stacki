// Pointer capture that never throws: a pointer already gone (lifted between the press and this call) has nothing to capture.

export function capturePointer(element: Element | undefined, pointerId: number): void {
  try {
    element?.setPointerCapture(pointerId);
  } catch {
    // No active pointer: the gesture goes on with the events the element hears itself.
  }
}

/**
 * Puts a clipped box back at its origin. The design canvas never scrolls (the view pans by transform), but the
 * browser scrolls a clipped box to reveal what takes focus inside it, and the pointer arithmetic would then be off.
 */
export function keepUnscrolled(element: HTMLElement | undefined): void {
  if (element !== undefined && (element.scrollLeft !== 0 || element.scrollTop !== 0)) {
    element.scrollTo({ left: 0, top: 0 });
  }
}

/**
 * Gives the keyboard back to the design canvas. Typing in a frame puts focus inside its document, where the
 * canvas's shortcuts are not heard; a frame title or the end of an edit takes it back.
 */
export function focusDesignCanvas(): void {
  const canvas = document.querySelector('.dm-canvas');
  if (canvas instanceof HTMLElement) {
    canvas.focus({ preventScroll: true });
  }
}

/** A CSS value as the inspector shows it: lengths rounded to two decimals, so `437.914062px` reads `437.91px`. */
export function roundedCss(value: string): string {
  return value.replace(/(-?\d+\.\d{3,})(?=px|em|rem|%|\b)/g, (number) => String(Math.round(Number(number) * 100) / 100));
}
