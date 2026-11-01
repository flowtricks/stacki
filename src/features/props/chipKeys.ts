import { assert } from '../../../shared/core/assert';
// Backspace or Delete beside a chip should take the chip — one press, the
// whole thing, and nothing either side of it.
//
// Left to the browser this is unreliable: a `contenteditable=false` element
// with no text node next to it leaves the caret at an element-level position,
// and from there Chromium's own delete heuristics can take the whole field
// with them. So the one case that matters is handled here, and everything else
// (deleting characters, deleting a real selection) is left alone.

const isChip = (node: Node | undefined): node is Element => {
  // Use the node's realm so iframe nodes and DOM test documents narrow correctly.
  const ElementType = node?.ownerDocument?.defaultView?.Element;
  return ElementType !== undefined && node instanceof ElementType && node.classList.contains('expr-chip');
};

// The chip the caret is sitting against, on the side it is about to delete
// towards: -1 for Backspace, 1 for Delete. Undefined when the caret is inside text,
// where an ordinary character delete is what was meant.
function chipBesideCaret(host: HTMLElement, directory: -1 | 1): Element | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !host.contains(range.startContainer)) {
    return undefined;
  }
  const node = range.startContainer;
  const offset = range.startOffset;
  if (node.nodeType === 3) {
    // Only from the very edge of the text: anywhere else there is a character
    // to remove, which is what the key is for.
    if (directory < 0 ? offset > 0 : offset < (node.nodeValue?.length ?? 0)) {
      return undefined;
    }
    const sibling = (directory < 0 ? node.previousSibling : node.nextSibling) ?? undefined;
    return isChip(sibling) ? sibling : undefined;
  }
  const child = directory < 0 ? node.childNodes[offset - 1] : node.childNodes[offset];
  return isChip(child) ? child : undefined;
}

/**
 * Handles Backspace/Delete against a chip inside `host`. Returns true when it
 * took one — the caller should then prevent the event and emit, since the DOM
 * has changed without the browser's own editing having run.
 */
export function deleteChipAtCaret(host: HTMLElement | undefined, event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  if (!host) {
    return false;
  }
  if (event.key !== 'Backspace' && event.key !== 'Delete') {
    return false;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  const chip = chipBesideCaret(host, event.key === 'Backspace' ? -1 : 1);
  if (!chip) {
    return false;
  }
  // Put the caret where the chip was, so typing carries on from that spot
  // rather than jumping to an end of the field.
  const parent = chip.parentNode;
  assert(parent !== null, 'Chip must remain attached to its editable host');
  const at = Array.from(parent.childNodes).indexOf(chip);
  assert(at >= 0, 'Chip must have an index in its parent');
  chip.remove();
  const range = document.createRange();
  range.setStart(parent, Math.min(at, parent.childNodes.length));
  range.collapse(true);
  const selection = window.getSelection();
  if (!selection) {
    return true;
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
