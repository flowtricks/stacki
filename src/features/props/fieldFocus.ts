// Where a Settings field's caret was when its purple dot was pressed, and how a
// picked chip lands because of it (BindHandle in BindingEditors.tsx).
//
// The dot means two things. Pressed while the field is not being edited, it
// connects the whole field: the chip replaces everything the field held. Pressed
// while the caret is in the field, it inserts data into what is being typed: the
// chip lands at the caret, or over the selection, and the words around it stay.
// The picker takes focus as soon as it opens, so the answer has to be read
// before then: on pointerdown on the dot, before the field blurs.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

/** A selection in a plain text control, as offsets into its value; collapsed when start equals end. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export type FieldFocus =
  /** The field was not being edited: a pick replaces its whole value. */
  | { readonly kind: 'unfocused' }
  /** The caret was in the field: a pick lands at it. A plain text control's
   * selection is carried here, since its own selection can be reset once the
   * picker takes focus; a rich field keeps its caret itself. */
  | { readonly kind: 'focused'; readonly textRange: TextRange | undefined };

export const FIELD_UNFOCUSED: FieldFocus = { kind: 'unfocused' };

// The box a dot belongs to: an attribute row's value, or a whole Settings field.
// The nearer one wins, so focus in another attribute row of the same section is
// not this field's focus.
const FIELD_SELECTOR = '.attr-value-field, .props-field';

/** The field the dot sits in, which is what "focused" is measured against. */
export function fieldOfHandle(handle: Element): Element | undefined {
  return handle.closest(FIELD_SELECTOR) ?? undefined;
}

/** Whether the caret is in `field` now, read on pointerdown on its dot. */
export function fieldFocusOf(field: Element | undefined, active: Element | undefined): FieldFocus {
  if (field === undefined || active === undefined) {
    return FIELD_UNFOCUSED;
  }
  if (!field.contains(active)) {
    return FIELD_UNFOCUSED;
  }
  if (!editable(active)) {
    // A button or the dot itself holding focus is not a caret.
    return FIELD_UNFOCUSED;
  }
  return { kind: 'focused', textRange: textRangeOf(active) };
}

/** The words of a plain text field with `chip` written into them: over the whole
 * value when the field was not focused, at the caret or over the selection when it was. */
export function textWithChip(value: string, focus: FieldFocus, chip: string): { readonly before: string; readonly after: string } {
  assert(value.length <= LIMITS.nodeValueCharsMax, 'textWithChip: the value is inside its bound');
  assert(chip.length > 0, 'textWithChip: a chip has words');
  switch (focus.kind) {
    case 'unfocused':
      return { before: '', after: '' };
    case 'focused': {
      const range = focus.textRange ?? { start: value.length, end: value.length };
      const start = Math.min(Math.max(range.start, 0), value.length);
      const end = Math.min(Math.max(range.end, start), value.length);
      const out = { before: value.slice(0, start), after: value.slice(end) };
      assert(out.before.length + out.after.length <= value.length, 'textWithChip: the chip only ever takes words away');
      return out;
    }
    default: {
      const exhaustive: never = focus;
      return exhaustive;
    }
  }
}

/** A chip put into a rich field over `saved` (the caret it last had) or at its
 * end, the selection replaced, the caret left after the chip. Plain DOM range
 * work rather than execCommand, so a selection is replaced the same way in
 * every engine, and the field emits what it now holds once. */
export function insertAtRange(host: HTMLElement, saved: Range | undefined, chip: Node): void {
  const range = host.ownerDocument.createRange();
  if (saved !== undefined && host.contains(saved.commonAncestorContainer)) {
    range.setStart(saved.startContainer, saved.startOffset);
    range.setEnd(saved.endContainer, saved.endOffset);
  } else {
    range.selectNodeContents(host);
    range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(chip);
  assert(host.contains(chip), 'insertAtRange: the chip lands inside the field');
  const selection = host.ownerDocument.defaultView?.getSelection();
  if (selection) {
    const caret = host.ownerDocument.createRange();
    caret.setStartAfter(chip);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  }
}

function editable(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return false;
  }
  if (element instanceof view.HTMLTextAreaElement || element instanceof view.HTMLInputElement) {
    return true;
  }
  // Read from the attribute rather than isContentEditable, which not every DOM implements.
  const host = element.closest('[contenteditable]');
  return host !== null && host.getAttribute('contenteditable') !== 'false';
}

function textRangeOf(element: Element): TextRange | undefined {
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return undefined;
  }
  if (element instanceof view.HTMLTextAreaElement || element instanceof view.HTMLInputElement) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (start === null || end === null) {
      return undefined;
    }
    return { start, end };
  }
  return undefined;
}
