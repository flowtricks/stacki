// Enter commits a value field without throwing you out of it: see src/ui/commitInPlace.ts,
// which the Props panel shares. A field drawn as a token editor (a contentEditable `div`
// standing over a hidden input, TokenField.tsx) is the one that has the focus in the real
// panel, so Enter lands on it and not on the input; `commitTokenFieldInPlace` is the same
// hand-back for it, with the caret kept as an offset into the field's text.

import { caretOffset, setCaretOffset } from './cssCode';

export { commitInPlace } from '../../../ui/commitInPlace';

/** The same for a token editor: blur writes, focus returns, the caret goes back to its offset. */
export function commitTokenFieldInPlace(element: HTMLElement): void {
  const offset = caretOffset(element);
  element.blur();
  element.focus();
  // After focus, because focusing settles the caret behind a chip-only value.
  if (offset !== undefined) {
    setCaretOffset(element, offset);
  }
}
