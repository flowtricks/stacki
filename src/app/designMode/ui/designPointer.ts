// Pointer capture that never throws: a pointer already gone (lifted between the press and this call) has nothing to capture.

export function capturePointer(element: Element | undefined, pointerId: number): void {
  try {
    element?.setPointerCapture(pointerId);
  } catch {
    // No active pointer: the gesture goes on with the events the element hears itself.
  }
}

/** A CSS value as the inspector shows it: lengths rounded to two decimals, so `437.914062px` reads `437.91px`. */
export function roundedCss(value: string): string {
  return value.replace(/(-?\d+\.\d{3,})(?=px|em|rem|%|\b)/g, (number) => String(Math.round(Number(number) * 100) / 100));
}
