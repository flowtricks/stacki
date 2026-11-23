// Enter commits a text field without throwing you out of it.
//
// Value fields write on blur (one commit path, whether you tab away, click
// elsewhere or press Enter), and Enter used to reach it by blurring: the value
// was saved and nothing was focused, so the arrow keys had nothing to nudge and
// the next edit took a click. Typing a value and adjusting it are one thought.
//
// So the blur still happens, because it is what writes, and the field is handed
// straight back with its caret. The Style panel and the Props panel share this
// one implementation.

/** Run a field's blur-commit and return focus (and the caret) to it. */
export function commitInPlace(element: HTMLInputElement | HTMLTextAreaElement): void {
  const { selectionStart, selectionEnd } = element;
  element.blur();
  element.focus();
  // After focus, because a field that selects its text on focus would otherwise
  // undo this.
  // The platform reports "no selection" as null (a number or colour field).
  if (selectionStart !== null && selectionEnd !== null) {
    try {
      element.setSelectionRange(selectionStart, selectionEnd);
    } catch {
      /* a field whose type has no selection (number, colour) — nothing to put back */
    }
  }
}

/** The same for a contentEditable field: blur writes, focus returns, the selection is put back. */
export function commitEditableInPlace(element: HTMLElement): void {
  const selection = element.ownerDocument.getSelection();
  const kept =
    selection !== null && selection.rangeCount > 0 && element.contains(selection.getRangeAt(0).endContainer) ? selection.getRangeAt(0).cloneRange() : undefined;
  element.blur();
  element.focus();
  // After focus, which may have moved the caret; a re-render may also have replaced the nodes the range pointed at.
  if (kept !== undefined && selection !== null && element.contains(kept.endContainer)) {
    selection.removeAllRanges();
    selection.addRange(kept);
  }
}
