// Enter commits a value field without throwing you out of it.
//
// These fields write on blur — one commit path, whether you tab away, click
// elsewhere or press Enter — and Enter used to reach it by blurring. That works,
// and then the field is gone: pressing Enter after typing `20rem` left nothing
// focused, so the arrow keys that nudge a value by 1 (or 0.1, or 10) had nothing
// to nudge. Typing a value and adjusting it are the same thought, and the field
// should still be there for the second half of it.
//
// So the blur still happens — it is what writes, and rewriting twenty fields'
// commit paths to avoid it would be a worse trade — and the field is handed
// straight back, caret where it was.

/** Run a field's blur-commit and return focus (and the caret) to it. */
export function commitInPlace(el: HTMLInputElement | HTMLTextAreaElement): void {
  const { selectionStart, selectionEnd } = el
  el.blur()
  el.focus()
  // After focus, because a field that selects its text on focus would otherwise
  // undo this.
  if (selectionStart != null && selectionEnd != null) {
    try {
      el.setSelectionRange(selectionStart, selectionEnd)
    } catch {
      /* a field whose type has no selection (number, colour) — nothing to put back */
    }
  }
}
