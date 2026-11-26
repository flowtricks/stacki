// A press on the component canvas. The canvas page's boxes (its frames and the groups around them) hold nothing that can
// be dragged: a component there is selected, never moved. So a press on one is a click however far the pointer drifts
// before it lifts. Without this, a hand that moved six pixels made the press a drag: the click was dropped (the click
// guard, frameInteraction.ts) and a move of the selected page's element was tried and refused (frameDrag.ts), which
// left the box marked and the selection where it was, so selecting a component took a second, stiller click. While the
// canvas pans (Space or the middle button), a moving press is the pan's, as anywhere.
const BOX_SELECTOR = 'stacki-frame, stacki-group';
// Set by the canvas page's own script for as long as a pan lasts (canvasChrome.ts).
const PANNING_ATTRIBUTE = 'data-stacki-panning';

// What the rule asks of a press's target: an element's `closest`, or a text node's element. The platform answers null
// for "none", read here as undefined.
interface Pressed {
  readonly closest?: (selector: string) => unknown;
  readonly parentElement?: unknown;
}

/** Whether the press began on a box of the component canvas page. */
export function pressedCanvasBox(target: unknown): boolean {
  const pressed = asPressed(target);
  // A press on text names the text node; its element is what has ancestors to ask.
  const from = typeof pressed?.closest === 'function' ? pressed : asPressed(pressed?.parentElement);
  const box = from?.closest?.(BOX_SELECTOR) ?? undefined;
  return box !== undefined;
}

function asPressed(value: unknown): Pressed | undefined {
  return typeof value === 'object' ? (value ?? undefined) : undefined;
}

/** Whether a press that began on a canvas box is still a click though the pointer has moved. */
export function canvasPressStaysClick(pressed: { readonly onBox: boolean }, root: { readonly hasAttribute: (name: string) => boolean }): boolean {
  return pressed.onBox && !root.hasAttribute(PANNING_ATTRIBUTE);
}
