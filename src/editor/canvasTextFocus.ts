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

/** Undo or redo asked of rich text by the menu, which takes the key before any page sees it. */
export type RichHistoryStep = 'undo' | 'redo';

/** The event the rich text dialog's field answers a menu undo or redo with: cancelled when it took the step itself. */
export const RICH_HISTORY_EVENT = 'stacki:rich-history';

// How the open canvas rich text editor is told to step its history.
let canvasStep: ((step: RichHistoryStep) => void) | undefined;

/** The canvas said how its open rich text editor is told to undo and redo; undefined when none is open. */
export function noteCanvasRichHistory(step: ((step: RichHistoryStep) => void) | undefined): void {
  canvasStep = step;
}

/**
 * Hands a menu undo or redo to the rich text editor that has focus. An image, a divider or a list placed whole is in
 * that editor's own history and not in the browser's, so the browser's undo alone would pass it by. False: no rich text
 * editor took it, and the step is whatever it was.
 */
export function stepRichHistory(step: RichHistoryStep): boolean {
  if (canvasStep !== undefined && canvasTextHasFocus()) {
    canvasStep(step);
    return true;
  }
  const field = typeof document === 'undefined' ? undefined : (document.activeElement?.closest('.html-content') ?? undefined);
  // Cancelled by the field when the step was one of its own.
  return field !== undefined && !field.dispatchEvent(new CustomEvent(RICH_HISTORY_EVENT, { cancelable: true, detail: step }));
}
