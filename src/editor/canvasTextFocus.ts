// Whether text on the canvas is being edited, as the canvas last said
// (avb:text-active / avb:text-inactive). The canvas is another document, so
// while its text has focus the app sees only the frame element focused, and
// the menu's Copy, Cut and Paste, which run in the app, took ⌘V for "paste the
// copied element" and the text never got it. The app's editable check reads
// this to hand those to the focused frame instead.

let editing = false;

/** The canvas said its text editor opened (`active`) or closed (`inactive`). */
export function noteCanvasTextEditing(state: 'active' | 'inactive'): void {
  editing = state === 'active';
}

/** Whether canvas text is being edited and the canvas frame holds the app's focus. */
export function canvasTextHasFocus(): boolean {
  if (!editing) {
    return false;
  }
  const active = typeof document === 'undefined' ? undefined : document.activeElement;
  return active instanceof HTMLIFrameElement;
}
